import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createCtx, type Ctx } from '../src/context.js';
import { buildApp } from '../src/app.js';
import type { ConsoleSmsAdapter } from '../src/adapters/sms.js';
import type { InlineJobRunner } from '../src/jobs/runner.js';
import type { FakePaymentGateway } from '../src/adapters/payments.js';

export const OPS_PHONE = '+919000000001';
export const INDIRANAGAR = { lat: 12.9719, lng: 77.6412, pincode: '560038' };

export interface TestEnv {
  app: FastifyInstance;
  ctx: Ctx;
  sms: ConsoleSmsAdapter;
  jobs: InlineJobRunner;
  gateway: FakePaymentGateway;
  close(): Promise<void>;
}

export async function setupEnv(): Promise<TestEnv> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://kmdoch:kmdoch@localhost:5432/kmdoch_test',
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
    INLINE_JOBS: 'true',
    STORAGE_LOCAL_DIR: '/tmp/kmdoch-test-storage',
    OPS_ADMIN_PHONES: OPS_PHONE,
    LOG_LEVEL: 'silent',
  });
  const ctx = createCtx(config);
  await ctx.redis.flushdb();
  const app = await buildApp(ctx);
  await app.ready();
  return {
    app,
    ctx,
    sms: ctx.adapters.sms as ConsoleSmsAdapter,
    jobs: ctx.jobs as InlineJobRunner,
    gateway: ctx.adapters.payments as FakePaymentGateway,
    async close() {
      await app.close();
      await ctx.db.end();
      ctx.redis.disconnect();
    },
  };
}

export const randomPhone = () => `+919${String(randomInt(0, 999_999_999)).padStart(9, '0')}`;
const randomIp = () => `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;

export async function call(env: TestEnv, method: InjectOptions['method'], url: string, opts: { token?: string; body?: unknown; idem?: string | true; ip?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idem) headers['idempotency-key'] = opts.idem === true ? randomUUID() : opts.idem;
  const res = await env.app.inject({ method, url: `/v1${url}`, headers, payload: opts.body as any, remoteAddress: opts.ip ?? randomIp() });
  return { status: res.statusCode, body: res.body ? safeJson(res.body) : null, headers: res.headers };
}

const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** The ops phone is shared across tests, so reset its OTP send window first. */
export async function opsLogin(env: TestEnv) {
  await env.ctx.db.query('DELETE FROM otp_challenges WHERE phone_e164=$1', [OPS_PHONE]);
  return login(env, 'ops', {}, OPS_PHONE);
}

export async function login(env: TestEnv, appRole: 'patient' | 'provider' | 'partner' | 'ops', extra: Record<string, unknown> = {}, phone = randomPhone()) {
  const r1 = await call(env, 'POST', '/auth/otp/request', { body: { phone, app_role: appRole, ...extra } });
  if (r1.status !== 200) throw new Error(`otp request failed ${r1.status} ${JSON.stringify(r1.body)}`);
  const code = env.sms.lastOtp.get(phone)!;
  const r2 = await call(env, 'POST', '/auth/otp/verify', {
    body: { challenge_id: r1.body.challenge_id, phone, code, device: { id: `dev-${randomUUID()}`, platform: 'android', push_token: `push-${phone}` }, name: `User ${phone.slice(-4)}` },
  });
  if (r2.status !== 200) throw new Error(`otp verify failed ${r2.status} ${JSON.stringify(r2.body)}`);
  return { token: r2.body.access_token as string, refresh: r2.body.refresh_token as string, userId: r2.body.user.id as string, providerId: r2.body.provider_id as string | null, phone };
}

export async function patient(env: TestEnv) {
  const p = await login(env, 'patient');
  const me = await call(env, 'GET', '/me', { token: p.token });
  const patientId = me.body.patient.id as string;
  const addr = await call(env, 'POST', '/addresses', {
    token: p.token,
    body: { patient_id: patientId, label: 'Home', line1: '12, 3rd Cross, HAL 2nd Stage', landmark: 'Near park', pincode: INDIRANAGAR.pincode, lat: INDIRANAGAR.lat, lng: INDIRANAGAR.lng, gate_code: '#4521', floor: '2', lift: true },
  });
  return { ...p, patientId, addressId: addr.body.id as string };
}

let regCounter = 0;
/** A verified, on-duty provider near the Indiranagar test address. */
export async function readyProvider(env: TestEnv, role: string, opts: { lat?: number; lng?: number; languages?: string[]; onDuty?: boolean; acceptTerms?: boolean } = {}) {
  const reg = `KMC-${Date.now()}-${++regCounter}`;
  const p = await login(env, 'provider', { provider_role: role, reg_number: reg });
  const zones = await env.ctx.db.query(`SELECT id FROM service_zones WHERE name='Indiranagar'`);
  await env.ctx.db.query(`UPDATE providers SET verification_status='verified', service_area_zone_ids=$2, languages=$3, qualifications=$4, years_experience=11 WHERE id=$1`, [
    p.providerId,
    [zones.rows[0].id],
    opts.languages ?? ['English', 'Tamil'],
    role === 'doctor' ? ['MBBS'] : [],
  ]);
  if (opts.acceptTerms !== false) {
    const t = await call(env, 'GET', '/provider/terms/current', { token: p.token });
    await call(env, 'POST', '/provider/terms/accept', { token: p.token, body: { version: t.body.version } });
  }
  await call(env, 'POST', '/provider/location-consent', { token: p.token, body: { granted: true } });
  if (opts.onDuty !== false) {
    const d = await call(env, 'POST', '/provider/duty', { token: p.token, body: { on: true } });
    if (d.status !== 200) throw new Error(`duty failed ${JSON.stringify(d.body)}`);
    await call(env, 'POST', '/provider/location', {
      token: p.token,
      body: { pings: [{ lat: opts.lat ?? 12.9784, lng: opts.lng ?? 77.6408, recorded_at: new Date().toISOString() }] },
    });
  }
  return { ...p, providerId: p.providerId!, reg };
}

export async function consentsFor(env: TestEnv, service: string) {
  const r = await call(env, 'GET', `/consent-templates?service=${service}`);
  return (r.body.templates as any[]).map((t) => ({ template_key: t.key, version: t.version }));
}

export async function quote(env: TestEnv, token: string, service_code: string, options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const r = await call(env, 'POST', '/quotes', { token, body: { service_code, options, ...extra } });
  if (r.status !== 200) throw new Error(`quote failed ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function book(env: TestEnv, pt: Awaited<ReturnType<typeof patient>>, service: string, options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const q = await quote(env, pt.token, service, options);
  return call(env, 'POST', '/service-requests', {
    token: pt.token,
    idem: true,
    body: { quote_token: q.quote_token, patient_id: pt.patientId, address_id: pt.addressId, symptoms: ['fever'], consents: await consentsFor(env, service), ...extra },
  });
}

/** Recursively collect all keys in an object. */
export function allKeys(v: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, acc));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (acc.add(k), allKeys(x, acc));
  return acc;
}
