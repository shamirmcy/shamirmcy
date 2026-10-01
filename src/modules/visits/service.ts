import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { hmac, numericCode, safeEqualHex } from '../../lib/crypto.js';
import { many, maybeOne, one, tx, type TxClient } from '../../lib/db.js';
import { addMinutes } from '../../lib/time.js';
import { assertAssignedProvider } from '../access.js';
import { transition } from '../requests/state.js';
import { createPayoutLines } from '../commerce/billing.js';
import { settleRequest } from '../commerce/settlement.js';
import { estimateEta } from '../assignment/eta.js';
import { notify } from '../notifications/service.js';
import type { LineItem } from '../catalogue/defs.js';

/** A fresh 4-digit door code for the next visit (hashed for checking, encrypted so the patient app can show it). */
export async function issueVisitCode(ctx: Ctx, c: TxClient, requestId: string) {
  const code = numericCode(4);
  await c.query(
    `INSERT INTO visit_codes (request_id, code_hash, code_enc) VALUES ($1,$2,$3)
     ON CONFLICT (request_id) DO UPDATE SET code_hash=EXCLUDED.code_hash, code_enc=EXCLUDED.code_enc, attempts=0, verified_at=NULL`,
    [requestId, hmac(ctx.config.env.OTP_PEPPER, `${requestId}:${code}`), ctx.cipher.encrypt(code)],
  );
}

/** The visit currently happening, or the next one due. */
async function currentOccurrence(c: TxClient, requestId: string) {
  return maybeOne(
    c,
    `SELECT * FROM visit_occurrences WHERE request_id=$1 AND status IN ('in_progress','scheduled')
     ORDER BY (status='in_progress') DESC, seq LIMIT 1 FOR UPDATE`,
    [requestId],
  );
}

/**
 * "On my way" for a scheduled visit (series visits, or bookings made for later). Holds the provider's
 * active job and starts minutes-only ETA updates for the patient. Immediate visits get this on accept.
 */
export async function onMyWay(ctx: Ctx, providerId: string, requestId: string) {
  const a = await assertAssignedProvider(ctx.db, providerId, requestId);
  if (a.remote || a.role_in_visit === 'remote_supervisor') throw new AppError('FORBIDDEN', 'Remote participants do not travel to the visit');
  return tx(ctx.db, async (c) => {
    const sr = await one(c, 'SELECT * FROM service_requests WHERE id=$1 FOR UPDATE', [requestId]);
    if (sr.status !== 'confirmed') throw new AppError('INVALID_TRANSITION', 'Visit is not waiting for you');
    const s = await one(c, 'SELECT * FROM provider_sessions WHERE provider_id=$1 FOR UPDATE', [providerId]);
    if (!s.on_duty) throw new AppError('NOT_ON_DUTY', 'Go on duty first');
    if (s.active_job_id && s.active_job_id !== requestId) throw new AppError('CONFLICT', 'Finish your current visit first');
    await c.query('UPDATE provider_sessions SET active_job_id=$2 WHERE provider_id=$1', [providerId, requestId]);
    let minutes: number | null = null;
    if (s.last_location) {
      const loc = await one(c, `SELECT ST_Y($1::geography::geometry) AS lat, ST_X($1::geography::geometry) AS lng`, [s.last_location]);
      const addr = await one(c, 'SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM addresses WHERE id=$1', [sr.address_id]);
      minutes = (await estimateEta(ctx, loc, addr)).minutes;
      await c.query('UPDATE service_requests SET eta_minutes=$2, expected_by=$3 WHERE id=$1', [requestId, minutes, addMinutes(new Date(), minutes)]);
    }
    c.afterCommit(() =>
      ctx.realtime.publish(ctx.realtime.patientChannel(sr.booked_by_user_id), 'request.eta', {
        request_id: requestId,
        eta_minutes: minutes,
        expected_by: minutes ? addMinutes(new Date(), minutes).toISOString() : null,
      }),
    );
    return { request_id: requestId, eta_minutes: minutes };
  });
}

