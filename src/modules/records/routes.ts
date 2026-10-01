import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { many } from '../../lib/db.js';
import { typed, Uuid } from '../../lib/http.js';
import { requireApp } from '../../plugins/auth.js';
import { assertRecordAccess, selfPatientId } from '../access.js';
import { decryptConsultation } from '../clinical/service.js';
import { STATUS_LABEL, type RequestStatus } from '../requests/state.js';

const ACTIVE = {
  service_request: ['draft', 'requested', 'reviewing', 'assigning', 'confirmed', 'provider_arrived', 'in_progress'],
  pharmacy_order: ['placed', 'pending_verification', 'verified', 'packed', 'out_for_delivery'],
  equipment_rental: ['requested', 'confirmed', 'delivered', 'active'],
  ambulance_run: ['requested', 'dispatched', 'acknowledged', 'arrived', 'transporting', 'unassigned'],
};
const COMPLETED = {
  service_request: ['completed'],
  pharmacy_order: ['delivered'],
  equipment_rental: ['returned'],
  ambulance_run: ['completed'],
};

export default async function recordRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);

  app.get('/health-records', { schema: { tags: ['records'], querystring: z.object({ patient_id: Uuid.optional() }) } }, async (req) => {
    const patientId = req.query.patient_id ?? (await selfPatientId(ctx.db, req.auth.userId));
    await assertRecordAccess(ctx, req, patientId, 'health_records');
    const consultations = await many(ctx.db, 'SELECT * FROM consultations WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 200', [patientId]);
    const decrypted = consultations.map((c) => decryptConsultation(ctx, c, req.auth.providerId));
    const vitalsTrend = decrypted
      .filter((c) => c.vitals)
      .map((c) => ({ at: c.created_at, ...c.vitals }))
      .reverse();
    const prescriptions = await many(
      ctx.db,
      `SELECT p.id, p.version, p.status, p.mode, p.signed_at, p.supersedes_id, u.name AS prescriber_name
       FROM prescriptions p JOIN providers pr ON pr.id=p.prescriber_id JOIN users u ON u.id=pr.user_id
       WHERE p.patient_id=$1 AND p.status <> 'draft' ORDER BY p.signed_at DESC`,
      [patientId],
    );
    const labs = await many(
      ctx.db,
      `SELECT lr.id, lr.lab_order_id, lr.values_enc, lr.report_key, lr.reported_at, lo.tests
       FROM lab_results lr JOIN lab_orders lo ON lo.id=lr.lab_order_id WHERE lr.patient_id=$1 ORDER BY lr.reported_at DESC`,
      [patientId],
    );
    return {
      patient_id: patientId,
      vitals_trend: vitalsTrend,
      consultations: decrypted,
      prescriptions,
      lab_reports: await Promise.all(
        labs.map(async (l) => ({
          id: l.id,
          lab_order_id: l.lab_order_id,
          tests: l.tests,
          values: ctx.cipher.decryptJson(l.values_enc, []),
          report_url: l.report_key ? await ctx.adapters.storage.presignGet(l.report_key) : null,
          reported_at: l.reported_at,
        })),
      ),
    };
  });

  /** One list across visits, tests, medicines, rentals and ambulance for every patient the user can book for. */
  app.get('/orders', { schema: { tags: ['records'], querystring: z.object({ filter: z.enum(['all', 'active', 'completed']).default('all') }) } }, async (req) => {
    requireApp(req, 'patient');
    const pick = (kind: keyof typeof ACTIVE) => (req.query.filter === 'active' ? ACTIVE[kind] : req.query.filter === 'completed' ? COMPLETED[kind] : null);
    const uid = req.auth.userId;
    const patients = `(SELECT patient_id FROM family_links WHERE account_holder_id=$1 AND deleted_at IS NULL AND can_book)`;
    const rows = await many(
      ctx.db,
      `SELECT 'service_request' AS kind, sr.id, s.name AS title, sr.status, sr.total_paise, sr.patient_id, sr.created_at
         FROM service_requests sr JOIN services s ON s.code=sr.service_code
         WHERE (sr.booked_by_user_id=$1 OR sr.patient_id IN ${patients}) AND ($2::text[] IS NULL OR sr.status = ANY($2))
       UNION ALL
       SELECT 'pharmacy_order', o.id, 'Medicines', o.status, o.total_paise, o.patient_id, o.created_at FROM pharmacy_orders o
         WHERE (o.booked_by_user_id=$1 OR o.patient_id IN ${patients}) AND ($3::text[] IS NULL OR o.status = ANY($3))
       UNION ALL
       SELECT 'equipment_rental', r.id, initcap(replace(r.item,'_',' ')) || ' rental', r.status, r.total_paise, r.patient_id, r.created_at FROM equipment_rentals r
         WHERE (r.booked_by_user_id=$1 OR r.patient_id IN ${patients}) AND ($4::text[] IS NULL OR r.status = ANY($4))
       UNION ALL
       SELECT 'ambulance_run', a.id, initcap(a.type) || ' ambulance', a.status, a.total_paise, a.patient_id, a.created_at FROM ambulance_runs a
         WHERE a.requested_by_user_id=$1 AND ($5::text[] IS NULL OR a.status = ANY($5))
       ORDER BY created_at DESC LIMIT 200`,
      [uid, pick('service_request'), pick('pharmacy_order'), pick('equipment_rental'), pick('ambulance_run')],
    );
    return {
      filter: req.query.filter,
      orders: rows.map((r) => ({ ...r, status_label: r.kind === 'service_request' ? STATUS_LABEL[r.status as RequestStatus] : r.status })),
    };
  });
}
