import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, maybeOne, one, tx } from '../../lib/db.js';
import { IdParams, typed, Uuid } from '../../lib/http.js';
import { requireApp } from '../../plugins/auth.js';
import { assertCanBook, getFamilyLink } from '../access.js';

const ProfileFields = z.object({
  name: z.string().min(1).max(120),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sex: z.enum(['female', 'male', 'other']).optional(),
  conditions: z.array(z.string().max(80)).max(30).optional(),
  allergies: z.array(z.string().max(80)).max(30).optional(),
  abha_id: z.string().max(40).optional(),
});

export default async function familyRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);

  app.get('/family-members', { schema: { tags: ['family'] } }, async (req) => {
    requireApp(req, 'patient');
    const rows = await many(
      ctx.db,
      `SELECT fl.id AS link_id, fl.relationship, fl.can_book, fl.can_view_records, p.id AS patient_id, p.name, p.dob, p.sex, p.abha_id
       FROM family_links fl JOIN patients p ON p.id=fl.patient_id
       WHERE fl.account_holder_id=$1 AND fl.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY (fl.relationship='self') DESC, p.name`,
      [req.auth.userId],
    );
    return { members: rows };
  });

  app.post(
    '/family-members',
    {
      schema: {
        tags: ['family'],
        body: ProfileFields.extend({
          relationship: z.enum(['spouse', 'parent', 'child', 'sibling', 'grandparent', 'relative', 'other']),
          can_book: z.boolean().default(true),
          can_view_records: z.boolean().default(true),
        }),
      },
    },
    async (req, reply) => {
      requireApp(req, 'patient');
      const b = req.body;
      const out = await tx(ctx.db, async (c) => {
        const p = await one(
          c,
          `INSERT INTO patients (name, dob, sex, conditions_enc, allergies_enc, abha_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [b.name, b.dob ?? null, b.sex ?? null, ctx.cipher.encryptJson(b.conditions ?? []), ctx.cipher.encryptJson(b.allergies ?? []), b.abha_id ?? null],
        );
        const l = await one(
          c,
          `INSERT INTO family_links (account_holder_id, patient_id, relationship, can_book, can_view_records) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [req.auth.userId, p.id, b.relationship, b.can_book, b.can_view_records],
        );
        return { patient_id: p.id, link_id: l.id };
      });
      return reply.code(201).send(out);
    },
  );

  /** :id is the patient id. Grants (can_book / can_view_records) can only be changed by the patient's own account. */
  app.patch(
    '/family-members/:id',
    {
      schema: {
        tags: ['family'],
        params: IdParams,
        body: ProfileFields.partial().extend({
          relationship: z.string().max(30).optional(),
          can_book: z.boolean().optional(),
          can_view_records: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      requireApp(req, 'patient');
      const link = await getFamilyLink(ctx.db, req.auth.userId, req.params.id);
      if (!link || !link.can_book) throw new AppError('NOT_FOUND', 'Family member not found');
      const b = req.body;
      const patient = await one(ctx.db, 'SELECT user_id FROM patients WHERE id=$1', [req.params.id]);
      if (patient.user_id && patient.user_id !== req.auth.userId) {
        // This person has their own account: only they may edit their clinical profile.
        if (b.conditions || b.allergies || b.dob || b.sex || b.name) throw new AppError('FORBIDDEN', 'This person manages their own profile');
      }
      if ((b.can_view_records !== undefined || b.can_book !== undefined) && link.relationship === 'self') {
        throw new AppError('VALIDATION_ERROR', 'Your own access cannot be changed');
      }
      await ctx.db.query(
        `UPDATE patients SET name=COALESCE($2,name), dob=COALESCE($3::date,dob), sex=COALESCE($4,sex),
           conditions_enc=COALESCE($5,conditions_enc), allergies_enc=COALESCE($6,allergies_enc), abha_id=COALESCE($7,abha_id) WHERE id=$1`,
        [req.params.id, b.name ?? null, b.dob ?? null, b.sex ?? null, b.conditions ? ctx.cipher.encryptJson(b.conditions) : null, b.allergies ? ctx.cipher.encryptJson(b.allergies) : null, b.abha_id ?? null],
      );
      await ctx.db.query(
        `UPDATE family_links SET relationship=COALESCE($2,relationship), can_book=COALESCE($3,can_book), can_view_records=COALESCE($4,can_view_records) WHERE id=$1`,
        [link.id, b.relationship ?? null, b.can_book ?? null, b.can_view_records ?? null],
      );
      return { patient_id: req.params.id, updated: true };
    },
  );

  app.delete('/family-members/:id', { schema: { tags: ['family'], params: IdParams } }, async (req, reply) => {
    requireApp(req, 'patient');
    const link = await getFamilyLink(ctx.db, req.auth.userId, req.params.id);
    if (!link || link.relationship === 'self') throw new AppError('NOT_FOUND', 'Family member not found');
    await ctx.db.query('UPDATE family_links SET deleted_at=now() WHERE id=$1', [link.id]);
    return reply.code(204).send();
  });

  // ── Addresses ──
  const AddressBody = z.object({
    patient_id: Uuid,
    label: z.string().min(1).max(40),
    line1: z.string().min(3).max(300),
    landmark: z.string().max(200).optional(),
    locality: z.string().max(120).optional(),
    pincode: z.string().regex(/^[1-9]\d{5}$/),
    lat: z.number().min(6).max(38),
    lng: z.number().min(68).max(98),
    gate_code: z.string().max(40).optional(),
    floor: z.string().max(20).optional(),
    lift: z.boolean().optional(),
  });

  app.get('/addresses', { schema: { tags: ['family'], querystring: z.object({ patient_id: Uuid }) } }, async (req) => {
    requireApp(req, 'patient');
    await assertCanBook(ctx.db, req.auth.userId, req.query.patient_id);
    const rows = await many(
      ctx.db,
      `SELECT id, patient_id, label, line1, landmark, locality, pincode, gate_code, floor, lift,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
       FROM addresses WHERE patient_id=$1 AND deleted_at IS NULL ORDER BY created_at`,
      [req.query.patient_id],
    );
    return { addresses: rows };
  });

  app.post('/addresses', { schema: { tags: ['family'], body: AddressBody } }, async (req, reply) => {
    requireApp(req, 'patient');
    const b = req.body;
    await assertCanBook(ctx.db, req.auth.userId, b.patient_id);
    const a = await one(
      ctx.db,
      `INSERT INTO addresses (patient_id, label, line1, landmark, locality, pincode, location, gate_code, floor, lift)
       VALUES ($1,$2,$3,$4,$5,$6, ST_SetSRID(ST_MakePoint($7,$8),4326)::geography, $9,$10,$11) RETURNING id`,
      [b.patient_id, b.label, b.line1, b.landmark ?? null, b.locality ?? null, b.pincode, b.lng, b.lat, b.gate_code ?? null, b.floor ?? null, b.lift ?? null],
    );
    const zone = await maybeOne(ctx.db, `SELECT z.name FROM service_zones z, addresses a WHERE a.id=$1 AND z.active AND (a.pincode = ANY(z.pincodes) OR ST_Covers(z.area, a.location)) LIMIT 1`, [a.id]);
    return reply.code(201).send({ id: a.id, serviceable: Boolean(zone), zone: zone?.name ?? null });
  });

  app.delete('/addresses/:id', { schema: { tags: ['family'], params: IdParams } }, async (req, reply) => {
    requireApp(req, 'patient');
    const a = await maybeOne(ctx.db, 'SELECT patient_id FROM addresses WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
    if (!a) throw new AppError('NOT_FOUND', 'Address not found');
    await assertCanBook(ctx.db, req.auth.userId, a.patient_id);
    await ctx.db.query('UPDATE addresses SET deleted_at=now() WHERE id=$1', [req.params.id]);
    return reply.code(204).send();
  });
}
