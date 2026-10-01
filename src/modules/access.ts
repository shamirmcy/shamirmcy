import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { AppError } from '../lib/errors.js';
import { maybeOne, type Queryable } from '../lib/db.js';

/** Statuses during which an assigned provider may see the patient's shared records. */
const ACTIVE_FOR_PROVIDER = ['confirmed', 'provider_arrived', 'in_progress', 'completed'];

export async function getFamilyLink(db: Queryable, userId: string, patientId: string) {
  return maybeOne(
    db,
    `SELECT fl.* FROM family_links fl JOIN patients p ON p.id = fl.patient_id
     WHERE fl.account_holder_id=$1 AND fl.patient_id=$2 AND fl.deleted_at IS NULL AND p.deleted_at IS NULL`,
    [userId, patientId],
  );
}

/** Booking on behalf of a patient requires a family link with can_book. */
export async function assertCanBook(db: Queryable, userId: string, patientId: string) {
  const link = await getFamilyLink(db, userId, patientId);
  if (!link || !link.can_book) throw new AppError('FORBIDDEN', 'You cannot book for this patient');
  return link;
}

export async function selfPatientId(db: Queryable, userId: string): Promise<string> {
  const p = await maybeOne(db, 'SELECT id FROM patients WHERE user_id=$1 AND deleted_at IS NULL', [userId]);
  if (!p) throw new AppError('NOT_FOUND', 'Patient profile not found');
  return p.id;
}

export async function logRecordAccess(
  ctx: Ctx,
  e: { actorUserId: string; patientId: string; resourceType: string; resourceId?: string | null; outcome: 'allowed' | 'denied'; reason?: string; ip?: string },
) {
  await ctx.db.query(
    `INSERT INTO record_access_log (actor_user_id, patient_id, resource_type, resource_id, outcome, reason, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.actorUserId, e.patientId, e.resourceType, e.resourceId ?? null, e.outcome, e.reason ?? null, e.ip ?? null],
  );
}

/**
 * Gate for every clinical-record read. Allowed:
 *  - patient-app users with a family link that has can_view_records (self links always do)
 *  - providers assigned to a visit for this patient whose share_records consent is still in force
 * Every decision — allowed or denied — is written to record_access_log.
 */
export async function assertRecordAccess(ctx: Ctx, req: FastifyRequest, patientId: string, resourceType: string, resourceId?: string | null) {
  let allowed = false;
  let reason = 'no_grant';
  if (req.auth.app === 'patient') {
    const link = await getFamilyLink(ctx.db, req.auth.userId, patientId);
    allowed = Boolean(link?.can_view_records);
    reason = link ? (allowed ? 'family_link' : 'can_view_records_false') : 'no_family_link';
  } else if (req.auth.app === 'provider' && req.auth.providerId) {
    allowed = await providerHasCareRelationship(ctx.db, req.auth.providerId, patientId);
    reason = allowed ? 'assigned_with_consent' : 'not_assigned_or_consent_withdrawn';
  } else if (req.auth.app === 'ops') {
    reason = 'ops_has_no_clinical_access';
  }
  await logRecordAccess(ctx, { actorUserId: req.auth.userId, patientId, resourceType, resourceId, outcome: allowed ? 'allowed' : 'denied', reason, ip: req.ip });
  if (!allowed) throw new AppError('FORBIDDEN', 'You do not have access to these records');
}

export async function providerHasCareRelationship(db: Queryable, providerId: string, patientId: string): Promise<boolean> {
  const r = await maybeOne(
    db,
    `SELECT 1 FROM request_assignments ra
     JOIN service_requests sr ON sr.id = ra.request_id
     JOIN consents c ON c.request_id = sr.id AND c.template_key = 'share_records' AND c.withdrawn_at IS NULL
     WHERE ra.provider_id=$1 AND sr.patient_id=$2 AND ra.outcome='accepted'
       AND sr.status = ANY($3) AND sr.updated_at > now() - interval '30 days'
     LIMIT 1`,
    [providerId, patientId, ACTIVE_FOR_PROVIDER],
  );
  return Boolean(r);
}

/** The accepted assignment of this provider on this request, or 403. */
export async function assertAssignedProvider(db: Queryable, providerId: string, requestId: string) {
  const a = await maybeOne(
    db,
    `SELECT ra.*, rs.remote FROM request_assignments ra JOIN request_slots rs ON rs.id = ra.slot_id
     WHERE ra.request_id=$1 AND ra.provider_id=$2 AND ra.outcome='accepted'`,
    [requestId, providerId],
  );
  if (!a) throw new AppError('FORBIDDEN', 'You are not assigned to this visit');
  return a;
}
