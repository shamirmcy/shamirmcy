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

/** Pay the current amount due by UPI and confirm it through the signed webhook. */
async function payInFull(pt: Pt, requestId: string) {
  const p = await call(env, 'POST', '/payments', { token: pt.token, idem: true, body: { target_type: 'service_request', target_id: requestId, method: 'upi' } });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const body = JSON.stringify({ id: `evt_${p.body.payment_id}`, type: 'payment.captured', order_id: p.body.checkout.order_id, payment_id: `pay_${p.body.payment_id}` });
  const sig = createHmac('sha256', env.ctx.config.env.PAYMENT_WEBHOOK_SECRET).update(body).digest('hex');
  await env.app.inject({ method: 'POST', url: '/v1/webhooks/payments', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: body });
  return p.body as { payment_id: string; amount_paise: number };
}

/** Door code → start → complete for the next visit of a request. */
async function doVisit(pt: Pt, prov: Prov, requestId: string) {
  const t = await call(env, 'GET', `/service-requests/${requestId}`, { token: pt.token });
  const arr = await call(env, 'POST', `/provider/visits/${requestId}/arrived`, { token: prov.token, body: { visit_code: t.body.visit_code } });
  expect(arr.status, JSON.stringify(arr.body)).toBe(200);
  expect((await call(env, 'POST', `/provider/visits/${requestId}/start`, { token: prov.token })).status).toBe(200);
  const done = await call(env, 'POST', `/provider/visits/${requestId}/complete`, { token: prov.token, idem: true });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return done.body;
}

