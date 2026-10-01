import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { IdParams, typed, Uuid } from '../../lib/http.js';
import { requireApp } from '../../plugins/auth.js';
import { cancelByPatient, cancelOccurrence, createServiceRequest, getTracking } from './service.js';
import { rateRequest } from './ratings.js';
import { STATUSES } from './state.js';

const ProviderCard = z.strictObject({
  name: z.string(),
  role: z.string(),
  role_in_visit: z.string(),
  credentials: z.string(),
  bio: z.string().nullable(),
  languages: z.array(z.string()),
  verified: z.boolean(),
});

/**
 * Patient tracking payload for home visits. Strict objects: unknown keys are stripped on
 * serialisation, so coordinates/route/distance can never leak even if a query returns them.
 */
export const TrackingSchema = z.strictObject({
  id: z.string(),
  service_code: z.string(),
  status: z.enum(STATUSES),
  status_label: z.string(),
  provider: ProviderCard.nullable(),
  care_team: z.array(ProviderCard),
  eta_minutes: z.number().int().nullable(),
  expected_by: z.string().nullable(),
  visit_code: z.string().nullable(),
  visit_code_last_shared: z.boolean(),
  scheduled_for: z.string().nullable(),
  total_paise: z.number().int(),
  final_total_paise: z.number().int().nullable(),
  line_items: z.array(z.strictObject({ code: z.string(), name: z.string(), unit_price_paise: z.number().int(), qty: z.number().int(), amount_paise: z.number().int() })),
  visits: z.array(z.strictObject({ seq: z.number().int(), scheduled_for: z.string().nullable(), status: z.string() })),
  can_rate: z.boolean(),
  cancellable: z.boolean(),
  created_at: z.string(),
});

export default async function requestRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);

  app.post(
    '/service-requests',
    {
      config: { idempotent: true },
      schema: {
        tags: ['requests'],
        body: z.object({
          quote_token: z.string(),
          patient_id: Uuid,
          address_id: Uuid,
          symptoms: z.array(z.string().max(200)).max(20).optional(),
          note: z.string().max(2000).optional(),
          consents: z.array(z.object({ template_key: z.string(), version: z.number().int() })).default([]),
          attachments: z.array(z.object({ kind: z.enum(['prescription_photo', 'wound_photo', 'report']), blob_key: z.string() })).max(10).optional(),
          prescription_id: Uuid.optional(),
          scheduled_for: z.string().datetime().optional(),
        }),
      },
    },
    async (req, reply) => {
      requireApp(req, 'patient');
      const r = await createServiceRequest(ctx, req, req.body);
      return reply.code(201).send(r);
    },
  );

  app.get(
    '/service-requests/:id',
    { schema: { tags: ['requests'], params: IdParams, response: { 200: TrackingSchema } } },
    async (req) => {
      requireApp(req, 'patient');
      return getTracking(ctx, req.auth.userId, req.params.id);
    },
  );

  app.post(
    '/service-requests/:id/cancel',
    { config: { idempotent: true }, schema: { tags: ['requests'], params: IdParams, body: z.object({ reason: z.string().max(500).optional() }).default({}) } },
    async (req) => {
      requireApp(req, 'patient');
      return cancelByPatient(ctx, req.auth.userId, req.params.id, req.body?.reason);
    },
  );

  app.post(
    '/service-requests/:id/visits/:seq/cancel',
    { config: { idempotent: true }, schema: { tags: ['requests'], params: z.object({ id: Uuid, seq: z.coerce.number().int().min(1) }) } },
    async (req) => {
      requireApp(req, 'patient');
      return cancelOccurrence(ctx, req.auth.userId, req.params.id, req.params.seq);
    },
  );

  app.post(
    '/service-requests/:id/ratings',
    {
      schema: {
        tags: ['requests'],
        params: IdParams,
        body: z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(1000).optional(), provider_id: Uuid.optional() }),
      },
    },
    async (req, reply) => {
      requireApp(req, 'patient');
      return reply.code(201).send(await rateRequest(ctx, req.auth.userId, req.params.id, req.body));
    },
  );
}
