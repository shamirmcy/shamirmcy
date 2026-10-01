import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, maybeOne, one, tx } from '../../lib/db.js';
import { REMOTE_ROLES, type ProviderRole } from './roles.js';

export async function loadProvider(ctx: Ctx, providerId: string) {
  const p = await maybeOne(ctx.db, 'SELECT p.*, u.name, u.phone_e164 FROM providers p JOIN users u ON u.id=p.user_id WHERE p.id=$1', [providerId]);
  if (!p) throw new AppError('NOT_FOUND', 'Provider not found');
  return p;
}

export async function currentTerms(ctx: Ctx, role: string) {
  return maybeOne(ctx.db, 'SELECT role, version, items FROM provider_terms WHERE role=$1 ORDER BY version DESC LIMIT 1', [role]);
}

export async function hasAcceptedCurrentTerms(ctx: Ctx, providerId: string, role: string) {
  const t = await currentTerms(ctx, role);
  if (!t) return false;
  const a = await maybeOne(ctx.db, 'SELECT 1 FROM provider_terms_acceptances WHERE provider_id=$1 AND role=$2 AND version=$3', [providerId, role, t.version]);
  return Boolean(a);
}

export async function acceptTerms(ctx: Ctx, providerId: string, version: number, device: string | null, ip: string) {
  const p = await loadProvider(ctx, providerId);
  const t = await currentTerms(ctx, p.role);
  if (!t || t.version !== version) throw new AppError('VALIDATION_ERROR', 'Only the current terms version can be accepted', { current_version: t?.version ?? null });
  await ctx.db.query(
    `INSERT INTO provider_terms_acceptances (provider_id, role, version, device, ip) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [providerId, p.role, version, device, ip],
  );
  return { role: p.role, version, accepted: true };
}

export async function setLocationConsent(ctx: Ctx, providerId: string, granted: boolean) {
  await ctx.db.query(
    `INSERT INTO provider_sessions (provider_id, location_consent_at) VALUES ($1, CASE WHEN $2 THEN now() END)
     ON CONFLICT (provider_id) DO UPDATE SET location_consent_at = CASE WHEN $2 THEN now() END,
       on_duty = CASE WHEN $2 THEN provider_sessions.on_duty ELSE false END,
       last_location = CASE WHEN $2 THEN provider_sessions.last_location END,
       last_location_at = CASE WHEN $2 THEN provider_sessions.last_location_at END, updated_at=now()`,
    [providerId, granted],
  );
  if (!granted) await ctx.redis.del(`prov:loc:${providerId}`);
  return { location_consent: granted };
}

/**
 * Go on / off duty. On duty requires: verified, current practice terms accepted, and (for
 * in-person roles) location consent. Going off duty stops collection and wipes the last position.
 */
export async function setDuty(ctx: Ctx, providerId: string, on: boolean) {
  const p = await loadProvider(ctx, providerId);
  if (on) {
    if (p.verification_status !== 'verified') throw new AppError('PROVIDER_NOT_VERIFIED', 'Your registration is being verified');
    if (!(await hasAcceptedCurrentTerms(ctx, providerId, p.role))) throw new AppError('TERMS_REQUIRED', 'Accept the current practice terms to go on duty');
    const s = await maybeOne(ctx.db, 'SELECT location_consent_at FROM provider_sessions WHERE provider_id=$1', [providerId]);
    if (!REMOTE_ROLES.includes(p.role as ProviderRole) && !s?.location_consent_at) {
      throw new AppError('LOCATION_CONSENT_REQUIRED', 'Allow location while on duty to receive nearby requests');
    }
  }
  const s = await one(
    ctx.db,
    `INSERT INTO provider_sessions (provider_id, on_duty, duty_started_at) VALUES ($1,$2, CASE WHEN $2 THEN now() END)
     ON CONFLICT (provider_id) DO UPDATE SET on_duty=$2, duty_started_at = CASE WHEN $2 THEN now() END,
       last_location = CASE WHEN $2 THEN provider_sessions.last_location END,
       last_location_at = CASE WHEN $2 THEN provider_sessions.last_location_at END, updated_at=now()
     RETURNING on_duty, duty_started_at, active_job_id`,
    [providerId, on],
  );
  if (!on) await ctx.redis.del(`prov:loc:${providerId}`);
  return { on_duty: s.on_duty as boolean, duty_started_at: s.duty_started_at, active_job_id: s.active_job_id };
}

export interface Ping {
  lat: number;
  lng: number;
  recorded_at: string;
}

/**
 * Batched pings. Rejected (and nothing stored) unless on duty with consent. Used only for ETA;
 * never exposed to patients.
 */
export async function recordPings(ctx: Ctx, providerId: string, pings: Ping[]) {
  return tx(ctx.db, async (c) => {
    const s = await maybeOne(c, 'SELECT * FROM provider_sessions WHERE provider_id=$1 FOR UPDATE', [providerId]);
    if (!s?.on_duty || !s.location_consent_at) throw new AppError('NOT_ON_DUTY', 'Location is only collected while on duty');
    const now = Date.now();
    const valid = pings
      .filter((p) => {
        const t = Date.parse(p.recorded_at);
        // drop anything from before this duty period or implausibly in the future
        return t <= now + 60_000 && (!s.duty_started_at || t >= new Date(s.duty_started_at).getTime() - 60_000);
      })
      .sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
    if (valid.length === 0) return { stored: 0 };
    await c.query(
      `INSERT INTO location_pings (provider_id, job_id, point, recorded_at)
       SELECT $1, $2, ST_SetSRID(ST_MakePoint(x.lng, x.lat), 4326)::geography, x.recorded_at
       FROM jsonb_to_recordset($3::jsonb) AS x(lat float8, lng float8, recorded_at timestamptz)`,
      [providerId, s.active_job_id, JSON.stringify(valid)],
    );
    const last = valid[valid.length - 1]!;
    await c.query(
      `UPDATE provider_sessions SET last_location = ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, last_location_at=$4, updated_at=now() WHERE provider_id=$1`,
      [providerId, last.lng, last.lat, last.recorded_at],
    );
    c.afterCommit(() =>
      ctx.redis.set(`prov:loc:${providerId}`, JSON.stringify({ lat: last.lat, lng: last.lng, at: last.recorded_at }), 'EX', ctx.config.duty.locationTtlSeconds),
    );
    return { stored: valid.length };
  });
}

/** Job: on duty but silent for 5 minutes → off duty. */
export async function reapIdleDuty(ctx: Ctx) {
  const rows = await many(
    ctx.db,
    `UPDATE provider_sessions SET on_duty=false, last_location=NULL, last_location_at=NULL, updated_at=now()
     WHERE on_duty AND provider_id IN (SELECT id FROM providers WHERE role <> ALL($2))
       AND COALESCE(last_location_at, duty_started_at, updated_at) < now() - make_interval(secs => $1)
     RETURNING provider_id`,
    [ctx.config.duty.idleTimeoutSeconds, REMOTE_ROLES],
  );
  for (const r of rows) {
    await ctx.redis.del(`prov:loc:${r.provider_id}`);
    await ctx.realtime.publish(ctx.realtime.providerChannel(r.provider_id), 'duty.off', { reason: 'no_location_updates' });
  }
  return rows.length;
}