describe('multi-visit series', () => {
  it('dressing ×5: same nurse, new door code per visit, per-visit payouts, skipped visit and materials true-up refunded', async () => {
    const nurse = await readyProvider(env, 'staff_nurse');
    const pt = await patient(env);
    const r = await book(env, pt, 'wound_dressing', { wound_type: 'diabetic_ulcer', frequency: 'daily_x5' });
    expect(r.status).toBe(201);
    expect(r.body.total_paise).toBe(5 * (39900 + 12000));
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: nurse.token, idem: true, body: {} });

    let t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    expect(t.body.visits.map((v: any) => v.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(t.body.visits[0].scheduled_for).toBeNull(); // first visit: as soon as possible
    const day = (i: number) => Date.parse(t.body.visits[i].scheduled_for);
    expect(day(2) - day(1)).toBe(86_400_000);

    const paid = await payInFull(pt, r.body.id);
    expect(paid.amount_paise).toBe(259500);

    const firstCode = t.body.visit_code;
    const v1 = await doVisit(pt, nurse, r.body.id);
    expect(v1).toMatchObject({ status: 'confirmed', completed_visit: 1, next_visit: { seq: 2 } });
    const lines = await env.ctx.db.query(`SELECT option_code, gross_paise, net_paise FROM payout_lines WHERE request_id=$1`, [r.body.id]);
    expect(lines.rows).toEqual([{ option_code: 'visit#1', gross_paise: 39900, net_paise: 39900 }]); // dressing fee paid in full

    t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    expect(t.body.status).toBe('confirmed');
    expect(t.body.visits[0].status).toBe('completed');
    expect(t.body.eta_minutes).toBeNull(); // nurse is not travelling yet
    const codeRow = await env.ctx.db.query('SELECT verified_at FROM visit_codes WHERE request_id=$1', [r.body.id]);
    expect(codeRow.rows[0].verified_at).toBeNull(); // fresh code issued for visit 2
    // Old door code no longer works (unless the new random code happens to match).
    if (t.body.visit_code !== firstCode) {
      const stale = await call(env, 'POST', `/provider/visits/${r.body.id}/arrived`, { token: nurse.token, body: { visit_code: firstCode } });
      expect(stale.body.error.code).toBe('VISIT_CODE_INVALID');
    }

    // Patient skips the last visit.
    expect((await call(env, 'POST', `/service-requests/${r.body.id}/visits/5/cancel`, { token: pt.token, idem: true })).status).toBe(200);

    // Visit 2 via "on my way": ETA in minutes appears for the patient.
    const omw = await call(env, 'POST', `/provider/visits/${r.body.id}/on-my-way`, { token: nurse.token });
    expect(omw.body.eta_minutes).toBeGreaterThan(0);
    expect((await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token })).body.eta_minutes).toBeGreaterThan(0);
    await doVisit(pt, nurse, r.body.id);
    await doVisit(pt, nurse, r.body.id);

    // Materials cost less than estimated over the series. Cannot exceed the quote.
    const over = await call(env, 'POST', `/provider/visits/${r.body.id}/actuals`, { token: nurse.token, body: { items: [{ option_code: 'materials', actual_paise: 70000 }] } });
    expect(over.body.error.code).toBe('VALIDATION_ERROR');
    expect((await call(env, 'POST', `/provider/visits/${r.body.id}/actuals`, { token: nurse.token, body: { items: [{ option_code: 'materials', actual_paise: 30000 }] } })).status).toBe(200);
    expect((await call(env, 'POST', `/provider/visits/${r.body.id}/actuals`, { token: nurse.token, body: { items: [{ option_code: 'visit', actual_paise: 100 }] } })).body.error.code).toBe('VALIDATION_ERROR');

    const last = await doVisit(pt, nurse, r.body.id);
    expect(last.status).toBe('completed');
    // 4 visits × ₹399 + materials at actual ₹300 (≤ 4 × ₹120 billed)
    expect(last.final_total_paise).toBe(4 * 39900 + 30000);
    expect(last.invoice_number).toBeTruthy();

    const refunds = await env.ctx.db.query(`SELECT amount_paise, source, status FROM refunds WHERE payment_id=$1`, [paid.payment_id]);
    expect(refunds.rows).toEqual([{ amount_paise: 259500 - 189600, source: 'settlement', status: 'processed' }]);
    const pay = await env.ctx.db.query('SELECT status FROM payments WHERE id=$1', [paid.payment_id]);
    expect(pay.rows[0].status).toBe('partially_refunded');
    const notified = await env.ctx.db.query(`SELECT 1 FROM notifications WHERE user_id=$1 AND event='refund_issued'`, [pt.userId]);
    expect(notified.rowCount).toBeGreaterThan(0);

    const inv = await env.ctx.db.query(`SELECT line_items, total_paise FROM invoices WHERE target_id=$1`, [r.body.id]);
    expect(inv.rows[0].total_paise).toBe(189600);
    expect(inv.rows[0].line_items.find((l: any) => l.code === 'visit')).toMatchObject({ qty: 4, amount_paise: 159600, note: '4 of 5 visits completed' });
    const payouts = await env.ctx.db.query(`SELECT count(*)::int AS n, sum(net_paise)::int AS net FROM payout_lines WHERE request_id=$1`, [r.body.id]);
    expect(payouts.rows[0]).toEqual({ n: 4, net: 4 * 39900 });
    // Nothing more to pay.
    expect((await call(env, 'POST', '/payments', { token: pt.token, idem: true, body: { target_type: 'service_request', target_id: r.body.id, method: 'upi' } })).body.error.code).toBe('CONFLICT');
  });

  it('elder care week: 7 shifts at 10 am IST, provider not held until on-my-way, shows in schedule', async () => {
    const cg = await readyProvider(env, 'caregiver');
    const pt = await patient(env);
    const start = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10);
    const r = await book(env, pt, 'elder_care', { shift: 'day', duration: 'week', start_date: start });
    expect(r.body.total_paise).toBe(7 * 59900);
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: cg.token, idem: true, body: {} });
    const t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    expect(t.body.status).toBe('confirmed');
    expect(t.body.visits).toHaveLength(7);
    expect(t.body.visits[0].scheduled_for).toBe(new Date(`${start}T10:00:00+05:30`).toISOString());
    expect(t.body.eta_minutes).toBeNull();
    const s = await env.ctx.db.query('SELECT active_job_id FROM provider_sessions WHERE provider_id=$1', [cg.providerId]);
    expect(s.rows[0].active_job_id).toBeNull(); // free to take other work before the shifts start

    const today = await call(env, 'GET', '/provider/today', { token: cg.token });
    expect(today.body.upcoming.filter((v: any) => v.request_id === r.body.id).length).toBeGreaterThan(0);
    const view = await call(env, 'GET', `/provider/requests/${r.body.id}`, { token: cg.token });
    expect(view.body.visits).toHaveLength(7);
  });

  it('missed visits are swept; a series with none done fails and is refunded in full', async () => {
    const cg = await readyProvider(env, 'caregiver');
    const pt = await patient(env);
    const past = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10);
    const r = await book(env, pt, 'elder_care', { shift: 'night', duration: 'day', start_date: past });
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: cg.token, idem: true, body: {} });
    const paid = await payInFull(pt, r.body.id);
    await env.jobs.enqueue('visits.sweep', {});
    const t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    expect(t.body.status).toBe('failed');
    expect(t.body.visits[0].status).toBe('missed');
    expect(t.body.final_total_paise).toBe(0);
    const refunds = await env.ctx.db.query(`SELECT amount_paise FROM refunds WHERE payment_id=$1`, [paid.payment_id]);
    expect(refunds.rows[0].amount_paise).toBe(69900);
    const s = await env.ctx.db.query('SELECT active_job_id FROM provider_sessions WHERE provider_id=$1', [cg.providerId]);
    expect(s.rows[0].active_job_id).toBeNull();
  });

  it('patient stops a series part-way: only completed visits are billed', async () => {
    const nurse = await readyProvider(env, 'staff_nurse');
    const pt = await patient(env);
    const r = await book(env, pt, 'wound_dressing', { wound_type: 'surgical', frequency: 'alternate_x7' });
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: nurse.token, idem: true, body: {} });
    const t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    expect(Date.parse(t.body.visits[2].scheduled_for) - Date.parse(t.body.visits[1].scheduled_for)).toBe(2 * 86_400_000);
    const paid = await payInFull(pt, r.body.id);
    await doVisit(pt, nurse, r.body.id);
    const c = await call(env, 'POST', `/service-requests/${r.body.id}/cancel`, { token: pt.token, idem: true, body: { reason: 'Healed' } });
    expect(c.body).toMatchObject({ status: 'cancelled_by_patient', cancellation_fee_paise: 0, final_total_paise: 51900, refund_due_paise: 7 * 51900 - 51900 });
    const refunds = await env.ctx.db.query(`SELECT sum(amount_paise)::int AS n FROM refunds WHERE payment_id=$1`, [paid.payment_id]);
    expect(refunds.rows[0].n).toBe(6 * 51900);
    const visits = (await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token })).body.visits;
    expect(visits.filter((v: any) => v.status === 'cancelled')).toHaveLength(6);
  });
});