/** Provider at the door enters the patient's 4-digit code. Limited attempts; ops alerted on lockout. */
export async function markArrived(ctx: Ctx, providerId: string, requestId: string, code: string) {
  const a = await assertAssignedProvider(ctx.db, providerId, requestId);
  if (a.remote || a.role_in_visit === 'remote_supervisor') throw new AppError('FORBIDDEN', 'Remote participants do not check in at the door');
  return tx(ctx.db, async (c) => {
    const sr = await one(c, 'SELECT status FROM service_requests WHERE id=$1 FOR UPDATE', [requestId]);
    if (sr.status === 'provider_arrived' || sr.status === 'in_progress') return { request_id: requestId, status: sr.status };
    const vc = await maybeOne(c, 'SELECT * FROM visit_codes WHERE request_id=$1 FOR UPDATE', [requestId]);
    if (!vc) throw new AppError('INVALID_TRANSITION', 'Visit is not confirmed');
    if (vc.attempts >= ctx.config.visitCodeMaxAttempts) throw new AppError('VISIT_CODE_LOCKED', 'Too many attempts. KM DocH support will call you.');
    const ok = safeEqualHex(hmac(ctx.config.env.OTP_PEPPER, `${requestId}:${code}`), vc.code_hash);
    if (!ok) {
      await c.query('UPDATE visit_codes SET attempts=attempts+1 WHERE request_id=$1', [requestId]);
      if (vc.attempts + 1 >= ctx.config.visitCodeMaxAttempts) {
        c.afterCommit(() => ctx.realtime.publish('ops', 'visit.code_locked', { request_id: requestId, provider_id: providerId }));
      }
      // Commit the attempt counter, then report the failure.
      return { error: true as const };
    }
    await c.query('UPDATE visit_codes SET verified_at=now() WHERE request_id=$1', [requestId]);
    await c.query('UPDATE service_requests SET eta_minutes=NULL, expected_by=NULL WHERE id=$1', [requestId]);
    // The provider is now on this job (if they weren't already via accept / on-my-way).
    await c.query('UPDATE provider_sessions SET active_job_id=$2 WHERE provider_id=$1 AND active_job_id IS NULL', [providerId, requestId]);
    await transition(ctx, c, requestId, 'provider_arrived', { type: 'provider', id: providerId });
    return { request_id: requestId, status: 'provider_arrived' };
  }).then((r) => {
    if ('error' in r) throw new AppError('VISIT_CODE_INVALID', 'That code does not match. Ask the patient to check the app.');
    return r;
  });
}

export async function startVisit(ctx: Ctx, providerId: string, requestId: string) {
  await assertAssignedProvider(ctx.db, providerId, requestId);
  // First dose under remote supervision: the doctor must actually be on the video before the dose starts.
  const waiting = await maybeOne(
    ctx.db,
    `SELECT 1 FROM video_sessions WHERE request_id=$1 AND purpose='first_dose_monitoring' AND provider_joined_at IS NULL`,
    [requestId],
  );
  if (waiting) throw new AppError('SUPERVISOR_NOT_JOINED', 'Wait for the supervising doctor to join the video before starting the first dose');
  return tx(ctx.db, async (c) => {
    const sr = await transition(ctx, c, requestId, 'in_progress', { type: 'provider', id: providerId });
    const occ = await currentOccurrence(c, requestId);
    if (occ && occ.status === 'scheduled') await c.query(`UPDATE visit_occurrences SET status='in_progress', started_at=now() WHERE id=$1`, [occ.id]);
    return { request_id: requestId, status: sr.status, visit_seq: occ?.seq ?? null };
  });
}

/**
 * Completes the current visit. For a series with visits left, the request returns to `confirmed`
 * with a new door code; otherwise it completes and is settled (final bill, invoice, auto-refund).
 */
