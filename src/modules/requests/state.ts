import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { maybeOne, one, type TxClient } from '../../lib/db.js';
import { getDef } from '../catalogue/defs.js';
import { hasRequiredConsents } from '../consents/service.js';
import { notify } from '../notifications/service.js';

export const STATUSES = [
  'draft',
  'requested',
  'reviewing',
  'assigning',
  'confirmed',
  'provider_arrived',
  'in_progress',
  'completed',
  'cancelled_by_patient',
  'cancelled_by_provider',
  'no_provider',
  'failed',
] as const;
export type RequestStatus = (typeof STATUSES)[number];

export const TERMINAL: ReadonlySet<RequestStatus> = new Set(['completed', 'cancelled_by_patient', 'cancelled_by_provider', 'no_provider', 'failed']);

/** The only legal status changes. Controllers never write `status` directly. */
const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  draft: ['requested', 'cancelled_by_patient'],
  requested: ['reviewing', 'assigning', 'cancelled_by_patient', 'failed'],
  reviewing: ['assigning', 'cancelled_by_patient', 'failed'],
  assigning: ['confirmed', 'no_provider', 'cancelled_by_patient', 'failed'],
  confirmed: ['provider_arrived', 'in_progress', 'assigning', 'cancelled_by_patient', 'cancelled_by_provider', 'failed'],
  provider_arrived: ['in_progress', 'failed'],
  in_progress: ['completed', 'failed'],
  completed: [],
  cancelled_by_patient: [],
  cancelled_by_provider: [],
  // A request with nobody available can be retried (e.g. "schedule later" or ops manual assignment).
  no_provider: ['assigning', 'cancelled_by_patient'],
  failed: [],
};

export const STATUS_LABEL: Record<RequestStatus, string> = {
  draft: 'Draft',
  requested: 'Request received',
  reviewing: 'Request reviewed',
  assigning: 'Finding your care professional',
  confirmed: 'Confirmed',
  provider_arrived: 'At your door',
  in_progress: 'Visit in progress',
  completed: 'Completed',
  cancelled_by_patient: 'Cancelled',
  cancelled_by_provider: 'Cancelled by provider',
  no_provider: 'No one available right now',
  failed: 'Could not be completed',
};

export interface Actor {
  type: 'patient' | 'provider' | 'system' | 'ops';
  id?: string | null;
}

export function canTransition(from: RequestStatus, to: RequestStatus) {
  return TRANSITIONS[from].includes(to);
}

/** Guards that must hold for specific transitions. */
async function guard(c: TxClient, sr: any, to: RequestStatus) {
  if (sr.status === 'draft' && to === 'requested') {
    if (!(await hasRequiredConsents(c, sr.id, sr.service_code))) throw new AppError('CONSENT_REQUIRED', 'Required consents have not been recorded');
    const def = getDef(sr.service_code);
    if (def.requiresPrescription(sr.options) && !(await hasPrescriptionEvidence(c, sr))) {
      throw new AppError('PRESCRIPTION_REQUIRED', 'Attach a prescription photo or a signed prescription for this service');
    }
  }
}

export async function hasPrescriptionEvidence(c: TxClient, sr: { id: string; prescription_id: string | null; patient_id: string }) {
  const photo = await maybeOne(c, `SELECT 1 FROM request_attachments WHERE request_id=$1 AND kind='prescription_photo'`, [sr.id]);
  if (photo) return true;
  if (!sr.prescription_id) return false;
  const rx = await maybeOne(c, `SELECT 1 FROM prescriptions WHERE id=$1 AND patient_id=$2 AND status='signed'`, [sr.prescription_id, sr.patient_id]);
  return Boolean(rx);
}

/**
 * Single entry point for status changes: row lock → transition table → guards → update →
 * append-only event → post-commit realtime + notifications.
 */
export async function transition(ctx: Ctx, c: TxClient, requestId: string, to: RequestStatus, actor: Actor, meta: Record<string, unknown> = {}) {
  const sr = await maybeOne(c, 'SELECT * FROM service_requests WHERE id=$1 FOR UPDATE', [requestId]);
  if (!sr) throw new AppError('NOT_FOUND', 'Request not found');
  const from = sr.status as RequestStatus;
  if (from === to) return sr;
  if (!canTransition(from, to)) throw new AppError('INVALID_TRANSITION', `Cannot move from ${from} to ${to}`);
  await guard(c, sr, to);
  const updated = await one(c, 'UPDATE service_requests SET status=$2 WHERE id=$1 RETURNING *', [requestId, to]);
  await c.query(`INSERT INTO request_events (request_id, from_status, to_status, actor_type, actor_id, meta) VALUES ($1,$2,$3,$4,$5,$6)`, [
    requestId,
    from,
    to,
    actor.type,
    actor.id ?? null,
    meta,
  ]);
  c.afterCommit(async () => {
    await ctx.realtime.publish(ctx.realtime.patientChannel(sr.booked_by_user_id), 'request.status', {
      request_id: requestId,
      status: to,
      status_label: STATUS_LABEL[to],
    });
    await onEnteredStatus(ctx, updated, from);
  });
  return updated;
}

async function onEnteredStatus(ctx: Ctx, sr: any, from: RequestStatus) {
  const status = sr.status as RequestStatus;
  if (status === 'no_provider') {
    await notify(ctx, sr.booked_by_user_id, 'no_provider', {});
    ctx.log.warn({ request_id: sr.id, service: sr.service_code }, 'no provider available; ops notified');
    await ctx.realtime.publish('ops', 'request.no_provider', { request_id: sr.id, service_code: sr.service_code });
  }
  if (status === 'provider_arrived') await notify(ctx, sr.booked_by_user_id, 'provider_at_door', {}, { urgent: true });
  void from;
}