describe('estimate true-up', () => {
  it('IV kit billed at actual cost when cheaper than "up to ₹600"', async () => {
    const nurse = await readyProvider(env, 'staff_nurse');
    const pt = await patient(env);
    const up = await call(env, 'POST', '/uploads/presign', { token: pt.token, body: { kind: 'prescription_photo', content_type: 'image/jpeg', size_bytes: 100000 } });
    const r = await book(env, pt, 'iv_care', { iv_type: 'drip', first_dose_mode: 'at_hospital' }, { attachments: [{ kind: 'prescription_photo', blob_key: up.body.blob_key }] });
    expect(r.body.total_paise).toBe(39900 + 60000);
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: nurse.token, idem: true, body: {} });
    const view = await call(env, 'GET', `/provider/requests/${r.body.id}`, { token: nurse.token });
    expect(view.body.estimated_items).toEqual([{ option_code: 'kit_drip', name: 'Drip kit (up to)', quoted_paise: 60000 }]);
    const t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    await call(env, 'POST', `/provider/visits/${r.body.id}/arrived`, { token: nurse.token, body: { visit_code: t.body.visit_code } });
    await call(env, 'POST', `/provider/visits/${r.body.id}/start`, { token: nurse.token });
    expect((await call(env, 'POST', `/provider/visits/${r.body.id}/actuals`, { token: nurse.token, body: { items: [{ option_code: 'kit_drip', actual_paise: 42000, note: 'NS 500 ml + set' }] } })).status).toBe(200);
    const done = await call(env, 'POST', `/provider/visits/${r.body.id}/complete`, { token: nurse.token, idem: true });
    expect(done.body.final_total_paise).toBe(39900 + 42000);
    // Paying afterwards charges the settled amount, not the quote.
    const p = await call(env, 'POST', '/payments', { token: pt.token, idem: true, body: { target_type: 'service_request', target_id: r.body.id, method: 'cash' } });
    expect(p.body.amount_paise).toBe(81900);
    // Settled visits cannot be adjusted.
    expect((await call(env, 'POST', `/provider/visits/${r.body.id}/actuals`, { token: nurse.token, body: { items: [{ option_code: 'kit_drip', actual_paise: 1000 }] } })).status).toBe(409);
  });
});

