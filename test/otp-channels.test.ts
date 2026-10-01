import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsoleWhatsAppAdapter } from '../src/adapters/whatsapp.js';
import { call, randomPhone, setupEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let wa: ConsoleWhatsAppAdapter;
beforeAll(async () => {
  env = await setupEnv();
  wa = env.ctx.adapters.whatsapp as ConsoleWhatsAppAdapter;
});
afterAll(async () => env.close());

const verify = (phone: string, challengeId: string, code: string) =>
  call(env, 'POST', '/auth/otp/verify', { body: { challenge_id: challengeId, phone, code, device: { id: 'device-otp-test-1', platform: 'android' } } });

function signedStatus(messageId: string, status: string) {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: messageId, status, recipient_id: '91' }] } }] }] });
  const sig = 'sha256=' + createHmac('sha256', 'dev-only-whatsapp-secret').update(body).digest('hex');
  return { body, sig };
}

describe('OTP by WhatsApp and SMS', () => {
  it('sends by WhatsApp by default and the code signs you in', async () => {
    const phone = randomPhone();
    const smsBefore = env.sms.sent.length;
    const r = await call(env, 'POST', '/auth/otp/request', { body: { phone, app_role: 'patient' } });
    expect(r.body).toMatchObject({ channel: 'whatsapp', fallback: false });
    const sent = wa.sent.find((s) => s.to === phone)!;
    expect(sent.lang).toBe('en');
    expect(env.sms.sent.length).toBe(smsBefore);
    expect((await verify(phone, r.body.challenge_id, sent.code)).status).toBe(200);
    // The encrypted copy of the code is wiped once used.
    const row = await env.ctx.db.query('SELECT code_enc FROM otp_challenges WHERE id=$1', [r.body.challenge_id]);
    expect(row.rows[0].code_enc).toBeNull();
  });

  it('can be sent by SMS when the user asks', async () => {
    const phone = randomPhone();
    const waBefore = wa.sent.length;
    const r = await call(env, 'POST', '/auth/otp/request', { body: { phone, app_role: 'patient', channel: 'sms' } });
    expect(r.body).toMatchObject({ channel: 'sms', fallback: false });
    expect(wa.sent.length).toBe(waBefore);
    expect((await verify(phone, r.body.challenge_id, env.sms.lastOtp.get(phone)!)).status).toBe(200);
  });

  it('falls back to SMS straight away when WhatsApp fails', async () => {
    const phone = randomPhone();
    wa.failNext = 1;
    const r = await call(env, 'POST', '/auth/otp/request', { body: { phone, app_role: 'patient' } });
    expect(r.body).toMatchObject({ channel: 'sms', fallback: true });
    expect((await verify(phone, r.body.challenge_id, env.sms.lastOtp.get(phone)!)).status).toBe(200);
  });

  it('resends the same code by SMS when WhatsApp later reports a delivery failure (once)', async () => {
    const phone = randomPhone();
    const r = await call(env, 'POST', '/auth/otp/request', { body: { phone, app_role: 'patient' } });
    const sent = wa.sent.find((s) => s.to === phone)!;
    env.sms.lastOtp.delete(phone);

    // Bad signature is rejected.
    const bad = await env.app.inject({ method: 'POST', url: '/v1/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, payload: '{}' });
    expect(bad.statusCode).toBe(401);
    // "delivered" does nothing; "failed" triggers the SMS.
    const delivered = signedStatus(sent.messageId, 'delivered');
    await env.app.inject({ method: 'POST', url: '/v1/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': delivered.sig }, payload: delivered.body });
    expect(env.sms.lastOtp.get(phone)).toBeUndefined();
    const failed = signedStatus(sent.messageId, 'failed');
    const res = await env.app.inject({ method: 'POST', url: '/v1/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': failed.sig }, payload: failed.body });
    expect(JSON.parse(res.body)).toEqual({ ok: true, resent: 1 });
    expect(env.sms.lastOtp.get(phone)).toBe(sent.code);
    // Duplicate failure events don't send twice.
    const again = await env.app.inject({ method: 'POST', url: '/v1/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': failed.sig }, payload: failed.body });
    expect(JSON.parse(again.body).resent).toBe(0);
    expect((await verify(phone, r.body.challenge_id, sent.code)).status).toBe(200);
  });

  it('uses the user’s language for the WhatsApp template', async () => {
    const phone = randomPhone();
    await env.ctx.db.query(`INSERT INTO users (phone_e164, preferred_language) VALUES ($1,'ta')`, [phone]);
    await call(env, 'POST', '/auth/otp/request', { body: { phone, app_role: 'patient' } });
    expect(wa.sent.find((s) => s.to === phone)!.lang).toBe('ta');
  });

  it('webhook verification handshake needs the configured token', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123' });
    expect(r.statusCode).toBe(403);
  });
});
