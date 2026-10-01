import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { book, call, login, opsLogin, patient, randomPhone, readyProvider, setupEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await env.ctx.db.query('UPDATE provider_sessions SET on_duty=false');
});

describe('auth', () => {
  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const phone = randomPhone();
    const r1 = await call(env, 'POST', '/auth/otp/request', { body: { phone: phone.slice(3), app_role: 'patient' } }); // 10-digit input accepted
    expect(r1.status).toBe(200);
    const device = { id: 'device-abc-123', platform: 'ios' as const };
    const v = await call(env, 'POST', '/auth/otp/verify', { body: { challenge_id: r1.body.challenge_id, phone, code: env.sms.lastOtp.get(phone), device } });
    expect(v.status).toBe(200);
    const rt1 = v.body.refresh_token;
    const a = await call(env, 'POST', '/auth/refresh', { body: { refresh_token: rt1, device_id: device.id } });
    expect(a.status).toBe(200);
    // Wrong device
    expect((await call(env, 'POST', '/auth/refresh', { body: { refresh_token: a.body.refresh_token, device_id: 'other-device-1' } })).status).toBe(401);
    // Reuse of rt1 → family revoked, so the fresh token dies too
    expect((await call(env, 'POST', '/auth/refresh', { body: { refresh_token: rt1, device_id: device.id } })).status).toBe(401);
    expect((await call(env, 'POST', '/auth/refresh', { body: { refresh_token: a.body.refresh_token, device_id: device.id } })).status).toBe(401);
  });

  it('limits OTP attempts and sends', async () => {
    const phone = randomPhone();
    const r = await call(env, 'POST', '/auth/otp/request', { body: { phone, app_role: 'patient' } });
    const real = env.sms.lastOtp.get(phone)!;
    const wrong = real === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const x = await call(env, 'POST', '/auth/otp/verify', { body: { challenge_id: r.body.challenge_id, phone, code: wrong, device: { id: 'device-xyz-1', platform: 'android' } } });
      expect(x.body.error.code).toBe('OTP_INVALID');
    }
    const locked = await call(env, 'POST', '/auth/otp/verify', { body: { challenge_id: r.body.challenge_id, phone, code: real, device: { id: 'device-xyz-1', platform: 'android' } } });
    expect(locked.body.error.code).toBe('OTP_LOCKED');
    await call(env, 'POST', '/auth/otp/request', { body: { phone, app_role: 'patient' } });
    await call(env, 'POST', '/auth/otp/request', { body: { phone, app_role: 'patient' } });
    const fourth = await call(env, 'POST', '/auth/otp/request', { body: { phone, app_role: 'patient' } });
    expect(fourth.status).toBe(429);
  });

  it('checks provider registration number against the phone', async () => {
    const p = await login(env, 'provider', { provider_role: 'staff_nurse', reg_number: 'TNNMC-777' });
    expect(p.providerId).toBeTruthy();
    const me = await call(env, 'GET', '/me', { token: p.token });
    expect(me.body.provider.verification_status).toBe('pending');
    // Same reg number from another phone → mismatch
    await expect(login(env, 'provider', { provider_role: 'staff_nurse', reg_number: 'tnnmc-777' })).rejects.toThrow(/PROVIDER_MISMATCH/);
    // Pending providers cannot go on duty
    const t = await call(env, 'GET', '/provider/terms/current', { token: p.token });
    await call(env, 'POST', '/provider/terms/accept', { token: p.token, body: { version: t.body.version } });
    expect((await call(env, 'POST', '/provider/duty', { token: p.token, body: { on: true } })).body.error.code).toBe('PROVIDER_NOT_VERIFIED');
  });

  it('logout revokes the access token immediately', async () => {
    const p = await login(env, 'patient');
    expect((await call(env, 'POST', '/auth/logout', { token: p.token })).status).toBe(204);
    expect((await call(env, 'GET', '/me', { token: p.token })).status).toBe(401);
  });
});