describe('provider cancellation', () => {
  it('re-assigns to another provider; the canceller is never re-offered; frequent cancellers flagged', async () => {
    const a = await readyProvider(env, 'doctor');
    const b = await readyProvider(env, 'doctor', { lat: 12.975, lng: 77.645 });
    const pt = await patient(env);
    const r = await book(env, pt, 'doctor_visit');
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: a.token, idem: true, body: {} });
    const c = await call(env, 'POST', `/provider/requests/${r.body.id}/cancel`, { token: a.token, idem: true, body: { reason: 'Vehicle breakdown' } });
    expect(c.status, JSON.stringify(c.body)).toBe(200);

    let t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    expect(t.body.status).toBe('assigning');
    expect(t.body.provider).toBeNull();
    expect((await env.ctx.db.query(`SELECT 1 FROM notifications WHERE user_id=$1 AND event='provider_cancelled'`, [pt.userId])).rowCount).toBeGreaterThan(0);
    const a2 = await env.ctx.db.query('SELECT active_job_id FROM provider_sessions WHERE provider_id=$1', [a.providerId]);
    expect(a2.rows[0].active_job_id).toBeNull();

    // B (whose earlier offer was withdrawn when A accepted) gets a fresh offer; A does not.
    const offers = await env.ctx.db.query(`SELECT provider_id FROM request_assignments WHERE request_id=$1 AND outcome='offered'`, [r.body.id]);
    expect(offers.rows.map((o) => o.provider_id)).toEqual([b.providerId]);
    expect((await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: a.token, idem: true, body: {} })).status).toBe(409);
    const bAcc = await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: b.token, idem: true, body: {} });
    expect(bAcc.status, JSON.stringify(bAcc.body)).toBe(200);
    t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    expect(t.body.status).toBe('confirmed');
    expect(t.body.visit_code).toMatch(/^\d{4}$/);

    // Cannot cancel once at the door.
    await call(env, 'POST', `/provider/visits/${r.body.id}/arrived`, { token: b.token, body: { visit_code: t.body.visit_code } });
    expect((await call(env, 'POST', `/provider/requests/${r.body.id}/cancel`, { token: b.token, idem: true, body: { reason: 'Changed mind' } })).body.error.code).toBe('INVALID_TRANSITION');

    // A cancels two more visits in 30 days → ops alert.
    for (let i = 0; i < 2; i++) {
      await env.ctx.db.query('UPDATE provider_sessions SET on_duty=false WHERE provider_id<>$1', [a.providerId]);
      const p2 = await patient(env);
      const r2 = await book(env, p2, 'doctor_visit');
      await call(env, 'POST', `/provider/requests/${r2.body.id}/accept`, { token: a.token, idem: true, body: {} });
      await call(env, 'POST', `/provider/requests/${r2.body.id}/cancel`, { token: a.token, idem: true, body: { reason: 'Running late' } });
      const t2 = await call(env, 'GET', `/service-requests/${r2.body.id}`, { token: p2.token });
      expect(t2.body.status).toBe('no_provider'); // nobody else on duty
    }
    const ops = await env.ctx.realtime.replay('ops', 0);
    expect(ops.events.some((e) => e.type === 'provider.frequent_cancellations' && (e.payload as any).provider_id === a.providerId)).toBe(true);
  });
});

describe('ratings', () => {
  it('rate after completion, once; feeds rating_avg; low ratings go to ops', async () => {
    const doc = await readyProvider(env, 'doctor');
    const pt = await patient(env);
    const r = await book(env, pt, 'doctor_visit');
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: doc.token, idem: true, body: {} });
    expect((await call(env, 'POST', `/service-requests/${r.body.id}/ratings`, { token: pt.token, body: { stars: 5 } })).body.error.code).toBe('INVALID_TRANSITION');
    await doVisit(pt, doc, r.body.id);
    expect((await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token })).body.can_rate).toBe(true);
    const rate = await call(env, 'POST', `/service-requests/${r.body.id}/ratings`, { token: pt.token, body: { stars: 2, comment: 'Arrived late' } });
    expect(rate.status).toBe(201);
    expect(rate.body.rated[0]).toMatchObject({ provider_id: doc.providerId, rating_avg: 2, rating_count: 1 });
    expect((await call(env, 'POST', `/service-requests/${r.body.id}/ratings`, { token: pt.token, body: { stars: 5 } })).status).toBe(409);
    expect((await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token })).body.can_rate).toBe(false);
    const ops = await env.ctx.realtime.replay('ops', 0);
    expect(ops.events.some((e) => e.type === 'rating.low' && (e.payload as any).provider_id === doc.providerId)).toBe(true);

    // A stranger cannot rate.
    const stranger = await patient(env);
    expect((await call(env, 'POST', `/service-requests/${r.body.id}/ratings`, { token: stranger.token, body: { stars: 1 } })).status).toBe(404);

    const prof = await call(env, 'GET', '/provider/profile', { token: doc.token });
    expect(prof.body.ratings).toEqual({ average: 2, count: 1, breakdown: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 0 } });
    expect(JSON.stringify(prof.body.ratings)).not.toContain('Arrived late');
    await opsLogin(env); // ops is reachable for follow-up (smoke)
  });
});
