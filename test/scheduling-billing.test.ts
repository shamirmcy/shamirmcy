import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { book, call, opsLogin, patient, readyProvider, setupEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await env.ctx.db.query('UPDATE provider_sessions SET on_duty=false');
});

type Pt = Awaited<ReturnType<typeof patient>>;
type Prov = Awaited<ReturnType<typeof readyProvider>>;
const dateIn = (days: number) => new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);

async function payInFull(pt: Pt, requestId: string) {
  const p = await call(env, 'POST', '/payments', { token: pt.token, idem: true, body: { target_type: 'service_request', target_id: requestId, method: 'upi' } });
  const body = JSON.stringify({ id: `evt_${p.body.payment_id}`, type: 'payment.captured', order_id: p.body.checkout.order_id, payment_id: `pay_${p.body.payment_id}` });
  const sig = createHmac('sha256', env.ctx.config.env.PAYMENT_WEBHOOK_SECRET).update(body).digest('hex');
  await env.app.inject({ method: 'POST', url: '/v1/webhooks/payments', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: body });
  return p.body as { payment_id: string; amount_paise: number };
}

async function ivVisitWithCheaperKit(nurse: Prov, pt: Pt) {
  const up = await call(env, 'POST', '/uploads/presign', { token: pt.token, body: { kind: 'prescription_photo', content_type: 'image/jpeg', size_bytes: 100000 } });
  const r = await book(env, pt, 'iv_care', { iv_type: 'drip', first_dose_mode: 'at_hospital' }, { attachments: [{ kind: 'prescription_photo', blob_key: up.body.blob_key }] });
  await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: nurse.token, idem: true, body: {} });
  const paid = await payInFull(pt, r.body.id);
  const t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
  await call(env, 'POST', `/provider/visits/${r.body.id}/arrived`, { token: nurse.token, body: { visit_code: t.body.visit_code } });
  await call(env, 'POST', `/provider/visits/${r.body.id}/start`, { token: nurse.token });
  await call(env, 'POST', `/provider/visits/${r.body.id}/actuals`, { token: nurse.token, body: { items: [{ option_code: 'kit_drip', actual_paise: 40000 }] } });
  return { requestId: r.body.id as string, paid };
}

describe('double-booking protection', () => {
  it('never offers or lets a provider accept overlapping visits', async () => {
    const cg = await readyProvider(env, 'caregiver');
    const day = dateIn(3);

    const a = await patient(env);
    const ra = await book(env, a, 'elder_care', { shift: 'day', duration: 'day', start_date: day });
    expect((await call(env, 'POST', `/provider/requests/${ra.body.id}/accept`, { token: cg.token, idem: true, body: {} })).status).toBe(200);

    // Same day shift for another patient: the only caregiver is busy → nobody to offer it to.
    const b = await patient(env);
    const rb = await book(env, b, 'elder_care', { shift: 'day', duration: 'day', start_date: day });
    expect((await call(env, 'GET', `/service-requests/${rb.body.id}`, { token: b.token })).body.status).toBe('no_provider');

    // Night shift the same day does not overlap (10 am–5 pm vs 9 pm–7 am) → offered.
    const c = await patient(env);
    const rc = await book(env, c, 'elder_care', { shift: 'night', duration: 'day', start_date: day });
    const offered = await env.ctx.db.query(`SELECT provider_id FROM request_assignments WHERE request_id=$1 AND outcome='offered'`, [rc.body.id]);
    expect(offered.rows.map((o) => o.provider_id)).toEqual([cg.providerId]);

    // Two overlapping offers made before either was accepted: the second accept is refused.
    const day2 = dateIn(5);
    const x = await patient(env);
    const y = await patient(env);
    const rx = await book(env, x, 'elder_care', { shift: 'day', duration: 'day', start_date: day2 });
    const ry = await book(env, y, 'elder_care', { shift: 'day', duration: 'week', start_date: day2 });
    expect((await call(env, 'POST', `/provider/requests/${rx.body.id}/accept`, { token: cg.token, idem: true, body: {} })).status).toBe(200);
    const clash = await call(env, 'POST', `/provider/requests/${ry.body.id}/accept`, { token: cg.token, idem: true, body: {} });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('SCHEDULE_CLASH');
  });
});

