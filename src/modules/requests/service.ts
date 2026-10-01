import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, maybeOne, one, tx, type Queryable, type TxClient } from '../../lib/db.js';
import { clientMeta } from '../../lib/http.js';
import { getDef, scheduleFor } from '../catalogue/defs.js';
import { settleRequest } from '../commerce/settlement.js';
import { consumeQuote, publicLine } from '../catalogue/service.js';
import { recordRequestConsents, type ConsentInput } from '../consents/service.js';
import { assertCanBook, getFamilyLink } from '../access.js';
import { notify } from '../notifications/service.js';
import { STATUS_LABEL, TERMINAL, transition, type RequestStatus } from './state.js';
import { approvedBio, providerCredentials } from '../providers/profile.js';

export interface CreateRequestInput {
  quote_token: string;
  patient_id: string;
  address_id: string;
  symptoms?: string[];
  note?: string;
  consents: ConsentInput[];
  attachments?: Array<{ kind: 'prescription_photo' | 'wound_photo' | 'report'; blob_key: string }>;
  prescription_id?: string;
  scheduled_for?: string;
}

/** Zone covering a point (by polygon, falling back to pincode list). */
export async function zoneForAddress(db: Queryable, addressId: string) {
  return maybeOne(
    db,
    `SELECT z.* FROM service_zones z, addresses a
     WHERE a.id=$1 AND z.active AND ((z.area IS NOT NULL AND ST_Covers(z.area, a.location)) OR a.pincode = ANY(z.pincodes))
     ORDER BY (z.area IS NOT NULL AND ST_Covers(z.area, a.location)) DESC LIMIT 1`,
    [addressId],
  );
}

export async function createServiceRequest(ctx: Ctx, req: FastifyRequest, input: CreateRequestInput) {
  const userId = req.auth.userId;
  const meta = clientMeta(req);
  return tx(ctx.db, async (c) => {
    await assertCanBook(c, userId, input.patient_id);
    // Price, options and service come only from the server-side quote.
    const quote = await consumeQuote(ctx, c, input.quote_token, userId);
    const def = getDef(quote.service_code);
    if (def.kind !== 'service_request') throw new AppError('QUOTE_INVALID', 'This quote is not for a home service');
    const svc = await one(c, 'SELECT * FROM services WHERE code=$1', [quote.service_code]);
    // Account flags never block emergencies; they do block routine bookings.
    if (!svc.emergency) await assertAccountActive(c, userId);

    const address = await maybeOne(c, 'SELECT id FROM addresses WHERE id=$1 AND patient_id=$2 AND deleted_at IS NULL', [input.address_id, input.patient_id]);
    if (!address) throw new AppError('VALIDATION_ERROR', 'Address does not belong to this patient');
    if (!(await zoneForAddress(c, input.address_id))) throw new AppError('NOT_SERVICEABLE', 'We do not serve this area yet');

    if (input.prescription_id) {
      const rx = await maybeOne(c, `SELECT 1 FROM prescriptions WHERE id=$1 AND patient_id=$2 AND status='signed'`, [input.prescription_id, input.patient_id]);
      if (!rx) throw new AppError('VALIDATION_ERROR', 'prescription_id must be a signed prescription for this patient');
    }

    // Visit schedule: one occurrence for single visits, several for dressing series / elder-care shifts.
    const firstAt = input.scheduled_for ?? (quote.options?.video_slot as string | undefined) ?? null;
    const occurrences = scheduleFor(def, quote.options, firstAt ? new Date(firstAt) : null);
    const scheduledFor = occurrences[0] ?? null;
    const sr = await one(
      c,
      `INSERT INTO service_requests (patient_id, booked_by_user_id, service_code, options, address_id, symptoms_enc, note_enc,
         quote_id, line_items, total_paise, status, first_dose_mode, emergency, prescription_id, scheduled_for)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11,$12,$13,$14) RETURNING *`,
      [
        input.patient_id,
        userId,
        quote.service_code,
        quote.options,
        input.address_id,
        ctx.cipher.encryptJson(input.symptoms ?? []),
        input.note ? ctx.cipher.encrypt(input.note) : null,
        quote.id,
        JSON.stringify(quote.line_items),
        quote.total_paise,
        def.firstDoseMode?.(quote.options) ?? null,
        Boolean(svc.emergency),
        input.prescription_id ?? null,
        scheduledFor,
      ],
    );
    await c.query(`INSERT INTO request_events (request_id, to_status, actor_type, actor_id) VALUES ($1,'draft','patient',$2)`, [sr.id, userId]);

    for (const s of def.slots(quote.options)) {
      await c.query('INSERT INTO request_slots (request_id, role, role_in_visit, remote) VALUES ($1,$2,$3,$4)', [sr.id, s.role, s.role_in_visit, s.remote]);
    }
    for (const [i, at] of occurrences.entries()) {
      await c.query('INSERT INTO visit_occurrences (request_id, seq, scheduled_for) VALUES ($1,$2,$3)', [sr.id, i + 1, at]);
    }
    for (const a of input.attachments ?? []) await attachUpload(c, sr.id, userId, a.kind, a.blob_key);

    await recordRequestConsents(c, {
      patientId: input.patient_id,
      userId,
      requestId: sr.id,
      serviceCode: quote.service_code,
      consents: input.consents,
      ip: meta.ip,
      device: meta.device,
    });

    await transition(ctx, c, sr.id, 'requested', { type: 'patient', id: userId });

    if (quote.service_code === 'lab_tests') {
      await c.query('INSERT INTO lab_orders (request_id, patient_id, tests, fasting_required) VALUES ($1,$2,$3,$4)', [
        sr.id,
        input.patient_id,
        quote.options.tests,
        Boolean(quote.options.fasting),
      ]);
    }

    c.afterCommit(() => ctx.jobs.enqueue('assignment.run', { requestId: sr.id }));
    return { id: sr.id as string, status: 'requested' as RequestStatus, total_paise: quote.total_paise };
  });
}

