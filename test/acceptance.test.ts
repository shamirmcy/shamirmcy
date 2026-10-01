import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TrackingSchema } from '../src/modules/requests/routes.js';
import { allKeys, book, call, consentsFor, login, opsLogin, patient, quote, readyProvider, setupEnv, type TestEnv } from './helpers.js';

/** Spec §13 — the ten acceptance tests that must pass. */
let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => env.close());
// Isolate tests: nobody from a previous test is available for assignment.
beforeEach(async () => {
  await env.ctx.db.query('UPDATE provider_sessions SET on_duty=false');
});

const FORBIDDEN_KEYS = /^(lat|lng|lon|latitude|longitude|location|coords|coordinates|route|polyline|heading|bearing|distance|distance_m|distance_km|path|last_location)$/i;

describe('§13 acceptance', () => {
  it('1. patient tracking for doctor, nurse, technician and caregiver visits has no coordinates or route (schema test)', async () => {
    // Schema-level: the response schema cannot carry location fields at any depth.
    const shape = JSON.stringify(TrackingSchema.toJSONSchema());
    expect(shape).not.toMatch(/"(lat|lng|latitude|longitude|location|route|polyline|heading|distance\w*)"/);

    const cases: Array<[string, string, Record<string, unknown>, Record<string, unknown>]> = [
      ['doctor_visit', 'doctor', {}, {}],
      ['nurse_visit', 'staff_nurse', { reason: 'vitals' }, {}],
      ['als_emergency', 'critical_care_technician', {}, {}],
      ['elder_care', 'caregiver', { shift: 'day', duration: 'day', start_date: '2026-10-05' }, {}],
    ];
    for (const [service, role, options, extra] of cases) {
      await env.ctx.db.query('UPDATE provider_sessions SET on_duty=false');
      const prov = await readyProvider(env, role);
      const pt = await patient(env);
      const r = await book(env, pt, service, options, extra);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const acc = await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: prov.token, idem: true, body: {} });
      expect(acc.status, JSON.stringify(acc.body)).toBe(200);

      const t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
      expect(t.status).toBe(200);
      expect(t.body.status).toBe('confirmed');
      expect(t.body.eta_minutes).toBeGreaterThan(0);
      expect(t.body.expected_by).toBeTruthy();
      expect(t.body.provider.name).toBeTruthy();
      expect(t.body.provider.verified).toBe(true);
      for (const k of allKeys(t.body)) expect(k).not.toMatch(FORBIDDEN_KEYS);
      expect(JSON.stringify(t.body)).not.toContain('77.64'); // provider/patient longitude never echoed

      // Realtime events to the patient carry minutes only.
      const events = await env.ctx.realtime.replay(`patient:${pt.userId}`, 0);
      for (const e of events.events) for (const k of allKeys(e.payload)) expect(k).not.toMatch(FORBIDDEN_KEYS);
    }
  });

  it('2. booking without the three required consents → CONSENT_REQUIRED', async () => {
    const pt = await patient(env);
    for (const drop of ['responsibility', 'share_records', 'fee_acceptance']) {
      const q = await quote(env, pt.token, 'doctor_visit');
      const consents = (await consentsFor(env, 'doctor_visit')).filter((c) => c.template_key !== drop);
      const r = await call(env, 'POST', '/service-requests', { token: pt.token, idem: true, body: { quote_token: q.quote_token, patient_id: pt.patientId, address_id: pt.addressId, consents } });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('CONSENT_REQUIRED');
      expect(r.body.error.details.missing.map((m: any) => m.template_key)).toEqual([drop]);
    }
    // Stale version is also rejected.
    const q = await quote(env, pt.token, 'doctor_visit');
    const stale = (await consentsFor(env, 'doctor_visit')).map((c) => ({ ...c, version: c.version + 5 }));
    const r = await call(env, 'POST', '/service-requests', { token: pt.token, idem: true, body: { quote_token: q.quote_token, patient_id: pt.patientId, address_id: pt.addressId, consents: stale } });
    expect(r.body.error.code).toBe('CONSENT_REQUIRED');
    const n = await env.ctx.db.query('SELECT count(*)::int AS n FROM service_requests WHERE booked_by_user_id=$1', [pt.userId]);
    expect(n.rows[0].n).toBe(0); // nothing left `draft`
  });

  it('3. provider without current terms cannot go on duty → TERMS_REQUIRED', async () => {
    const prov = await readyProvider(env, 'doctor', { acceptTerms: false, onDuty: false });
    const r = await call(env, 'POST', '/provider/duty', { token: prov.token, body: { on: true } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('TERMS_REQUIRED');

    // Accepting, then ops publishing a new version, blocks duty again.
    await call(env, 'POST', '/provider/terms/accept', { token: prov.token, body: { version: 1 } });
    expect((await call(env, 'POST', '/provider/duty', { token: prov.token, body: { on: true } })).status).toBe(200);
    await call(env, 'POST', '/provider/duty', { token: prov.token, body: { on: false } });
    const ops = await opsLogin(env);
    const pub = await call(env, 'POST', '/ops/provider-terms', { token: ops.token, body: { role: 'doctor', items: [{ title: 'Updated', text: 'New clause' }] } });
    expect(pub.status).toBe(201);
    const again = await call(env, 'POST', '/provider/duty', { token: prov.token, body: { on: true } });
    expect(again.body.error.code).toBe('TERMS_REQUIRED');
    await call(env, 'POST', '/provider/terms/accept', { token: prov.token, body: { version: pub.body.version } });
    expect((await call(env, 'POST', '/provider/duty', { token: prov.token, body: { on: true } })).status).toBe(200);
  });

  it('4. two providers accepting the same request → exactly one wins, the other gets ALREADY_ASSIGNED', async () => {
    const a = await readyProvider(env, 'doctor');
    const b = await readyProvider(env, 'doctor', { lat: 12.975, lng: 77.645 });
    const pt = await patient(env);
    const r = await book(env, pt, 'doctor_visit');
    expect(r.status).toBe(201);
    const offers = await env.ctx.db.query(`SELECT provider_id FROM request_assignments WHERE request_id=$1 AND outcome='offered'`, [r.body.id]);
    expect(offers.rows.map((x) => x.provider_id).sort()).toEqual([a.providerId, b.providerId].sort());

    const results = await Promise.all([
      call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: a.token, idem: true, body: {} }),
      call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: b.token, idem: true, body: {} }),
    ]);
    const codes = results.map((x) => x.status).sort();
    expect(codes).toEqual([200, 409]);
    const loser = results.find((x) => x.status === 409)!;
    expect(loser.body.error.code).toBe('ALREADY_ASSIGNED');
    const accepted = await env.ctx.db.query(`SELECT count(*)::int AS n FROM request_assignments WHERE request_id=$1 AND outcome='accepted'`, [r.body.id]);
    expect(accepted.rows[0].n).toBe(1);
  });

  it('5. IV care without a prescription attachment → PRESCRIPTION_REQUIRED (and nurse injection too)', async () => {
    const pt = await patient(env);
    const r = await book(env, pt, 'iv_care', { iv_type: 'antibiotic', first_dose_mode: 'at_hospital' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PRESCRIPTION_REQUIRED');
    const inj = await book(env, pt, 'nurse_visit', { reason: 'injection' });
    expect(inj.body.error.code).toBe('PRESCRIPTION_REQUIRED');

    // With a prescription photo it goes through.
    const up = await call(env, 'POST', '/uploads/presign', { token: pt.token, body: { kind: 'prescription_photo', content_type: 'image/jpeg', size_bytes: 120000 } });
    expect(up.status).toBe(200);
    const ok = await book(env, pt, 'iv_care', { iv_type: 'antibiotic', first_dose_mode: 'at_hospital' }, { attachments: [{ kind: 'prescription_photo', blob_key: up.body.blob_key }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('6. a signed prescription cannot be edited, only superseded', async () => {
    const doc = await readyProvider(env, 'doctor');
    const pt = await patient(env);
    const r = await book(env, pt, 'doctor_visit');
    await call(env, 'POST', `/provider/requests/${r.body.id}/accept`, { token: doc.token, idem: true, body: {} });
    const t = await call(env, 'GET', `/service-requests/${r.body.id}`, { token: pt.token });
    await call(env, 'POST', `/provider/visits/${r.body.id}/arrived`, { token: doc.token, body: { visit_code: t.body.visit_code } });
    await call(env, 'POST', `/provider/visits/${r.body.id}/start`, { token: doc.token });
    const cons = await call(env, 'POST', '/consultations', { token: doc.token, body: { request_id: r.body.id, diagnosis: 'Viral fever', vitals: { temp_c: 38.6 } } });
    expect(cons.status).toBe(201);
    const rx = await call(env, 'POST', '/prescriptions', { token: doc.token, body: { consultation_id: cons.body.id, mode: 'typed', items: [{ drug: 'Paracetamol', strength: '650 mg', pattern: '1-0-1', days: 3 }] } });
    expect(rx.status).toBe(201);
    // Drafts are editable.
    expect((await call(env, 'PATCH', `/prescriptions/${rx.body.id}`, { token: doc.token, body: { items: [{ drug: 'Paracetamol', strength: '500 mg', pattern: '1-1-1', days: 3 }] } })).status).toBe(200);
    expect((await call(env, 'POST', `/prescriptions/${rx.body.id}/sign`, { token: doc.token })).status).toBe(200);

    // API edit is refused…
    const edit = await call(env, 'PATCH', `/prescriptions/${rx.body.id}`, { token: doc.token, body: { items: [{ drug: 'Ibuprofen' }] } });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('PRESCRIPTION_LOCKED');
    // …and so is a direct database write (trigger).
    await expect(env.ctx.db.query(`UPDATE prescription_items SET drug='Ibuprofen' WHERE prescription_id=$1`, [rx.body.id])).rejects.toThrow(/PRESCRIPTION_LOCKED/);
    await expect(env.ctx.db.query(`UPDATE prescriptions SET version=9 WHERE id=$1`, [rx.body.id])).rejects.toThrow(/PRESCRIPTION_LOCKED/);
    await expect(env.ctx.db.query(`DELETE FROM prescriptions WHERE id=$1`, [rx.body.id])).rejects.toThrow(/PRESCRIPTION_LOCKED/);

    // Correction = new version linked to the old.
    const v2 = await call(env, 'POST', '/prescriptions', { token: doc.token, body: { consultation_id: cons.body.id, mode: 'typed', supersedes_id: rx.body.id, items: [{ drug: 'Paracetamol', strength: '650 mg', pattern: '1-0-1', days: 5 }] } });
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
    await call(env, 'POST', `/prescriptions/${v2.body.id}/sign`, { token: doc.token });
    const old = await call(env, 'GET', `/prescriptions/${rx.body.id}`, { token: pt.token });
    expect(old.body.status).toBe('superseded');
    expect(old.body.superseded_by_id).toBe(v2.body.id);
    expect(old.body.items[0].strength).toBe('500 mg'); // original content intact
  });

  it('7. prices sent by the client are ignored; total always comes from the server quote', async () => {
    const pt = await patient(env);
    const q = await call(env, 'POST', '/quotes', { token: pt.token, body: { service_code: 'doctor_visit', options: {}, price_paise: 1, total_paise: 1 } });
    expect(q.body.total_paise).toBe(89900);
    const r = await call(env, 'POST', '/service-requests', {
      token: pt.token,
      idem: true,
      body: { quote_token: q.body.quote_token, patient_id: pt.patientId, address_id: pt.addressId, consents: await consentsFor(env, 'doctor_visit'), total_paise: 100, price_paise: 100, line_items: [{ amount_paise: 1 }] },
    });
    expect(r.status).toBe(201);
    expect(r.body.total_paise).toBe(89900);
    const row = await env.ctx.db.query('SELECT total_paise FROM service_requests WHERE id=$1', [r.body.id]);
    expect(row.rows[0].total_paise).toBe(89900);

    // A tampered token is rejected outright.
    const parts = (q.body.quote_token as string).split('.');
    const forged = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    forged.total = 100;
    parts[1] = Buffer.from(JSON.stringify(forged)).toString('base64url');
    const bad = await call(env, 'POST', '/service-requests', { token: pt.token, idem: true, body: { quote_token: parts.join('.'), patient_id: pt.patientId, address_id: pt.addressId, consents: await consentsFor(env, 'doctor_visit') } });
    expect(bad.body.error.code).toBe('QUOTE_INVALID');

    // Specialist: ₹399 nurse + ₹1,100 consultant.
    const s = await quote(env, pt.token, 'specialist_visit', { specialty: 'cardiology', video_slot: '2026-10-05T10:00:00Z' });
    expect(s.total_paise).toBe(149900);
    const dressing = await quote(env, pt.token, 'wound_dressing', { wound_type: 'surgical', frequency: 'daily_x5' });
    expect(dressing.total_paise).toBe(5 * (39900 + 12000));
  });

  it('8. family member without can_view_records gets 403 on records, and the attempt is logged', async () => {
    const holder = await patient(env);
    const fm = await call(env, 'POST', '/family-members', { token: holder.token, body: { name: 'Appa', relationship: 'parent', can_book: true, can_view_records: false } });
    expect(fm.status).toBe(201);
    const r = await call(env, 'GET', `/health-records?patient_id=${fm.body.patient_id}`, { token: holder.token });
    expect(r.status).toBe(403);
    const log = await env.ctx.db.query(`SELECT * FROM record_access_log WHERE actor_user_id=$1 AND patient_id=$2`, [holder.userId, fm.body.patient_id]);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].outcome).toBe('denied');
    expect(log.rows[0].reason).toBe('can_view_records_false');

    // A stranger is also denied and logged; own records allowed and logged.
    const stranger = await patient(env);
    expect((await call(env, 'GET', `/health-records?patient_id=${fm.body.patient_id}`, { token: stranger.token })).status).toBe(403);
    expect((await call(env, 'GET', '/health-records', { token: holder.token })).status).toBe(200);
    const all = await env.ctx.db.query(`SELECT outcome FROM record_access_log WHERE actor_user_id = ANY($1) ORDER BY created_at`, [[holder.userId, stranger.userId]]);
    expect(all.rows.map((x) => x.outcome)).toEqual(['denied', 'denied', 'allowed']);
  });

  it('9. location pings are not stored while off duty', async () => {
    const prov = await readyProvider(env, 'staff_nurse', { onDuty: false });
    const ping = { pings: [{ lat: 12.97, lng: 77.64, recorded_at: new Date().toISOString() }] };
    const r = await call(env, 'POST', '/provider/location', { token: prov.token, body: ping });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('NOT_ON_DUTY');
    const count = () => env.ctx.db.query('SELECT count(*)::int AS n FROM location_pings WHERE provider_id=$1', [prov.providerId]).then((x) => x.rows[0].n);
    expect(await count()).toBe(0);

    await call(env, 'POST', '/provider/duty', { token: prov.token, body: { on: true } });
    expect((await call(env, 'POST', '/provider/location', { token: prov.token, body: ping })).status).toBe(200);
    expect(await count()).toBe(1);

    await call(env, 'POST', '/provider/duty', { token: prov.token, body: { on: false } });
    expect((await call(env, 'POST', '/provider/location', { token: prov.token, body: ping })).status).toBe(409);
    expect(await count()).toBe(1);
    const s = await env.ctx.db.query('SELECT last_location FROM provider_sessions WHERE provider_id=$1', [prov.providerId]);
    expect(s.rows[0].last_location).toBeNull(); // wiped on going off duty
  });

  it('10. an ambulance request succeeds even when payment fails', async () => {
    const pt = await patient(env);
    // A blocked account is not stopped either (emergencies ignore account flags).
    await env.ctx.db.query(`UPDATE users SET status='blocked' WHERE id=$1`, [pt.userId]);
    const fac = await env.ctx.db.query(`INSERT INTO facilities (name, location) VALUES ('City Hospital', ST_SetSRID(ST_MakePoint(77.60, 12.96),4326)::geography) RETURNING id`);
    env.gateway.failNext = true;
    const r = await call(env, 'POST', '/ambulance-requests', {
      token: pt.token,
      idem: true,
      body: { type: 'oxygen', address_id: pt.addressId, patient_id: pt.patientId, destination_facility_id: fac.rows[0].id, payment_method: 'upi' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.payment.status).toBe('failed');
    expect(r.body.escalation_108.number).toBe('108');
    const row = await env.ctx.db.query('SELECT payment_status FROM ambulance_runs WHERE id=$1', [r.body.id]);
    expect(row.rows[0].payment_status).toBe('failed');
    const tr = await call(env, 'GET', `/ambulance-requests/${r.body.id}/tracking`, { token: pt.token });
    expect(tr.status).toBe(200);
    expect(tr.body.escalation_108.available).toBe(true);
  });
});