describe('rescheduling', () => {
  it('moves one visit of a series, tells the provider, and refuses bad times', async () => {
    const cg = await readyProvider(env, 'caregiver');
    const pt = await patient(env);
    const r = await book(env, pt, 'elder_care', { shift: 'day', duration: 'week', start_date: dateIn(4) });
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: cg.token, idem: true, body: {} });
    const before = (await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token })).body.visits;

    // Visit 3 moves 3 hours later (still clear of visits 2 and 4).
    const moved = new Date(Date.parse(before[2].scheduled_for) + 3 * 3600e3).toISOString();
    const ok = await call(env, 'POST', `/service-requests/${r.body.id}/visits/3/reschedule`, { token: pt.token, idem: true, body: { scheduled_for: moved } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = (await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token })).body.visits;
    expect(after[2].scheduled_for).toBe(moved);
    const row = await env.ctx.db.query('SELECT rescheduled_from FROM visit_occurrences WHERE request_id=$1 AND seq=3', [r.body.id]);
    expect(new Date(row.rows[0].rescheduled_from).toISOString()).toBe(before[2].scheduled_for);
    const ev = await env.ctx.realtime.replay(`provider:${cg.providerId}`, 0);
    expect(ev.events.some((e) => e.type === 'visit.rescheduled' && (e.payload as any).seq === 3)).toBe(true);
    expect((await env.ctx.db.query(`SELECT 1 FROM notifications WHERE user_id=$1 AND event='visit_rescheduled'`, [cg.userId])).rowCount).toBeGreaterThan(0);

    // Too soon.
    const soon = await call(env, 'POST', `/service-requests/${r.body.id}/visits/4/reschedule`, { token: pt.token, idem: true, body: { scheduled_for: new Date(Date.now() + 3600e3).toISOString() } });
    expect(soon.body.error.code).toBe('VALIDATION_ERROR');
    // On top of another visit in the same booking.
    const self = await call(env, 'POST', `/service-requests/${r.body.id}/visits/4/reschedule`, { token: pt.token, idem: true, body: { scheduled_for: before[4].scheduled_for } });
    expect(self.body.error.code).toBe('SCHEDULE_CLASH');
    // A stranger cannot reschedule.
    const stranger = await patient(env);
    expect((await call(env, 'POST', `/service-requests/${r.body.id}/visits/4/reschedule`, { token: stranger.token, idem: true, body: { scheduled_for: moved } })).status).toBe(404);
  });

  it("refuses a time when the patient's professional is booked elsewhere, without revealing details", async () => {
    const cg = await readyProvider(env, 'caregiver');
    const a = await patient(env);
    const ra = await book(env, a, 'elder_care', { shift: 'day', duration: 'day', start_date: dateIn(6) });
    await call(env, 'POST', `/provider/requests/${ra.body.id}/accept`, { token: cg.token, idem: true, body: {} });
    const b = await patient(env);
    const rb = await book(env, b, 'elder_care', { shift: 'day', duration: 'day', start_date: dateIn(7) });
    await call(env, 'POST', `/provider/requests/${rb.body.id}/accept`, { token: cg.token, idem: true, body: {} });

    const clashAt = new Date(`${dateIn(6)}T12:00:00+05:30`).toISOString();
    const res = await call(env, 'POST', `/service-requests/${rb.body.id}/visits/1/reschedule`, { token: b.token, idem: true, body: { scheduled_for: clashAt } });
    expect(res.body.error).toMatchObject({ code: 'SCHEDULE_CLASH', message: 'Your care professional is not free then. Please pick another time.' });
    // Nothing changed.
    const v = (await call(env, 'GET', `/service-requests/${rb.body.id}`, { token: b.token })).body.visits[0];
    expect(v.scheduled_for).toBe(new Date(`${dateIn(7)}T10:00:00+05:30`).toISOString());
  });
});

describe('PDF receipts', () => {
  it('generates a receipt PDF once, only for its owner', async () => {
    const doc = await readyProvider(env, 'doctor');
    const pt = await patient(env);
    const r = await book(env, pt, 'doctor_visit');
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: doc.token, idem: true, body: {} });
    const t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    expect(t.body.invoice_id).toBeNull();
    await call(env, 'POST', `/provider/visits/${r.body.id}/arrived`, { token: doc.token, body: { visit_code: t.body.visit_code } });
    await call(env, 'POST', `/provider/visits/${r.body.id}/start`, { token: doc.token });
    await call(env, 'POST', `/provider/visits/${r.body.id}/complete`, { token: doc.token, idem: true });

    const invoiceId = (await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token })).body.invoice_id;
    expect(invoiceId).toBeTruthy();
    const pdf = await call(env, 'GET', `/invoices/${invoiceId}/pdf`, { token: pt.token });
    expect(pdf.status).toBe(200);
    expect(pdf.body.url).toBeTruthy();
    const row = await env.ctx.db.query('SELECT pdf_key FROM invoices WHERE id=$1', [invoiceId]);
    const bytes = await env.ctx.adapters.storage.get(row.rows[0].pdf_key);
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    // Second download reuses the stored file.
    await call(env, 'GET', `/invoices/${invoiceId}/pdf`, { token: pt.token });
    expect((await env.ctx.db.query('SELECT pdf_key FROM invoices WHERE id=$1', [invoiceId])).rows[0].pdf_key).toBe(row.rows[0].pdf_key);

    const stranger = await patient(env);
    expect((await call(env, 'GET', `/invoices/${invoiceId}/pdf`, { token: stranger.token })).status).toBe(404);
  });
});