export async function completeVisit(ctx: Ctx, providerId: string, requestId: string) {
  const a = await assertAssignedProvider(ctx.db, providerId, requestId);
  if (a.role_in_visit !== 'lead' && !a.remote) {
    // assist providers can complete only if there is no in-person lead
    const lead = await maybeOne(ctx.db, `SELECT 1 FROM request_assignments ra JOIN request_slots rs ON rs.id=ra.slot_id WHERE ra.request_id=$1 AND ra.outcome='accepted' AND ra.role_in_visit='lead' AND NOT rs.remote`, [requestId]);
    if (lead) throw new AppError('FORBIDDEN', 'The lead professional completes the visit');
  }
  return tx(ctx.db, async (c) => {
    const sr = await one(c, 'SELECT * FROM service_requests WHERE id=$1 FOR UPDATE', [requestId]);
    if (sr.status !== 'in_progress') throw new AppError('INVALID_TRANSITION', 'Start the visit before completing it');
    const occ = await currentOccurrence(c, requestId);
    if (!occ) throw new AppError('INVALID_TRANSITION', 'No visit in progress');
    await c.query(`UPDATE visit_occurrences SET status='completed', completed_at=now(), completed_by=$2, started_at=COALESCE(started_at, now()) WHERE id=$1`, [occ.id, providerId]);
    await createPayoutLines(c, requestId, { visitSeq: occ.seq });
    await c.query('UPDATE provider_sessions SET active_job_id=NULL WHERE active_job_id=$1', [requestId]);
    const next = await maybeOne(c, `SELECT seq, scheduled_for FROM visit_occurrences WHERE request_id=$1 AND status='scheduled' ORDER BY seq LIMIT 1`, [requestId]);
    if (next) {
      await issueVisitCode(ctx, c, requestId);
      await transition(ctx, c, requestId, 'confirmed', { type: 'provider', id: providerId }, { completed_visit: occ.seq, next_visit: next.seq });
      return { request_id: requestId, status: 'confirmed', completed_visit: occ.seq, next_visit: { seq: next.seq, scheduled_for: next.scheduled_for } };
    }
    await transition(ctx, c, requestId, 'completed', { type: 'provider', id: providerId });
    await createPayoutLines(c, requestId, { final: true });
    const settled = await settleRequest(ctx, c, requestId, 'completed');
    const inv = await maybeOne(c, `SELECT number FROM invoices WHERE target_type='service_request' AND target_id=$1`, [requestId]);
    return { request_id: requestId, status: 'completed', completed_visit: occ.seq, final_total_paise: settled.final_total_paise, invoice_number: inv?.number ?? null };
  });
}

/**
 * Actual cost of estimated items (IV kit "up to ₹600", dressing materials "~₹120"), recorded by the
 * visiting professional. Capped at the quoted amount; the patient is billed the lower figure at settlement.
 */
export async function recordActuals(ctx: Ctx, providerId: string, requestId: string, items: Array<{ option_code: string; actual_paise: number; note?: string }>) {
  await assertAssignedProvider(ctx.db, providerId, requestId);
  return tx(ctx.db, async (c) => {
    const sr = await one(c, 'SELECT line_items, settled_at, status FROM service_requests WHERE id=$1 FOR UPDATE', [requestId]);
    if (sr.settled_at) throw new AppError('CONFLICT', 'This visit has already been billed');
    if (!['provider_arrived', 'in_progress', 'confirmed'].includes(sr.status)) throw new AppError('INVALID_TRANSITION', 'Record costs during the visit');
    const lines = sr.line_items as LineItem[];
    const out = [];
    for (const it of items) {
      const li = lines.find((l) => l.option_code === it.option_code);
      if (!li || !li.estimate) throw new AppError('VALIDATION_ERROR', `${it.option_code} is not an estimated item on this visit`);
      if (it.actual_paise > li.amount_paise) {
        throw new AppError('VALIDATION_ERROR', `Actual cost cannot exceed the quoted ${li.amount_paise} paise; KM DocH absorbs any excess`, { option_code: it.option_code, quoted_paise: li.amount_paise });
      }
      await c.query(
        `INSERT INTO request_adjustments (request_id, option_code, quoted_paise, actual_paise, note, recorded_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (request_id, option_code) DO UPDATE SET actual_paise=EXCLUDED.actual_paise, note=EXCLUDED.note, recorded_by=EXCLUDED.recorded_by`,
        [requestId, it.option_code, li.amount_paise, it.actual_paise, it.note ?? null, providerId],
      );
      out.push({ option_code: it.option_code, quoted_paise: li.amount_paise, actual_paise: it.actual_paise });
    }
    return { request_id: requestId, adjustments: out };
  });
}

/**
 * A provider can't make a confirmed visit. Their assignment is cancelled and the visit goes back to
 * `assigning` (the engine never re-offers it to them). Frequent cancellers are flagged to ops.
 */
