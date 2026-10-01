import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, maybeOne, one } from '../../lib/db.js';
import { IdParams, typed } from '../../lib/http.js';
import { requireApp } from '../../plugins/auth.js';
import { transcribePage } from '../clinical/service.js';
import { updatePharmacyStatus, verifyPharmacyOrder } from '../commerce/service.js';
import { notify } from '../notifications/service.js';

async function membership(ctx: Ctx, req: FastifyRequest, kind: 'pharmacy' | 'lab' | 'equipment' | 'ambulance', memberRoles?: string[]) {
  requireApp(req, 'partner');
  const m = await maybeOne(
    ctx.db,
    `SELECT pm.partner_id, pm.member_role FROM partner_members pm JOIN partners p ON p.id=pm.partner_id WHERE pm.user_id=$1 AND p.kind=$2 AND p.active`,
    [req.auth.userId, kind],
  );
  if (!m || (memberRoles && !memberRoles.includes(m.member_role))) throw new AppError('FORBIDDEN', `Requires ${kind} partner${memberRoles ? ' ' + memberRoles.join('/') : ''}`);
  return m as { partner_id: string; member_role: string };
}

const LatLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const RxItem = z.object({ drug: z.string().min(1).max(120), strength: z.string().max(40).optional(), pattern: z.string().max(20).optional(), days: z.number().int().optional(), timing: z.string().max(40).optional(), sos: z.boolean().optional(), instructions: z.string().max(300).optional() });