export async function assertAccountActive(c: Queryable, userId: string) {
  const u = await one(c, 'SELECT status FROM users WHERE id=$1', [userId]);
  if (u.status !== 'active') throw new AppError('FORBIDDEN', 'Your account is on hold. Contact KM DocH support.');
}

export async function attachUpload(c: Queryable, requestId: string, userId: string, kind: string, blobKey: string) {
  const up = await maybeOne(c, 'SELECT * FROM uploads WHERE blob_key=$1 AND owner_user_id=$2', [blobKey, userId]);
  if (!up || up.kind !== kind) throw new AppError('VALIDATION_ERROR', `Upload ${blobKey} not found or wrong kind`);
  await c.query('INSERT INTO request_attachments (request_id, kind, blob_key, uploaded_by) VALUES ($1,$2,$3,$4)', [requestId, kind, blobKey, userId]);
}

/** Patient may see a request they booked, or one for a patient they hold a family link to. */
export async function loadRequestForPatientUser(db: Queryable, userId: string, requestId: string) {
  const sr = await maybeOne(db, 'SELECT * FROM service_requests WHERE id=$1', [requestId]);
  if (!sr) throw new AppError('NOT_FOUND', 'Request not found');
  if (sr.booked_by_user_id !== userId && !(await getFamilyLink(db, userId, sr.patient_id))) throw new AppError('NOT_FOUND', 'Request not found');
  return sr;
}

/**
 * Patient-facing tracking. PRIVACY: never includes provider coordinates, distance, route or heading —
 * only eta_minutes and expected_by. The response schema (TrackingSchema) strips anything else.
 */
export async function getTracking(ctx: Ctx, userId: string, requestId: string) {
  const sr = await loadRequestForPatientUser(ctx.db, userId, requestId);
  const team = await many(
    ctx.db,
    `SELECT ra.role_in_visit, p.id AS provider_id, p.role, p.qualifications, p.specialities, p.languages, p.years_experience,
            p.verification_status, u.name
     FROM request_assignments ra JOIN providers p ON p.id = ra.provider_id JOIN users u ON u.id = p.user_id
     WHERE ra.request_id=$1 AND ra.outcome='accepted' ORDER BY ra.role_in_visit`,
    [sr.id],
  );
  const providers = await Promise.all(
    team.map(async (t) => ({
      name: t.name ?? 'KM DocH professional',
      role: t.role as string,
      role_in_visit: t.role_in_visit as string,
      credentials: providerCredentials(t),
      bio: await approvedBio(ctx.db, t.provider_id),
      languages: t.languages as string[],
      verified: t.verification_status === 'verified',
    })),
  );
  const visits = await many(ctx.db, 'SELECT seq, scheduled_for, status FROM visit_occurrences WHERE request_id=$1 ORDER BY seq', [sr.id]);
  const rated = await maybeOne(ctx.db, 'SELECT 1 FROM ratings WHERE request_id=$1 LIMIT 1', [sr.id]);
  const status = sr.status as RequestStatus;
  const showCode = ['confirmed', 'provider_arrived'].includes(status);
  const code = showCode ? await maybeOne(ctx.db, 'SELECT code_enc FROM visit_codes WHERE request_id=$1', [sr.id]) : null;
  const inTransit = status === 'confirmed';
  return {
    id: sr.id as string,
    service_code: sr.service_code as string,
    status,
    status_label: STATUS_LABEL[status],
    provider: providers.find((p) => p.role_in_visit === 'lead') ?? providers[0] ?? null,
    care_team: providers,
    eta_minutes: inTransit ? (sr.eta_minutes as number | null) : null,
    expected_by: inTransit && sr.expected_by ? (sr.expected_by as Date).toISOString() : null,
    visit_code: code ? ctx.cipher.decrypt(code.code_enc) : null,
    visit_code_last_shared: Boolean(code),
    scheduled_for: sr.scheduled_for ? (sr.scheduled_for as Date).toISOString() : null,
    total_paise: sr.total_paise as number,
    final_total_paise: (sr.final_total_paise as number | null) ?? null,
    line_items: (sr.line_items as any[]).map(publicLine),
    visits: visits.map((v) => ({ seq: v.seq as number, scheduled_for: v.scheduled_for ? (v.scheduled_for as Date).toISOString() : null, status: v.status as string })),
    can_rate: providers.length > 0 && visits.some((v) => v.status === 'completed') && !rated,
    cancellable: !TERMINAL.has(status) && !['provider_arrived', 'in_progress'].includes(status),
    created_at: (sr.created_at as Date).toISOString(),
  };
}

