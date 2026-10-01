import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, maybeOne, one, tx } from '../../lib/db.js';
import { IdParams, typed, Uuid } from '../../lib/http.js';
import { PhoneSchema } from '../../lib/phone.js';
import { requireApp, requireRole } from '../../plugins/auth.js';
import { manualAssign } from '../assignment/engine.js';
import { refundPayment } from '../commerce/service.js';
import { PROVIDER_ROLES } from '../providers/roles.js';
import { transition } from '../requests/state.js';
import { audit } from './audit.js';

const PayoutRule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percent_fee'), fee_bps: z.number().int().min(0).max(10000) }),
  z.object({ type: z.literal('full') }),
  z.object({ type: z.literal('fixed'), provider_paise: z.number().int().min(0) }),
  z.object({ type: z.literal('none') }),
]);
const Localised = z.object({ en: z.string().min(1), ta: z.string().optional(), kn: z.string().optional(), hi: z.string().optional() });

export default async function opsRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);
  app.addHook('preHandler', async (req) => {
    requireApp(req, 'ops');
    requireRole(req, 'ops_admin');
  });

  // ── Verification ──
  app.get('/ops/verification-queue', { schema: { tags: ['ops'] } }, async () => ({
    providers: await many(
      ctx.db,
      `SELECT p.id, u.name, u.phone_e164, p.role, p.reg_type, p.reg_number, p.qualifications, p.created_at,
              (SELECT json_agg(json_build_object('kind', d.kind, 'id', d.id)) FROM provider_documents d WHERE d.provider_id=p.id) AS documents
       FROM providers p JOIN users u ON u.id=p.user_id WHERE p.verification_status='pending' ORDER BY p.created_at`,
    ),
  }));

  app.post(
    '/ops/providers/:id/verification',
    { schema: { tags: ['ops'], params: IdParams, body: z.object({ status: z.enum(['verified', 'suspended', 'pending']), note: z.string().max(500).optional() }) } },
    async (req) => {
      return tx(ctx.db, async (c) => {
        const before = await maybeOne(c, 'SELECT verification_status FROM providers WHERE id=$1 FOR UPDATE', [req.params.id]);
        if (!before) throw new AppError('NOT_FOUND', 'Provider not found');
        await c.query('UPDATE providers SET verification_status=$2 WHERE id=$1', [req.params.id, req.body.status]);
        if (req.body.status === 'suspended') await c.query('UPDATE provider_sessions SET on_duty=false, last_location=NULL WHERE provider_id=$1', [req.params.id]);
        await audit(c, req, 'provider.verification', 'provider', req.params.id, before, { status: req.body.status, note: req.body.note });
        return { id: req.params.id, verification_status: req.body.status };
      });
    },
  );

  app.patch(
    '/ops/providers/:id',
    { schema: { tags: ['ops'], params: IdParams, body: z.object({ service_area_zone_ids: z.array(Uuid).optional(), rating_avg: z.number().min(0).max(5).optional() }) } },
    async (req) => {
      const before = await one(ctx.db, 'SELECT service_area_zone_ids, rating_avg FROM providers WHERE id=$1', [req.params.id]);
      await ctx.db.query('UPDATE providers SET service_area_zone_ids=COALESCE($2,service_area_zone_ids), rating_avg=COALESCE($3,rating_avg) WHERE id=$1', [
        req.params.id,
        req.body.service_area_zone_ids ?? null,
        req.body.rating_avg ?? null,
      ]);
      await audit(ctx.db, req, 'provider.update', 'provider', req.params.id, before, req.body);
      return { id: req.params.id, updated: true };
    },
  );

  // ── Live board & assignment ──
  app.get('/ops/requests/live', { schema: { tags: ['ops'] } }, async () => ({
    requests: await many(
      ctx.db,
      `SELECT sr.id, sr.service_code, sr.status, sr.emergency, sr.created_at, sr.eta_minutes, sr.scheduled_for,
              (SELECT json_agg(json_build_object('slot_id', rs.id, 'role', rs.role, 'role_in_visit', rs.role_in_visit, 'filled_by', rs.filled_by_provider_id)) FROM request_slots rs WHERE rs.request_id=sr.id) AS slots
       FROM service_requests sr WHERE sr.status IN ('requested','reviewing','assigning','confirmed','provider_arrived','in_progress','no_provider')
       ORDER BY sr.emergency DESC, sr.created_at`,
    ),
    ambulances: await many(ctx.db, `SELECT id, type, status, vehicle_id, acknowledged_at, ops_paged_at, created_at FROM ambulance_runs WHERE status NOT IN ('completed','cancelled') ORDER BY created_at`),
  }));

  app.post('/ops/requests/:id/approve', { schema: { tags: ['ops'], params: IdParams } }, async (req) => {
    await tx(ctx.db, async (c) => {
      await transition(ctx, c, req.params.id, 'assigning', { type: 'ops', id: req.auth.userId });
      await audit(c, req, 'request.approve', 'service_request', req.params.id, null, { status: 'assigning' });
      c.afterCommit(() => ctx.jobs.enqueue('assignment.run', { requestId: req.params.id }));
    });
    return { id: req.params.id, status: 'assigning' };
  });

  app.post(
    '/ops/requests/:id/assign',
    { config: { idempotent: true }, schema: { tags: ['ops'], params: IdParams, body: z.object({ slot_id: Uuid, provider_id: Uuid }) } },
    async (req) => {
      const r = await manualAssign(ctx, req.params.id, req.body.slot_id, req.body.provider_id);
      await audit(ctx.db, req, 'request.manual_assign', 'service_request', req.params.id, null, req.body);
      return r;
    },
  );

  // ── Catalogue ──
  app.get('/ops/services', { schema: { tags: ['ops'] } }, async () => ({
    services: await many(ctx.db, `SELECT s.*, (SELECT json_agg(o ORDER BY o.code) FROM service_options o WHERE o.service_id=s.id) AS options FROM services s ORDER BY s.sort_order`),
  }));

  app.patch(
    '/ops/services/:id',
    { schema: { tags: ['ops'], params: IdParams, body: z.object({ name: z.string().optional(), description: z.string().optional(), promised_window_minutes: z.number().int().positive().optional(), active: z.boolean().optional() }) } },
    async (req) => {
      const before = await one(ctx.db, 'SELECT * FROM services WHERE id=$1', [req.params.id]);
      const b = req.body;
      const after = await one(
        ctx.db,
        `UPDATE services SET name=COALESCE($2,name), description=COALESCE($3,description), promised_window_minutes=COALESCE($4,promised_window_minutes), active=COALESCE($5,active) WHERE id=$1 RETURNING *`,
        [req.params.id, b.name ?? null, b.description ?? null, b.promised_window_minutes ?? null, b.active ?? null],
      );
      await audit(ctx.db, req, 'service.update', 'service', req.params.id, before, after);
      return after;
    },
  );

  app.patch(
    '/ops/service-options/:id',
    { schema: { tags: ['ops'], params: IdParams, body: z.object({ name: z.string().optional(), price_paise: z.number().int().min(0).optional(), payout_rule: PayoutRule.optional(), active: z.boolean().optional() }) } },
    async (req) => {
      const before = await maybeOne(ctx.db, 'SELECT * FROM service_options WHERE id=$1', [req.params.id]);
      if (!before) throw new AppError('NOT_FOUND', 'Option not found');
      const b = req.body;
      const after = await one(
        ctx.db,
        `UPDATE service_options SET name=COALESCE($2,name), price_paise=COALESCE($3,price_paise), payout_rule=COALESCE($4,payout_rule), active=COALESCE($5,active) WHERE id=$1 RETURNING *`,
        [req.params.id, b.name ?? null, b.price_paise ?? null, b.payout_rule ? JSON.stringify(b.payout_rule) : null, b.active ?? null],
      );
      await audit(ctx.db, req, 'service_option.update', 'service_option', req.params.id, before, after);
      return after;
    },
  );

  // ── Consents & terms (new versions only; old versions are kept for the record) ──
  app.post(
    '/ops/consent-templates',
    { schema: { tags: ['ops'], body: z.object({ key: z.string().regex(/^[a-z_]+$/), text: Localised, required: z.boolean(), service_codes: z.array(z.string()).nullable().optional() }) } },
    async (req, reply) => {
      const b = req.body;
      const t = await one(
        ctx.db,
        `INSERT INTO consent_templates (key, version, text, required, service_codes)
         VALUES ($1, COALESCE((SELECT max(version) FROM consent_templates WHERE key=$1),0)+1, $2,$3,$4) RETURNING *`,
        [b.key, b.text, b.required, b.service_codes ?? null],
      );
      await audit(ctx.db, req, 'consent_template.publish', 'consent_template', t.id, null, t);
      return reply.code(201).send(t);
    },
  );

  app.post(
    '/ops/provider-terms',
    { schema: { tags: ['ops'], body: z.object({ role: z.enum(PROVIDER_ROLES), items: z.array(z.object({ title: z.string(), text: z.string() })).min(1) }) } },
    async (req, reply) => {
      const t = await one(
        ctx.db,
        `INSERT INTO provider_terms (role, version, items) VALUES ($1, COALESCE((SELECT max(version) FROM provider_terms WHERE role=$1),0)+1, $2) RETURNING *`,
        [req.body.role, JSON.stringify(req.body.items)],
      );
      // New version: providers must re-accept before their next duty session.
      await audit(ctx.db, req, 'provider_terms.publish', 'provider_terms', t.id, null, t);
      return reply.code(201).send(t);
    },
  );

  // ── Bio moderation ──
  app.get('/ops/bios', { schema: { tags: ['ops'], querystring: z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }) } }, async (req) => ({
    bios: await many(ctx.db, `SELECT b.id, b.provider_id, u.name, b.text, b.moderation_status, b.created_at FROM provider_bios b JOIN providers p ON p.id=b.provider_id JOIN users u ON u.id=p.user_id WHERE b.moderation_status=$1 ORDER BY b.created_at`, [req.query.status]),
  }));

  app.post('/ops/bios/:id/moderate', { schema: { tags: ['ops'], params: IdParams, body: z.object({ decision: z.enum(['approved', 'rejected']) }) } }, async (req) => {
    const b = await maybeOne(ctx.db, `UPDATE provider_bios SET moderation_status=$2, moderated_by=$3, moderated_at=now() WHERE id=$1 AND moderation_status='pending' RETURNING id, provider_id`, [
      req.params.id,
      req.body.decision,
      req.auth.userId,
    ]);
    if (!b) throw new AppError('NOT_FOUND', 'Pending bio not found');
    await audit(ctx.db, req, 'bio.moderate', 'provider_bio', b.id, null, { decision: req.body.decision });
    return { id: b.id, moderation_status: req.body.decision };
  });

  // ── Refunds ──
  app.post(
    '/ops/refunds',
    { config: { idempotent: true }, schema: { tags: ['ops'], body: z.object({ payment_id: Uuid, amount_paise: z.number().int().positive(), reason: z.string().min(3).max(500) }) } },
    async (req, reply) => {
      const r = await refundPayment(ctx, req.auth.userId, req.body.payment_id, req.body.amount_paise, req.body.reason);
      await audit(ctx.db, req, 'payment.refund', 'payment', req.body.payment_id, null, { ...req.body, ...r });
      return reply.code(201).send(r);
    },
  );

  // ── Partners, zones, facilities ──
  app.get('/ops/partners', { schema: { tags: ['ops'] } }, async () => ({ partners: await many(ctx.db, 'SELECT * FROM partners ORDER BY kind, name') }));

  app.post(
    '/ops/partners',
    { schema: { tags: ['ops'], body: z.object({ kind: z.enum(['pharmacy', 'lab', 'equipment', 'ambulance']), name: z.string().min(2), licence_no: z.string().min(3), phone: PhoneSchema.optional(), service_area_zone_ids: z.array(Uuid).default([]) }) } },
    async (req, reply) => {
      const b = req.body;
      const p = await one(ctx.db, 'INSERT INTO partners (kind, name, licence_no, phone_e164, service_area_zone_ids) VALUES ($1,$2,$3,$4,$5) RETURNING *', [b.kind, b.name, b.licence_no, b.phone ?? null, b.service_area_zone_ids]);
      await audit(ctx.db, req, 'partner.create', 'partner', p.id, null, p);
      return reply.code(201).send(p);
    },
  );

  app.patch('/ops/partners/:id', { schema: { tags: ['ops'], params: IdParams, body: z.object({ active: z.boolean().optional(), service_area_zone_ids: z.array(Uuid).optional() }) } }, async (req) => {
    const before = await one(ctx.db, 'SELECT * FROM partners WHERE id=$1', [req.params.id]);
    const after = await one(ctx.db, 'UPDATE partners SET active=COALESCE($2,active), service_area_zone_ids=COALESCE($3,service_area_zone_ids) WHERE id=$1 RETURNING *', [
      req.params.id,
      req.body.active ?? null,
      req.body.service_area_zone_ids ?? null,
    ]);
    await audit(ctx.db, req, 'partner.update', 'partner', req.params.id, before, after);
    return after;
  });

  app.post(
    '/ops/partners/:id/members',
    { schema: { tags: ['ops'], params: IdParams, body: z.object({ phone: PhoneSchema, name: z.string().optional(), member_role: z.enum(['staff', 'pharmacist', 'crew', 'manager']) }) } },
    async (req, reply) => {
      const u = await one(ctx.db, `INSERT INTO users (phone_e164, name) VALUES ($1,$2) ON CONFLICT (phone_e164) DO UPDATE SET name=COALESCE(users.name, EXCLUDED.name) RETURNING id`, [
        req.body.phone,
        req.body.name ?? null,
      ]);
      await ctx.db.query('INSERT INTO partner_members (partner_id, user_id, member_role) VALUES ($1,$2,$3) ON CONFLICT (partner_id, user_id) DO UPDATE SET member_role=EXCLUDED.member_role', [
        req.params.id,
        u.id,
        req.body.member_role,
      ]);
      await audit(ctx.db, req, 'partner.member_add', 'partner', req.params.id, null, { user_id: u.id, member_role: req.body.member_role });
      return reply.code(201).send({ partner_id: req.params.id, user_id: u.id });
    },
  );

  app.post(
    '/ops/partners/:id/vehicles',
    { schema: { tags: ['ops'], params: IdParams, body: z.object({ registration_no: z.string().min(4), type: z.enum(['normal', 'oxygen', 'ventilator']) }) } },
    async (req, reply) => {
      const v = await one(ctx.db, 'INSERT INTO ambulance_vehicles (partner_id, registration_no, type) VALUES ($1,$2,$3) RETURNING *', [req.params.id, req.body.registration_no, req.body.type]);
      await audit(ctx.db, req, 'vehicle.create', 'ambulance_vehicle', v.id, null, v);
      return reply.code(201).send(v);
    },
  );

  app.post(
    '/ops/zones',
    {
      schema: {
        tags: ['ops'],
        body: z.object({ name: z.string(), city: z.string(), pincodes: z.array(z.string().regex(/^[1-9]\d{5}$/)).default([]), geojson: z.record(z.string(), z.unknown()).optional() }),
      },
    },
    async (req, reply) => {
      const b = req.body;
      const z1 = await one(
        ctx.db,
        `INSERT INTO service_zones (name, city, pincodes, area) VALUES ($1,$2,$3, CASE WHEN $4::text IS NULL THEN NULL ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4),4326))::geography END) RETURNING id, name, city, pincodes`,
        [b.name, b.city, b.pincodes, b.geojson ? JSON.stringify(b.geojson) : null],
      );
      await audit(ctx.db, req, 'zone.create', 'service_zone', z1.id, null, z1);
      return reply.code(201).send(z1);
    },
  );

  app.put('/ops/config/:key', { schema: { tags: ['ops'], params: z.object({ key: z.string().regex(/^[a-z_]+$/) }), body: z.object({ value: z.unknown() }) } }, async (req) => {
    const before = await maybeOne(ctx.db, 'SELECT value FROM app_config WHERE key=$1', [req.params.key]);
    await ctx.db.query('INSERT INTO app_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()', [req.params.key, JSON.stringify(req.body.value)]);
    await audit(ctx.db, req, 'config.set', 'app_config', req.params.key, before?.value, req.body.value);
    return { key: req.params.key, value: req.body.value };
  });

  app.get('/ops/audit-log', { schema: { tags: ['ops'], querystring: z.object({ entity_type: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) } }, async (req) => ({
    entries: await many(ctx.db, 'SELECT * FROM audit_log WHERE ($1::text IS NULL OR entity_type=$1) ORDER BY created_at DESC LIMIT $2', [req.query.entity_type ?? null, req.query.limit]),
  }));
}
