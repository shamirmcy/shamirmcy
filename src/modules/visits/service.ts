import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { hmac, safeEqualHex } from '../../lib/crypto.js';
import { maybeOne, one, tx } from '../../lib/db.js';
import { assertAssignedProvider } from '../access.js';
import { transition } from '../requests/state.js';
import { createPayoutLines, issueInvoice } from '../commerce/billing.js';

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
    return { request_id: requestId, status: sr.status };
  });
}

export async function completeVisit(ctx: Ctx, providerId: string, requestId: string) {
  const a = await assertAssignedProvider(ctx.db, providerId, requestId);
  if (a.role_in_visit !== 'lead' && !a.remote) {
    // assist providers can complete only if there is no in-person lead
    const lead = await maybeOne(ctx.db, `SELECT 1 FROM request_assignments ra JOIN request_slots rs ON rs.id=ra.slot_id WHERE ra.request_id=$1 AND ra.outcome='accepted' AND ra.role_in_visit='lead' AND NOT rs.remote`, [requestId]);
    if (lead) throw new AppError('FORBIDDEN', 'The lead professional completes the visit');
  }
  return tx(ctx.db, async (c) => {
    const sr = await transition(ctx, c, requestId, 'completed', { type: 'provider', id: providerId });
    await c.query('UPDATE provider_sessions SET active_job_id=NULL WHERE active_job_id=$1', [requestId]);
    await createPayoutLines(c, requestId);
    const inv = await issueInvoice(c, { userId: sr.booked_by_user_id, targetType: 'service_request', targetId: requestId, lineItems: sr.line_items, totalPaise: sr.total_paise });
    return { request_id: requestId, status: sr.status, invoice_number: inv.number };
  });
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