describe('home visit lifecycle', () => {
  it('runs request → offer → accept → door code → consult → complete with invoice and payout', async () => {
    const doc = await readyProvider(env, 'doctor', { languages: ['Tamil', 'English'] });
    const pt = await patient(env);
    const r = await book(env, pt, 'doctor_visit', {}, { note: 'Fever since 2 days' });
    expect(r.status).toBe(201);

    // Before acceptance the provider sees area + distance only.
    const pre = await call(env, 'GET', `/provider/requests/${r.body.id}`, { token: doc.token });
    expect(pre.status).toBe(200);
    expect(pre.body.accepted).toBe(false);
    expect(pre.body.area.pincode).toBe('560038');
    expect(pre.body.distance_km).toBeGreaterThan(0);
    expect(pre.body.address).toBeUndefined();
    expect(pre.body.symptoms).toBeUndefined();
    expect(JSON.stringify(pre.body)).not.toContain('#4521');

    const today = await call(env, 'GET', '/provider/today', { token: doc.token });
    expect(today.body.pending_requests).toHaveLength(1);

    const acc = await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: doc.token, idem: 'accept-key-0001', body: {} });
    expect(acc.status).toBe(200);
    // Idempotent replay
    const replay = await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: doc.token, idem: 'accept-key-0001', body: {} });
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const post = await call(env, 'GET', `/provider/requests/${r.body.id}`, { token: doc.token });
    expect(post.body.address.gate_code).toBe('#4521');
    expect(post.body.symptoms).toEqual(['fever']);
    expect(post.body.note).toBe('Fever since 2 days');

    const track = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    expect(track.body.visit_code).toMatch(/^\d{4}$/);
    expect(track.body.provider.credentials).toContain('MBBS');

    // ETA refresh job pushes minutes only.
    await env.jobs.enqueue('eta.refresh', {});
    const evs = await env.ctx.realtime.replay(`patient:${pt.userId}`, 0);
    expect(evs.events.some((e) => e.type === 'request.eta')).toBe(true);

    const wrong = track.body.visit_code === '0000' ? '1111' : '0000';
    const bad = await call(env, 'POST', `/provider/visits/${r.body.id}/arrived`, { token: doc.token, body: { visit_code: wrong } });
    expect(bad.body.error.code).toBe('VISIT_CODE_INVALID');
    const arr = await call(env, 'POST', `/provider/visits/${r.body.id}/arrived`, { token: doc.token, body: { visit_code: track.body.visit_code } });
    expect(arr.body.status).toBe('provider_arrived');
    // Patient was told the professional is at the door, including by voice.
    expect(env.sms.sent.some((s) => s.to === pt.phone && s.channel === 'voice')).toBe(true);
    expect((await call(env, 'POST', `/provider/visits/${r.body.id}/start`, { token: doc.token })).body.status).toBe('in_progress');

    const cons = await call(env, 'POST', '/consultations', { token: doc.token, body: { request_id: r.body.id, vitals: { bp: '130/85', temp_c: 38.2, spo2: 97 }, diagnosis: 'Viral fever', advice: 'Fluids, rest', follow_up_at: new Date(Date.now() + 3600e3).toISOString() } });
    expect(cons.status).toBe(201);
    // Clinical text is encrypted at rest.
    const raw = await env.ctx.db.query('SELECT diagnosis_enc FROM consultations WHERE id=$1', [cons.body.id]);
    expect(raw.rows[0].diagnosis_enc).toMatch(/^v1\./);
    expect(raw.rows[0].diagnosis_enc).not.toContain('Viral');

    const done = await call(env, 'POST', `/provider/visits/${r.body.id}/complete`, { token: doc.token, idem: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.invoice_number).toMatch(/^KMD\/\d{4}-\d{2}\/\d{6}$/);

    const pl = await env.ctx.db.query('SELECT gross_paise, platform_fee_paise, net_paise FROM payout_lines WHERE provider_id=$1', [doc.providerId]);
    expect(pl.rows[0]).toEqual({ gross_paise: 89900, platform_fee_paise: 17980, net_paise: 71920 }); // ₹899 → ₹719.20

    const fees = await call(env, 'GET', '/provider/fees', { token: doc.token });
    expect(fees.body.fees.find((f: any) => f.service_code === 'doctor_visit').you_receive_paise).toBe(71920);

    // Weekly payout job.
    await env.ctx.db.query(`UPDATE payout_lines SET created_at = now() - interval '1 day' WHERE provider_id=$1`, [doc.providerId]);
    await env.jobs.enqueue('payouts.weekly', {});
    const payouts = await call(env, 'GET', '/provider/payouts', { token: doc.token });
    expect(payouts.body.payouts[0].net_paise).toBe(71920);

    // Follow-up reminder job.
    await env.jobs.enqueue('followup.reminders', {});
    const n = await env.ctx.db.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND event='follow_up_reminder'`, [pt.userId]);
    expect(n.rows[0].n).toBeGreaterThan(0);

    // Records: patient sees vitals trend.
    const hr = await call(env, 'GET', '/health-records', { token: pt.token });
    expect(hr.body.vitals_trend[0].spo2).toBe(97);
    const orders = await call(env, 'GET', '/orders?filter=completed', { token: pt.token });
    expect(orders.body.orders.map((o: any) => o.id)).toContain(r.body.id);
  });

  it('offers expire after 10 minutes, then the request falls back to no_provider', async () => {
    await readyProvider(env, 'caregiver');
    const pt = await patient(env);
    const r = await book(env, pt, 'elder_care', { shift: 'night', duration: 'week', start_date: '2026-10-05' });
    expect(r.status).toBe(201);
    await env.ctx.db.query(`UPDATE request_assignments SET expires_at = now() - interval '1 second' WHERE request_id=$1`, [r.body.id]);
    await env.jobs.runDue(Date.now() + 11 * 60 * 1000, 'assignment.offer_expiry');
    const t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    expect(t.body.status).toBe('no_provider');
    expect(t.body.total_paise).toBe(7 * 69900);
  });

  it('decline moves the offer to the next provider', async () => {
    const a = await readyProvider(env, 'lab_technician');
    const pt = await patient(env);
    const r = await book(env, pt, 'lab_tests', { tests: ['cbc', 'hba1c'], fasting: true });
    expect(r.status).toBe(201);
    expect(r.body.total_paise).toBe(10000 + 35000 + 55000);
    const b = await readyProvider(env, 'lab_technician');
    await call(env, 'POST', `/provider/requests/${r.body.id}/decline`, { token: a.token, idem: true, body: { reason: 'Too far' } });
    const offers = await env.ctx.db.query(`SELECT provider_id FROM request_assignments WHERE request_id=$1 AND outcome='offered'`, [r.body.id]);
    expect(offers.rows.map((o) => o.provider_id)).toEqual([b.providerId]);
  });

  it('patient cancels for free before confirmation', async () => {
    await readyProvider(env, 'staff_nurse');
    const pt = await patient(env);
    const r = await book(env, pt, 'catheterisation');
    const c = await call(env, 'POST', `/service-requests/${r.body.id}/cancel`, { token: pt.token, idem: true, body: {} });
    expect(c.body).toMatchObject({ status: 'cancelled_by_patient', cancellation_fee_paise: 0 });
    const left = await env.ctx.db.query(`SELECT count(*)::int AS n FROM request_assignments WHERE request_id=$1 AND outcome='offered'`, [r.body.id]);
    expect(left.rows[0].n).toBe(0);
  });
});

describe('multi-provider visits', () => {
  it('IV first dose with doctor monitoring remotely creates a video session and confirms only when both accept', async () => {
    const doc = await readyProvider(env, 'doctor');
    const nurse = await readyProvider(env, 'staff_nurse');
    const pt = await patient(env);
    const up = await call(env, 'POST', '/uploads/presign', { token: pt.token, body: { kind: 'prescription_photo', content_type: 'image/jpeg', size_bytes: 200000 } });
    const r = await book(env, pt, 'iv_care', { iv_type: 'drip', first_dose_mode: 'with_doctor' }, { attachments: [{ kind: 'prescription_photo', blob_key: up.body.blob_key }] });
    expect(r.status).toBe(201);
    expect(r.body.total_paise).toBe(39900 + 59900 + 60000);

    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: doc.token, idem: true, body: { supervision_mode: 'remote' } });
    let t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    expect(t.body.status).toBe('assigning');
    // Remote supervisor does not hold an in-person job.
    const s = await env.ctx.db.query('SELECT active_job_id FROM provider_sessions WHERE provider_id=$1', [doc.providerId]);
    expect(s.rows[0].active_job_id).toBeNull();

    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: nurse.token, idem: true, body: {} });
    t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    expect(t.body.status).toBe('confirmed');
    expect(t.body.care_team.map((c: any) => c.role_in_visit).sort()).toEqual(['assist', 'remote_supervisor']);

    // Nurse arrives but cannot start the first dose until the remote doctor has joined.
    expect((await call(env, 'POST', `/provider/visits/${r.body.id}/arrived`, { token: nurse.token, body: { visit_code: t.body.visit_code } })).status).toBe(200);
    expect((await call(env, 'POST', `/provider/visits/${r.body.id}/start`, { token: nurse.token })).body.error.code).toBe('SUPERVISOR_NOT_JOINED');
    const join = await call(env, 'POST', `/provider/visits/${r.body.id}/video/join`, { token: doc.token });
    expect(join.body.purpose).toBe('first_dose_monitoring');
    expect(join.body.provider_joined_at).toBeTruthy();
    expect((await call(env, 'POST', `/provider/visits/${r.body.id}/start`, { token: nurse.token })).body.status).toBe('in_progress');
    // The remote doctor cannot check in at the door.
    expect((await call(env, 'POST', `/provider/visits/${r.body.id}/arrived`, { token: doc.token, body: { visit_code: t.body.visit_code } })).status).toBe(403);
  });

  it('psychiatry notes are visible to the consultant only', async () => {
    const cons = await readyProvider(env, 'consultant');
    const nurse = await readyProvider(env, 'staff_nurse');
    const pt = await patient(env);
    const r = await book(env, pt, 'specialist_visit', { specialty: 'psychiatry', video_slot: new Date(Date.now() + 3600e3).toISOString() });
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: cons.token, idem: true, body: {} });
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: nurse.token, idem: true, body: {} });
    const c = await call(env, 'POST', '/consultations', { token: cons.token, body: { request_id: r.body.id, notes: 'Private session notes', diagnosis: 'Adjustment disorder' } });
    expect(c.body.restricted).toBe(true);
    const nurseView = await call(env, 'GET', `/health-records?patient_id=${pt.patientId}`, { token: nurse.token });
    expect(nurseView.status).toBe(200);
    expect(nurseView.body.consultations[0].notes).toBeNull();
    expect(nurseView.body.consultations[0].notes_restricted).toBe(true);
    const consView = await call(env, 'GET', `/health-records?patient_id=${pt.patientId}`, { token: cons.token });
    expect(consView.body.consultations[0].notes).toBe('Private session notes');
  });

  it('withdrawing share_records removes provider access to records', async () => {
    const nurse = await readyProvider(env, 'staff_nurse');
    const pt = await patient(env);
    const r = await book(env, pt, 'nurse_visit', { reason: 'vitals' });
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: nurse.token, idem: true, body: {} });
    expect((await call(env, 'GET', `/health-records?patient_id=${pt.patientId}`, { token: nurse.token })).status).toBe(200);
    const consents = await call(env, 'GET', '/consents', { token: pt.token });
    const share = consents.body.consents.find((c: any) => c.template_key === 'share_records' && c.request_id === r.body.id);
    expect((await call(env, 'POST', `/consents/${share.id}/withdraw`, { token: pt.token })).status).toBe(200);
    expect((await call(env, 'GET', `/health-records?patient_id=${pt.patientId}`, { token: nurse.token })).status).toBe(403);
  });
});

describe('photo prescriptions, pharmacy and alerts', () => {
  it('photo → OCR/quality → pharmacist transcription → doctor confirms → Schedule H dispatch', async () => {
    const doc = await readyProvider(env, 'doctor');
    const pt = await patient(env);
    await call(env, 'PATCH', `/family-members/${pt.patientId}`, { token: pt.token, body: { conditions: ['Type 2 diabetes'] } });
    const r = await book(env, pt, 'doctor_visit');
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: doc.token, idem: true, body: {} });
    const t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    await call(env, 'POST', `/provider/visits/${r.body.id}/arrived`, { token: doc.token, body: { visit_code: t.body.visit_code } });
    const cons = await call(env, 'POST', '/consultations', { token: doc.token, body: { request_id: r.body.id, diagnosis: 'UTI' } });

    // Typed prescription triggers a metformin/antibiotic style alert for a diabetic patient.
    const typed = await call(env, 'POST', '/prescriptions', { token: doc.token, body: { consultation_id: cons.body.id, mode: 'typed', items: [{ drug: 'Ciprofloxacin', strength: '500 mg', pattern: '1-0-1', days: 5 }] } });
    expect(typed.body.alerts.map((a: any) => a.message).join(' ')).toMatch(/hydration/i);

    // Photo prescription
    const up = await call(env, 'POST', '/uploads/presign', { token: doc.token, body: { kind: 'prescription_photo', content_type: 'image/jpeg', size_bytes: 50000 } });
    await env.ctx.adapters.storage.put(up.body.blob_key, Buffer.alloc(50000, 1), 'image/jpeg');
    const rx = await call(env, 'POST', '/prescriptions', { token: doc.token, body: { consultation_id: cons.body.id, mode: 'photo', photo_keys: [up.body.blob_key] } });
    expect(rx.status, JSON.stringify(rx.body)).toBe(201);
    const page = await env.ctx.db.query('SELECT quality_status FROM prescription_photos WHERE prescription_id=$1', [rx.body.id]);
    expect(page.rows[0].quality_status).toBe('ok');
    await call(env, 'POST', `/prescriptions/${rx.body.id}/sign`, { token: doc.token });
    const pdf = await env.ctx.db.query('SELECT pdf_key FROM prescriptions WHERE id=$1', [rx.body.id]);
    expect(pdf.rows[0].pdf_key).toMatch(/\.pdf$/);

    // Doctor cannot confirm before transcription.
    expect((await call(env, 'POST', `/prescriptions/${rx.body.id}/confirm-transcription`, { token: doc.token })).body.error.code).toBe('TRANSCRIPTION_PENDING');

    // Pharmacy partner setup by ops.
    const ops = await opsLogin(env);
    const zone = await env.ctx.db.query(`SELECT id FROM service_zones WHERE name='Indiranagar'`);
    const partner = await call(env, 'POST', '/ops/partners', { token: ops.token, body: { kind: 'pharmacy', name: 'Indira Pharmacy', licence_no: `DL-${randomUUID()}`, service_area_zone_ids: [zone.rows[0].id] } });
    const pharmacistPhone = randomPhone();
    await call(env, 'POST', `/ops/partners/${partner.body.id}/members`, { token: ops.token, body: { phone: pharmacistPhone, member_role: 'pharmacist' } });
    const pharmacist = await login(env, 'partner', {}, pharmacistPhone);

    // Schedule H order needs the prescription.
    const noRx = await call(env, 'POST', '/pharmacy-orders', { token: pt.token, idem: true, body: { patient_id: pt.patientId, address_id: pt.addressId, items: [{ sku: 'AMOX500', qty: 10 }] } });
    expect(noRx.body.error.code).toBe('PRESCRIPTION_REQUIRED');
    const order = await call(env, 'POST', '/pharmacy-orders', { token: pt.token, idem: true, body: { patient_id: pt.patientId, address_id: pt.addressId, items: [{ sku: 'AMOX500', qty: 10 }, { sku: 'PCM500', qty: 10 }], prescription_id: rx.body.id } });
    expect(order.status).toBe(201);
    expect(order.body.total_paise).toBe(10 * 1100 + 10 * 200);
    expect(order.body.status).toBe('pending_verification');

    // Pharmacist cannot approve until the doctor confirms the transcription.
    expect((await call(env, 'POST', `/partner/pharmacy-orders/${order.body.id}/verify`, { token: pharmacist.token, body: { approve: true } })).body.error.code).toBe('TRANSCRIPTION_PENDING');
    const queue = await call(env, 'GET', '/partner/transcriptions', { token: pharmacist.token });
    expect(queue.body.pages.some((p: any) => p.prescription_id === rx.body.id)).toBe(true);
    await call(env, 'POST', `/partner/prescriptions/${rx.body.id}/transcription`, { token: pharmacist.token, body: { page_no: 1, items: [{ drug: 'Amoxicillin', strength: '500 mg', pattern: '1-1-1', days: 5 }] } });
    expect((await call(env, 'POST', `/prescriptions/${rx.body.id}/confirm-transcription`, { token: doc.token })).status).toBe(200);
    expect((await call(env, 'POST', `/partner/pharmacy-orders/${order.body.id}/verify`, { token: pharmacist.token, body: { approve: true } })).body.status).toBe('verified');
    await call(env, 'POST', `/partner/pharmacy-orders/${order.body.id}/status`, { token: pharmacist.token, body: { status: 'packed' } });
    await call(env, 'POST', `/partner/pharmacy-orders/${order.body.id}/status`, { token: pharmacist.token, body: { status: 'out_for_delivery' } });
    await call(env, 'POST', `/partner/pharmacy-orders/${order.body.id}/location`, { token: pharmacist.token, body: { lat: 12.97, lng: 77.64 } });
    // Live map is allowed for medicine delivery.
    const tr = await call(env, 'GET', `/pharmacy-orders/${order.body.id}/tracking`, { token: pt.token });
    expect(tr.body.live_location).toMatchObject({ lat: 12.97, lng: 77.64 });
    const ev = await env.ctx.realtime.replay(`patient:${pt.userId}`, 0);
    expect(ev.events.find((e) => e.type === 'delivery.location')?.payload).toMatchObject({ lat: 12.97 });
  });
});

describe('payments', () => {
  it('webhook is the source of truth and is deduplicated; ops can refund', async () => {
    const pt = await patient(env);
    await readyProvider(env, 'staff_nurse');
    const r = await book(env, pt, 'nurse_visit', { reason: 'post_op' });
    const p = await call(env, 'POST', '/payments', { token: pt.token, idem: true, body: { target_type: 'service_request', target_id: r.body.id, method: 'upi' } });
    expect(p.status).toBe(201);
    expect(p.body.amount_paise).toBe(39900);
    const orderId = p.body.checkout.order_id;
    const body = JSON.stringify({ id: 'evt_1', type: 'payment.captured', order_id: orderId, payment_id: 'pay_1' });
    const sig = createHmac('sha256', env.ctx.config.env.PAYMENT_WEBHOOK_SECRET).update(body).digest('hex');
    const bad = await env.app.inject({ method: 'POST', url: '/v1/webhooks/payments', headers: { 'content-type': 'application/json', 'x-signature': 'nope' }, payload: body });
    expect(bad.statusCode).toBe(401);
    const ok = await env.app.inject({ method: 'POST', url: '/v1/webhooks/payments', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: body });
    expect(ok.statusCode).toBe(200);
    const dup = await env.app.inject({ method: 'POST', url: '/v1/webhooks/payments', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: body });
    expect(JSON.parse(dup.body).duplicate).toBe(true);
    const row = await env.ctx.db.query('SELECT status FROM payments WHERE id=$1', [p.body.payment_id]);
    expect(row.rows[0].status).toBe('captured');

    const ops = await opsLogin(env);
    const ref = await call(env, 'POST', '/ops/refunds', { token: ops.token, idem: true, body: { payment_id: p.body.payment_id, amount_paise: 39900, reason: 'Visit cancelled by ops' } });
    expect(ref.status).toBe(201);
    const after = await env.ctx.db.query('SELECT status FROM payments WHERE id=$1', [p.body.payment_id]);
    expect(after.rows[0].status).toBe('refunded');
    const audit = await env.ctx.db.query(`SELECT action FROM audit_log WHERE entity_id=$1`, [p.body.payment_id]);
    expect(audit.rows.map((a) => a.action)).toContain('payment.refund');
    await expect(env.ctx.db.query(`DELETE FROM audit_log`)).rejects.toThrow(/APPEND_ONLY/);
  });

  it('idempotency key reused with a different body is rejected', async () => {
    const pt = await patient(env);
    const a = await call(env, 'POST', '/ambulance-requests', { token: pt.token, idem: 'same-key-12345', body: { type: 'normal', address_id: pt.addressId } });
    expect(a.status).toBe(201);
    const b = await call(env, 'POST', '/ambulance-requests', { token: pt.token, idem: 'same-key-12345', body: { type: 'ventilator', address_id: pt.addressId } });
    expect(b.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const c = await call(env, 'POST', '/ambulance-requests', { token: pt.token, body: { type: 'normal', address_id: pt.addressId } });
    expect(c.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('ambulance', () => {
  it('assigns the nearest vehicle, allows live map, pages ops if the crew does not ack', async () => {
    const ops = await opsLogin(env);
    const partner = await call(env, 'POST', '/ops/partners', { token: ops.token, body: { kind: 'ambulance', name: 'City Ambulance', licence_no: `AMB-${randomUUID()}` } });
    const far = await call(env, 'POST', `/ops/partners/${partner.body.id}/vehicles`, { token: ops.token, body: { registration_no: `KA01-${randomUUID().slice(0, 6)}`, type: 'oxygen' } });
    const near = await call(env, 'POST', `/ops/partners/${partner.body.id}/vehicles`, { token: ops.token, body: { registration_no: `KA02-${randomUUID().slice(0, 6)}`, type: 'oxygen' } });
    const crewPhone = randomPhone();
    await call(env, 'POST', `/ops/partners/${partner.body.id}/members`, { token: ops.token, body: { phone: crewPhone, member_role: 'crew' } });
    const crew = await login(env, 'partner', {}, crewPhone);
    await call(env, 'POST', `/partner/vehicles/${far.body.id}/location`, { token: crew.token, body: { lat: 13.05, lng: 77.7, available: true } });
    await call(env, 'POST', `/partner/vehicles/${near.body.id}/location`, { token: crew.token, body: { lat: 12.972, lng: 77.642, available: true } });

    const pt = await patient(env);
    const r = await call(env, 'POST', '/ambulance-requests', { token: pt.token, idem: true, body: { type: 'oxygen', address_id: pt.addressId } });
    expect(r.body.vehicle_assigned).toBe(true);
    const run = await env.ctx.db.query('SELECT vehicle_id FROM ambulance_runs WHERE id=$1', [r.body.id]);
    expect(run.rows[0].vehicle_id).toBe(near.body.id);

    await call(env, 'POST', `/partner/vehicles/${near.body.id}/location`, { token: crew.token, body: { lat: 12.9715, lng: 77.6415 } });
    const tr = await call(env, 'GET', `/ambulance-requests/${r.body.id}/tracking`, { token: pt.token });
    expect(tr.body.live_location.lat).toBe(12.9715);

    await env.jobs.runDue(Date.now() + 46_000, 'ambulance.ack_timeout');
    const paged = await env.ctx.db.query('SELECT ops_paged_at FROM ambulance_runs WHERE id=$1', [r.body.id]);
    expect(paged.rows[0].ops_paged_at).not.toBeNull();
  });
});

describe('jobs and privacy housekeeping', () => {
  it('idle-duty reaper takes silent providers off duty and wipes their location', async () => {
    const prov = await readyProvider(env, 'staff_nurse');
    await env.ctx.db.query(`UPDATE provider_sessions SET last_location_at = now() - interval '6 minutes' WHERE provider_id=$1`, [prov.providerId]);
    await env.jobs.enqueue('duty.reaper', {});
    const s = await env.ctx.db.query('SELECT on_duty, last_location FROM provider_sessions WHERE provider_id=$1', [prov.providerId]);
    expect(s.rows[0]).toEqual({ on_duty: false, last_location: null });
  });

  it('location ping partitions older than 30 days are dropped', async () => {
    const old = new Date(Date.now() - 40 * 86400e3);
    const day = old.toISOString().slice(0, 10).replace(/-/g, '');
    await env.ctx.db.query(`CREATE TABLE IF NOT EXISTS location_pings_${day} PARTITION OF location_pings FOR VALUES FROM ('${old.toISOString().slice(0, 10)}') TO ('${new Date(old.getTime() + 86400e3).toISOString().slice(0, 10)}')`);
    await env.jobs.enqueue('pings.retention', {});
    const t = await env.ctx.db.query(`SELECT to_regclass('location_pings_${day}') AS t`);
    expect(t.rows[0].t).toBeNull();
  });

  it('bio is shown to patients only after moderation', async () => {
    const doc = await readyProvider(env, 'doctor');
    await call(env, 'PUT', '/provider/bio', { token: doc.token, body: { text: 'Family physician, 11 years in Indiranagar. Speaks Tamil and English.' } });
    const pt = await patient(env);
    const r = await book(env, pt, 'doctor_visit');
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: doc.token, idem: true, body: {} });
    expect((await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token })).body.provider.bio).toBeNull();
    const ops = await opsLogin(env);
    const bios = await call(env, 'GET', '/ops/bios', { token: ops.token });
    const mine = bios.body.bios.find((b: any) => b.provider_id === doc.providerId);
    await call(env, 'POST', `/ops/bios/${mine.id}/moderate`, { token: ops.token, body: { decision: 'approved' } });
    expect((await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token })).body.provider.bio).toContain('Family physician');
  });

  it('realtime events carry sequence numbers and replay after a gap', async () => {
    const ch = `patient:${randomUUID()}`;
    for (let i = 0; i < 5; i++) await env.ctx.realtime.publish(ch, 'request.status', { i, lat: 1 });
    const { events, gap } = await env.ctx.realtime.replay(ch, 2);
    expect(events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(gap).toBe(false);
    expect((events[0]!.payload as any).lat).toBeUndefined(); // stripped on patient channels
  });

  it('websocket gateway delivers channel events and replays on resume', async () => {
    const { WebSocket } = await import('ws');
    const pt = await login(env, 'patient');
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (env.app.server.address() as { port: number }).port;
    const ch = `patient:${pt.userId}`;
    await env.ctx.realtime.publish(ch, 'request.status', { status: 'requested' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?token=${pt.token}`);
    const got: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (m) => {
        const msg = JSON.parse(m.toString());
        got.push(msg);
        if (msg.type === 'hello') {
          ws.send(JSON.stringify({ type: 'resume', channel: ch, after_seq: 0 }));
          setTimeout(() => void env.ctx.realtime.publish(ch, 'request.eta', { eta_minutes: 12, lat: 12.9 }), 50);
        }
        if (msg.type === 'request.eta') resolve();
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    ws.close();
    expect(got[0]).toMatchObject({ type: 'hello', channels: [ch] });
    expect(got.find((g) => g.type === 'request.status')?.seq).toBe(1);
    const eta = got.find((g) => g.type === 'request.eta');
    expect(eta.seq).toBe(2);
    expect(eta.payload).toEqual({ eta_minutes: 12 });
    // Another user's token cannot read this channel.
    const other = await login(env, 'patient');
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?token=${other.token}`);
    const hello = await new Promise<any>((r) => ws2.on('message', (m) => r(JSON.parse(m.toString()))));
    expect(hello.channels).toEqual([`patient:${other.userId}`]);
    ws2.close();
  });

  it('catalogue, about and openapi are served', async () => {
    const s = await call(env, 'GET', '/services');
    expect(s.body.services.find((x: any) => x.code === 'doctor_visit').options[0].price_paise).toBe(89900);
    const about = await call(env, 'GET', '/about');
    expect(about.body.responsibilities).toHaveLength(4);
    const oa = await env.app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(JSON.parse(oa.body).openapi).toBe('3.1.0');
  });
});