export default async function partnerRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);

  // ── Pharmacy ──
  app.get('/partner/pharmacy-orders', { schema: { tags: ['partner'] } }, async (req) => {
    const m = await membership(ctx, req, 'pharmacy');
    return { orders: await many(ctx.db, `SELECT id, status, requires_rx, prescription_id, total_paise, created_at FROM pharmacy_orders WHERE pharmacy_partner_id=$1 AND status NOT IN ('delivered','cancelled','rejected') ORDER BY created_at`, [m.partner_id]) };
  });

  app.post('/partner/pharmacy-orders/:id/verify', { schema: { tags: ['partner'], params: IdParams, body: z.object({ approve: z.boolean() }) } }, async (req) => {
    const m = await membership(ctx, req, 'pharmacy', ['pharmacist']);
    return verifyPharmacyOrder(ctx, m.partner_id, req.auth.userId, req.params.id, req.body.approve);
  });

  app.post('/partner/pharmacy-orders/:id/status', { schema: { tags: ['partner'], params: IdParams, body: z.object({ status: z.enum(['packed', 'out_for_delivery', 'delivered', 'cancelled']) }) } }, async (req) => {
    const m = await membership(ctx, req, 'pharmacy');
    return updatePharmacyStatus(ctx, m.partner_id, req.params.id, req.body.status);
  });

  app.post('/partner/pharmacy-orders/:id/location', { schema: { tags: ['partner'], params: IdParams, body: LatLng } }, async (req) => {
    const m = await membership(ctx, req, 'pharmacy');
    const o = await maybeOne(
      ctx.db,
      `UPDATE pharmacy_orders SET courier_location=ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, courier_location_at=now()
       WHERE id=$1 AND pharmacy_partner_id=$2 AND status='out_for_delivery' RETURNING booked_by_user_id`,
      [req.params.id, m.partner_id, req.body.lng, req.body.lat],
    );
    if (!o) throw new AppError('NOT_FOUND', 'Order not out for delivery');
    await ctx.realtime.publish(ctx.realtime.patientChannel(o.booked_by_user_id), 'delivery.location', { order_id: req.params.id, lat: req.body.lat, lng: req.body.lng });
    return { ok: true };
  });

  /** Pharmacist transcription of photo prescriptions (step 3 of the photo flow). */
  app.get('/partner/transcriptions', { schema: { tags: ['partner'] } }, async (req) => {
    await membership(ctx, req, 'pharmacy', ['pharmacist']);
    const rows = await many(
      ctx.db,
      `SELECT pp.prescription_id, pp.page_no, pp.blob_key, pp.quality_status FROM prescription_photos pp JOIN prescriptions p ON p.id=pp.prescription_id
       WHERE pp.transcribed_at IS NULL AND pp.quality_status='ok' AND p.status <> 'superseded' ORDER BY pp.created_at LIMIT 50`,
    );
    return { pages: await Promise.all(rows.map(async (r) => ({ prescription_id: r.prescription_id, page_no: r.page_no, url: await ctx.adapters.storage.presignGet(r.blob_key) }))) };
  });

  app.post(
    '/partner/prescriptions/:id/transcription',
    { schema: { tags: ['partner'], params: IdParams, body: z.object({ page_no: z.number().int().min(1).max(5), items: z.array(RxItem).min(1).max(30) }) } },
    async (req) => {
      await membership(ctx, req, 'pharmacy', ['pharmacist']);
      return transcribePage(ctx, req.auth.userId, req.params.id, req.body.page_no, req.body.items);
    },
  );

  // ── Lab ──
  app.post(
    '/partner/lab-orders/:id/results',
    {
      schema: {
        tags: ['partner'],
        params: IdParams,
        body: z.object({
          values: z.array(z.object({ test: z.string(), analyte: z.string(), value: z.union([z.number(), z.string()]), unit: z.string().optional(), ref_low: z.number().optional(), ref_high: z.number().optional(), flag: z.enum(['low', 'normal', 'high', 'critical']).optional() })).min(1),
          report_key: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const m = await membership(ctx, req, 'lab');
      const lo = await maybeOne(ctx.db, 'SELECT lo.*, sr.booked_by_user_id FROM lab_orders lo JOIN service_requests sr ON sr.id=lo.request_id WHERE lo.id=$1 AND (lo.lab_partner_id IS NULL OR lo.lab_partner_id=$2)', [req.params.id, m.partner_id]);
      if (!lo) throw new AppError('NOT_FOUND', 'Lab order not found');
      const values = req.body.values.map((v) => ({ ...v, flag: v.flag ?? flagFor(v) }));
      const r = await one(ctx.db, 'INSERT INTO lab_results (lab_order_id, patient_id, values_enc, report_key) VALUES ($1,$2,$3,$4) RETURNING id', [lo.id, lo.patient_id, ctx.cipher.encryptJson(values), req.body.report_key ?? null]);
      await ctx.db.query(`UPDATE lab_orders SET status='reported', lab_partner_id=$2 WHERE id=$1`, [lo.id, m.partner_id]);
      await notify(ctx, lo.booked_by_user_id, 'report_ready', {});
      return { id: r.id, lab_order_id: lo.id };
    },
  );

  // ── Equipment ──
  app.get('/partner/rentals', { schema: { tags: ['partner'] } }, async (req) => {
    const m = await membership(ctx, req, 'equipment');
    return { rentals: await many(ctx.db, `SELECT id, item, rate_type, quantity, start_date, end_date, status FROM equipment_rentals WHERE supplier_id=$1 AND status NOT IN ('returned','cancelled') ORDER BY start_date`, [m.partner_id]) };
  });
  app.post('/partner/rentals/:id/status', { schema: { tags: ['partner'], params: IdParams, body: z.object({ status: z.enum(['confirmed', 'delivered', 'active', 'returned', 'cancelled']) }) } }, async (req) => {
    const m = await membership(ctx, req, 'equipment');
    const r = await maybeOne(ctx.db, 'UPDATE equipment_rentals SET status=$3 WHERE id=$1 AND supplier_id=$2 RETURNING id, status', [req.params.id, m.partner_id, req.body.status]);
    if (!r) throw new AppError('NOT_FOUND', 'Rental not found');
    return r;
  });

  // ── Ambulance crew ──
  app.post('/partner/vehicles/:id/location', { schema: { tags: ['partner'], params: IdParams, body: LatLng.extend({ available: z.boolean().optional() }) } }, async (req) => {
    const m = await membership(ctx, req, 'ambulance');
    const v = await maybeOne(
      ctx.db,
      `UPDATE ambulance_vehicles SET location=ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, location_at=now(), available=COALESCE($5, available)
       WHERE id=$1 AND partner_id=$2 RETURNING id`,
      [req.params.id, m.partner_id, req.body.lng, req.body.lat, req.body.available ?? null],
    );
    if (!v) throw new AppError('NOT_FOUND', 'Vehicle not found');
    const run = await maybeOne(ctx.db, `SELECT id, requested_by_user_id FROM ambulance_runs WHERE vehicle_id=$1 AND status IN ('dispatched','acknowledged','arrived','transporting') ORDER BY created_at DESC LIMIT 1`, [v.id]);
    if (run) await ctx.realtime.publish(ctx.realtime.patientChannel(run.requested_by_user_id), 'ambulance.location', { run_id: run.id, lat: req.body.lat, lng: req.body.lng });
    return { ok: true };
  });

  app.post('/partner/ambulance-runs/:id/ack', { schema: { tags: ['partner'], params: IdParams } }, async (req) => {
    const m = await membership(ctx, req, 'ambulance');
    const r = await maybeOne(
      ctx.db,
      `UPDATE ambulance_runs a SET acknowledged_at=COALESCE(acknowledged_at, now()), status=CASE WHEN status='dispatched' THEN 'acknowledged' ELSE status END
       FROM ambulance_vehicles v WHERE a.id=$1 AND v.id=a.vehicle_id AND v.partner_id=$2 RETURNING a.id, a.status, a.requested_by_user_id`,
      [req.params.id, m.partner_id],
    );
    if (!r) throw new AppError('NOT_FOUND', 'Run not found');
    await ctx.realtime.publish(ctx.realtime.patientChannel(r.requested_by_user_id), 'order.status', { kind: 'ambulance_run', id: r.id, status: r.status });
    return { id: r.id, status: r.status };
  });

  app.post(
    '/partner/ambulance-runs/:id/status',
    { schema: { tags: ['partner'], params: IdParams, body: z.object({ status: z.enum(['arrived', 'transporting', 'completed', 'cancelled']), km: z.number().min(0).max(1000).optional() }) } },
    async (req) => {
      const m = await membership(ctx, req, 'ambulance');
      const r = await maybeOne(
        ctx.db,
        `UPDATE ambulance_runs a SET status=$3, km=COALESCE($4, km),
           total_paise = CASE WHEN $3='completed' THEN round(per_km_rate_paise * COALESCE($4, km, estimated_km, 0))::int ELSE total_paise END
         FROM ambulance_vehicles v WHERE a.id=$1 AND v.id=a.vehicle_id AND v.partner_id=$2 RETURNING a.id, a.status, a.vehicle_id, a.requested_by_user_id, a.total_paise`,
        [req.params.id, m.partner_id, req.body.status, req.body.km ?? null],
      );
      if (!r) throw new AppError('NOT_FOUND', 'Run not found');
      if (['completed', 'cancelled'].includes(r.status)) await ctx.db.query('UPDATE ambulance_vehicles SET available=true WHERE id=$1', [r.vehicle_id]);
      await ctx.realtime.publish(ctx.realtime.patientChannel(r.requested_by_user_id), 'order.status', { kind: 'ambulance_run', id: r.id, status: r.status });
      return { id: r.id, status: r.status, total_paise: r.total_paise };
    },
  );
}

function flagFor(v: { value: number | string; ref_low?: number; ref_high?: number }) {
  if (typeof v.value !== 'number') return undefined;
  if (v.ref_low !== undefined && v.value < v.ref_low) return 'low' as const;
  if (v.ref_high !== undefined && v.value > v.ref_high) return 'high' as const;
  return v.ref_low !== undefined || v.ref_high !== undefined ? ('normal' as const) : undefined;
}