export async function cancelByProvider(ctx: Ctx, providerId: string, requestId: string, reason: string) {
  await assertAssignedProvider(ctx.db, providerId, requestId);
  const out = await tx(ctx.db, async (c) => {
    const sr = await one(c, 'SELECT * FROM service_requests WHERE id=$1 FOR UPDATE', [requestId]);
    if (sr.status !== 'confirmed') {
      throw new AppError('INVALID_TRANSITION', sr.status === 'provider_arrived' || sr.status === 'in_progress' ? 'The visit has started; call the partner desk' : 'This visit cannot be cancelled now');
    }
    const asg = await one(
      c,
      `UPDATE request_assignments SET outcome='cancelled', responded_at=now() WHERE request_id=$1 AND provider_id=$2 AND outcome='accepted' RETURNING slot_id`,
      [requestId, providerId],
    );
    await c.query('UPDATE request_slots SET filled_by_provider_id=NULL WHERE id=$1', [asg.slot_id]);
    await c.query('UPDATE provider_sessions SET active_job_id=NULL WHERE provider_id=$1 AND active_job_id=$2', [providerId, requestId]);
    await c.query(`UPDATE video_sessions SET ends_at=now() WHERE request_id=$1 AND provider_id=$2`, [requestId, providerId]);
    await c.query('UPDATE service_requests SET eta_minutes=NULL, expected_by=NULL WHERE id=$1', [requestId]);
    await c.query('INSERT INTO provider_cancellations (request_id, provider_id, reason) VALUES ($1,$2,$3)', [requestId, providerId, reason]);
    await transition(ctx, c, requestId, 'assigning', { type: 'provider', id: providerId }, { cancelled_by_provider: providerId, reason });
    const recent = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM provider_cancellations WHERE provider_id=$1 AND created_at > now() - interval '30 days'`, [providerId]);
    return { sr, recent: recent.n };
  });
  await notify(ctx, out.sr.booked_by_user_id, 'provider_cancelled', {});
  if (out.recent >= 3) await ctx.realtime.publish('ops', 'provider.frequent_cancellations', { provider_id: providerId, last_30_days: out.recent });
  await ctx.jobs.enqueue('assignment.run', { requestId });
  return { request_id: requestId, status: 'cancelled', reassigning: true };
}

/**
 * Job (hourly): scheduled visits more than 6 hours overdue are marked missed (not billed) and ops is told.
 * A series with nothing left is closed: completed if any visit happened, otherwise failed.
 */
export async function sweepMissedVisits(ctx: Ctx) {
  const missed = await many(
    ctx.db,
    `UPDATE visit_occurrences o SET status='missed' FROM service_requests sr
     WHERE sr.id=o.request_id AND o.status='scheduled' AND o.scheduled_for < now() - interval '6 hours' AND sr.status='confirmed'
     RETURNING o.request_id, o.seq`,
  );
  const requests = [...new Set(missed.map((m) => m.request_id as string))];
  for (const m of missed) await ctx.realtime.publish('ops', 'visit.missed', { request_id: m.request_id, seq: m.seq });
  for (const id of requests) {
    await tx(ctx.db, async (c) => {
      const o = await one(
        c,
        `SELECT count(*) FILTER (WHERE status IN ('scheduled','in_progress'))::int AS open, count(*) FILTER (WHERE status='completed')::int AS done FROM visit_occurrences WHERE request_id=$1`,
        [id],
      );
      if (o.open > 0) return;
      const sr = await one(c, 'SELECT status FROM service_requests WHERE id=$1 FOR UPDATE', [id]);
      if (sr.status !== 'confirmed') return;
      await c.query('UPDATE provider_sessions SET active_job_id=NULL WHERE active_job_id=$1', [id]);
      if (o.done > 0) {
        await transition(ctx, c, id, 'completed', { type: 'system' }, { reason: 'remaining_visits_missed' });
        await createPayoutLines(c, id, { final: true });
        await settleRequest(ctx, c, id, 'completed');
      } else {
        await transition(ctx, c, id, 'failed', { type: 'system' }, { reason: 'all_visits_missed' });
        await settleRequest(ctx, c, id, 'cancelled');
      }
    });
  }
  return missed.length;
}

export async function recordVideoJoin(ctx: Ctx, providerId: string, requestId: string) {
  await assertAssignedProvider(ctx.db, providerId, requestId);
  const v = await maybeOne(
    ctx.db,
    `UPDATE video_sessions SET provider_joined_at = COALESCE(provider_joined_at, now()) WHERE request_id=$1 AND provider_id=$2 RETURNING *`,
    [requestId, providerId],
  );
  if (!v) throw new AppError('NOT_FOUND', 'No video session for this visit');
  const token = await ctx.adapters.video.joinToken(v.room_id, providerId, 'host');
  return { room_id: v.room_id, join_token: token, purpose: v.purpose, provider_joined_at: v.provider_joined_at };
}
