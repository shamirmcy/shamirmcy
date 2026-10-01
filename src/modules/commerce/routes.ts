import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, maybeOne } from '../../lib/db.js';
import { IdParams, typed, Uuid } from '../../lib/http.js';
import { requireApp } from '../../plugins/auth.js';
import { getFamilyLink } from '../access.js';
import { ambulanceTracking, createAmbulanceRun, createPayment, createPharmacyOrder, createRental, escalation, handlePaymentWebhook } from './service.js';

export default async function commerceRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);

  app.get('/medicines', { schema: { tags: ['pharmacy'], querystring: z.object({ q: z.string().min(2).max(60) }) } }, async (req) => ({
    medicines: await many(ctx.db, `SELECT sku, name, strength, form, schedule, mrp_paise FROM medicines WHERE active AND name ILIKE $1 ORDER BY name LIMIT 30`, [`%${req.query.q}%`]),
  }));

  app.post(
    '/pharmacy-orders',
    {
      config: { idempotent: true },
      schema: {
        tags: ['pharmacy'],
        body: z.object({
          patient_id: Uuid,
          address_id: Uuid,
          items: z.array(z.object({ sku: z.string(), qty: z.number().int().min(1).max(100) })).min(1).max(50),
          prescription_id: Uuid.optional(),
        }),
      },
    },
    async (req, reply) => {
      requireApp(req, 'patient');
      return reply.code(201).send(await createPharmacyOrder(ctx, req.auth.userId, req.body));
    },
  );

  /** Live map allowed for medicine delivery. */
  app.get('/pharmacy-orders/:id/tracking', { schema: { tags: ['pharmacy'], params: IdParams } }, async (req) => {
    requireApp(req, 'patient');
    const o = await maybeOne(
      ctx.db,
      `SELECT o.*, ST_Y(o.courier_location::geometry) AS clat, ST_X(o.courier_location::geometry) AS clng FROM pharmacy_orders o WHERE o.id=$1`,
      [req.params.id],
    );
    if (!o || (o.booked_by_user_id !== req.auth.userId && !(await getFamilyLink(ctx.db, req.auth.userId, o.patient_id)))) throw new AppError('NOT_FOUND', 'Order not found');
    const items = await many(ctx.db, 'SELECT name, qty, unit_price_paise, line_total_paise FROM pharmacy_order_items WHERE order_id=$1', [o.id]);
    return {
      id: o.id,
      status: o.status,
      requires_rx: o.requires_rx,
      total_paise: o.total_paise,
      items,
      live_location: o.status === 'out_for_delivery' && o.clat != null ? { lat: o.clat, lng: o.clng, at: o.courier_location_at } : null,
    };
  });

  app.post(
    '/equipment-rentals',
    {
      config: { idempotent: true },
      schema: { tags: ['equipment'], body: z.object({ quote_token: z.string(), patient_id: Uuid, address_id: Uuid, start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }) },
    },
    async (req, reply) => {
      requireApp(req, 'patient');
      return reply.code(201).send(await createRental(ctx, req.auth.userId, req.body));
    },
  );

  // Emergency: any signed-in user (patient app) can call this; account flags are deliberately not checked.
  app.post(
    '/ambulance-requests',
    {
      config: { idempotent: true },
      schema: {
        tags: ['ambulance'],
        body: z
          .object({
            type: z.enum(['normal', 'oxygen', 'ventilator']).default('normal'),
            patient_id: Uuid.optional(),
            pickup: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
            address_id: Uuid.optional(),
            destination_facility_id: Uuid.optional(),
            payment_method: z.enum(['upi', 'card', 'cash']).optional(),
          })
          .refine((b) => b.pickup || b.address_id, 'pickup or address_id is required'),
      },
    },
    async (req, reply) => reply.code(201).send(await createAmbulanceRun(ctx, req.auth.userId, req.body)),
  );

  app.get('/ambulance-requests/:id/tracking', { schema: { tags: ['ambulance'], params: IdParams } }, async (req) => ambulanceTracking(ctx, req.auth.userId, req.params.id));

  app.post('/ambulance-requests/:id/escalate-108', { schema: { tags: ['ambulance'], params: IdParams } }, async (req) => {
    const r = await maybeOne(ctx.db, 'UPDATE ambulance_runs SET escalated_to_108=true WHERE id=$1 AND requested_by_user_id=$2 RETURNING id', [req.params.id, req.auth.userId]);
    if (!r) throw new AppError('NOT_FOUND', 'Ambulance request not found');
    await ctx.realtime.publish('ops', 'ambulance.escalated_108', { run_id: r.id });
    return { id: r.id, escalated_to_108: true, escalation_108: escalation(ctx) };
  });

  app.post(
    '/payments',
    {
      config: { idempotent: true },
      schema: {
        tags: ['payments'],
        body: z.object({ target_type: z.enum(['service_request', 'pharmacy_order', 'equipment_rental', 'ambulance_run']), target_id: Uuid, method: z.enum(['upi', 'card', 'cash']) }),
      },
    },
    async (req, reply) => reply.code(201).send(await createPayment(ctx, req.auth.userId, req.body)),
  );

  app.get('/invoices/:id', { schema: { tags: ['payments'], params: IdParams } }, async (req) => {
    const inv = await maybeOne(ctx.db, 'SELECT * FROM invoices WHERE id=$1 AND user_id=$2', [req.params.id, req.auth.userId]);
    if (!inv) throw new AppError('NOT_FOUND', 'Invoice not found');
    return inv;
  });

  // Webhook: raw body needed for signature verification, so it gets its own JSON parser.
  await fastify.register(async (scoped) => {
    scoped.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scoped.post('/webhooks/payments', { config: { public: true }, schema: { tags: ['payments'], hide: true } }, async (req) =>
      handlePaymentWebhook(ctx, req.body as string, (req.headers['x-razorpay-signature'] ?? req.headers['x-signature']) as string | undefined),
    );
  });
}