export async function cancelByPatient(ctx: Ctx, userId: string, requestId: string, reason?: string) {
  return tx(ctx.db, async (c) => {
    const sr = await loadRequestForPatientUser(c, userId, requestId);
    const status = sr.status as RequestStatus;
    if (['provider_arrived', 'in_progress'].includes(status) || TERMINAL.has(status)) {
      throw new AppError('INVALID_TRANSITION', 'This request can no longer be cancelled');
    }
    const done = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM visit_occurrences WHERE request_id=$1 AND status='completed'`, [sr.id]);
    // Free before confirmation. After confirmation the fee comes from config (OPEN ITEM: business to set; default 0).
    // Stopping a series part-way has no fee: only completed visits are billed.
    let fee = 0;
    if (status === 'confirmed' && done.n === 0) {
      const cfg = await maybeOne(c, `SELECT value FROM app_config WHERE key='cancellation_fee_after_confirmed_paise'`);
      fee = Number(cfg?.value ?? 0);
    }
    await c.query('UPDATE service_requests SET cancellation_fee_paise=$2, eta_minutes=NULL, expected_by=NULL WHERE id=$1', [sr.id, fee]);
    await c.query(`UPDATE visit_occurrences SET status='cancelled', cancelled_reason='patient_cancelled' WHERE request_id=$1 AND status='scheduled'`, [sr.id]);
    await transition(ctx, c, sr.id, 'cancelled_by_patient', { type: 'patient', id: userId }, { reason: reason ?? null });
    await releaseAssignments(ctx, c, sr.id, 'cancelled');
    const settled = await settleRequest(ctx, c, sr.id, 'cancelled');
    return { id: sr.id, status: 'cancelled_by_patient', cancellation_fee_paise: fee, final_total_paise: settled.final_total_paise, refund_due_paise: settled.refund_due_paise };
  });
}

/** Skip one future visit of a series. Only completed visits are billed. */
export async function cancelOccurrence(ctx: Ctx, userId: string, requestId: string, seq: number) {
  return tx(ctx.db, async (c) => {
    const sr = await loadRequestForPatientUser(c, userId, requestId);
    if (TERMINAL.has(sr.status)) throw new AppError('INVALID_TRANSITION', 'This request is closed');
    const occ = await maybeOne(c, `UPDATE visit_occurrences SET status='cancelled', cancelled_reason='patient_skipped' WHERE request_id=$1 AND seq=$2 AND status='scheduled' RETURNING seq`, [sr.id, seq]);
    if (!occ) throw new AppError('NOT_FOUND', 'No upcoming visit with that number');
    const remaining = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM visit_occurrences WHERE request_id=$1 AND status IN ('scheduled','in_progress')`, [sr.id]);
    if (remaining.n === 0) {
      // Nothing left to do: close out the series (or cancel it if nothing was ever done).
      const done = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM visit_occurrences WHERE request_id=$1 AND status='completed'`, [sr.id]);
      if (done.n > 0 && sr.status === 'confirmed') {
        await transition(ctx, c, sr.id, 'completed', { type: 'patient', id: userId }, { reason: 'remaining_visits_skipped' });
        await releaseAssignments(ctx, c, sr.id, 'withdrawn', { keepAccepted: true });
        await settleRequest(ctx, c, sr.id, 'completed');
      } else {
        await transition(ctx, c, sr.id, 'cancelled_by_patient', { type: 'patient', id: userId }, { reason: 'all_visits_skipped' });
        await releaseAssignments(ctx, c, sr.id, 'cancelled');
        await settleRequest(ctx, c, sr.id, 'cancelled');
      }
    }
    return { id: sr.id, seq, status: 'cancelled' };
  });
}

/** Withdraw open offers / cancel accepted assignments and free providers. */
export async function releaseAssignments(ctx: Ctx, c: TxClient, requestId: string, outcome: 'cancelled' | 'withdrawn', opts: { keepAccepted?: boolean } = {}) {
  const rows = await many(
    c,
    `UPDATE request_assignments SET outcome=$2, responded_at=COALESCE(responded_at, now())
     WHERE request_id=$1 AND (outcome='offered' OR (outcome='accepted' AND NOT $3)) RETURNING provider_id`,
    [requestId, outcome, Boolean(opts.keepAccepted)],
  );
  await c.query('UPDATE provider_sessions SET active_job_id=NULL WHERE active_job_id=$1', [requestId]);
  for (const r of rows) {
    c.afterCommit(async () => {
      await ctx.realtime.publish(ctx.realtime.providerChannel(r.provider_id), 'request.cancelled', { request_id: requestId });
      const u = await maybeOne(ctx.db, 'SELECT user_id FROM providers WHERE id=$1', [r.provider_id]);
      if (u) await notify(ctx, u.user_id, 'request_cancelled', {});
    });
  }
}