describe('refund retries', () => {
  it('retries a failed refund with backoff, blocks double refunds meanwhile, then succeeds', async () => {
    const nurse = await readyProvider(env, 'staff_nurse');
    const pt = await patient(env);
    const { requestId, paid } = await ivVisitWithCheaperKit(nurse, pt);
    env.gateway.failRefunds = 1;
    const done = await call(env, 'POST', `/provider/visits/${requestId}/complete`, { token: nurse.token, idem: true });
    expect(done.body.final_total_paise).toBe(39900 + 40000);

    let ref = await env.ctx.db.query('SELECT * FROM refunds WHERE payment_id=$1', [paid.payment_id]);
    expect(ref.rows[0]).toMatchObject({ status: 'failed', amount_paise: 20000, attempts: 1 });
    expect(ref.rows[0].next_retry_at.getTime()).toBeGreaterThan(Date.now());

    // While the retry is pending, ops cannot refund that money a second time.
    const ops = await opsLogin(env);
    const dbl = await call(env, 'POST', '/ops/refunds', { token: ops.token, idem: true, body: { payment_id: paid.payment_id, amount_paise: paid.amount_paise, reason: 'Full refund' } });
    expect(dbl.body.error.code).toBe('VALIDATION_ERROR');

    await env.jobs.enqueue('refunds.retry', {}); // not due yet: nothing happens
    expect((await env.ctx.db.query('SELECT status FROM refunds WHERE payment_id=$1', [paid.payment_id])).rows[0].status).toBe('failed');
    await env.ctx.db.query(`UPDATE refunds SET next_retry_at = now() - interval '1 second' WHERE payment_id=$1`, [paid.payment_id]);
    await env.jobs.enqueue('refunds.retry', {});
    ref = await env.ctx.db.query('SELECT * FROM refunds WHERE payment_id=$1', [paid.payment_id]);
    expect(ref.rows[0]).toMatchObject({ status: 'processed', attempts: 2, last_error: null });
    const p = await env.ctx.db.query('SELECT status FROM payments WHERE id=$1', [paid.payment_id]);
    expect(p.rows[0].status).toBe('partially_refunded');
    expect((await env.ctx.db.query(`SELECT 1 FROM notifications WHERE user_id=$1 AND event='refund_issued'`, [pt.userId])).rowCount).toBeGreaterThan(0);
  });

  it('gives up after the last attempt and alerts ops', async () => {
    const nurse = await readyProvider(env, 'staff_nurse');
    const pt = await patient(env);
    const { requestId, paid } = await ivVisitWithCheaperKit(nurse, pt);
    env.gateway.failRefunds = 100;
    await call(env, 'POST', `/provider/visits/${requestId}/complete`, { token: nurse.token, idem: true });
    await env.ctx.db.query(`UPDATE refunds SET attempts=5, next_retry_at = now() - interval '1 second' WHERE payment_id=$1`, [paid.payment_id]);
    await env.jobs.enqueue('refunds.retry', {});
    env.gateway.failRefunds = 0;
    const ref = await env.ctx.db.query('SELECT * FROM refunds WHERE payment_id=$1', [paid.payment_id]);
    expect(ref.rows[0].attempts).toBe(6);
    expect(ref.rows[0].gave_up_at).not.toBeNull();
    expect(ref.rows[0].next_retry_at).toBeNull();
    const ops = await env.ctx.realtime.replay('ops', 0);
    expect(ops.events.some((e) => e.type === 'refund.failed_permanently' && (e.payload as any).refund_id === ref.rows[0].id)).toBe(true);
    // Once given up, ops can refund it manually.
    const opsUser = await opsLogin(env);
    const manual = await call(env, 'POST', '/ops/refunds', { token: opsUser.token, idem: true, body: { payment_id: paid.payment_id, amount_paise: 20000, reason: 'Manual refund after gateway failures' } });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);
  });
});

describe('rate limits', () => {
  it('limits public calls per IP per minute', async () => {
    const ip = '203.0.113.77';
    let last = 0;
    let retryAfter: unknown;
    for (let i = 0; i < 61; i++) {
      const r = await call(env, 'GET', '/about', { ip });
      last = r.status;
      retryAfter = r.headers['retry-after'];
    }
    expect(last).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    // Other callers are unaffected.
    expect((await call(env, 'GET', '/about', { ip: '203.0.113.78' })).status).toBe(200);
    // Signed-in users are counted per user (higher limit).
    const pt = await patient(env);
    expect((await call(env, 'GET', '/me', { token: pt.token, ip })).status).toBe(200);
  });
});
