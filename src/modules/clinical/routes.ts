import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { maybeOne } from '../../lib/db.js';
import { IdParams, typed, Uuid } from '../../lib/http.js';
import { requireProviderId } from '../../plugins/auth.js';
import { assertRecordAccess } from '../access.js';
import {
  confirmTranscription,
  createConsultation,
  createPrescription,
  getPrescriptionForViewer,
  getTranscription,
  replaceDraftItems,
  signPrescription,
  updateConsultation,
} from './service.js';

const Vitals = z.record(z.string(), z.union([z.number(), z.string().max(50)]));
const RxItem = z.object({
  drug: z.string().min(1).max(120),
  strength: z.string().max(40).optional(),
  pattern: z.string().regex(/^\d(\.\d)?-\d(\.\d)?-\d(\.\d)?(-\d(\.\d)?)?$/).optional(),
  days: z.number().int().min(1).max(365).optional(),
  timing: z.string().max(40).optional(),
  sos: z.boolean().optional(),
  instructions: z.string().max(300).optional(),
});

export default async function clinicalRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);

  const ConsultationBody = z.object({
    vitals: Vitals.optional(),
    notes: z.string().max(5000).optional(),
    diagnosis: z.string().max(1000).optional(),
    advice: z.string().max(2000).optional(),
    follow_up_at: z.string().datetime().optional(),
  });

  app.post('/consultations', { schema: { tags: ['clinical'], body: ConsultationBody.extend({ request_id: Uuid }) } }, async (req, reply) =>
    reply.code(201).send(await createConsultation(ctx, requireProviderId(req), req.body)),
  );
  app.patch('/consultations/:id', { schema: { tags: ['clinical'], params: IdParams, body: ConsultationBody } }, async (req) =>
    updateConsultation(ctx, requireProviderId(req), req.params.id, req.body),
  );

  app.post(
    '/prescriptions',
    {
      schema: {
        tags: ['clinical'],
        body: z.object({
          consultation_id: Uuid,
          mode: z.enum(['typed', 'photo']),
          items: z.array(RxItem).max(30).optional(),
          photo_keys: z.array(z.string()).max(5).optional(),
          supersedes_id: Uuid.optional(),
        }),
      },
    },
    async (req, reply) => reply.code(201).send(await createPrescription(ctx, requireProviderId(req), req.auth.userId, req.body)),
  );

  app.patch('/prescriptions/:id', { schema: { tags: ['clinical'], params: IdParams, body: z.object({ items: z.array(RxItem).min(1).max(30) }) } }, async (req) =>
    replaceDraftItems(ctx, requireProviderId(req), req.params.id, req.body.items),
  );

  app.post('/prescriptions/:id/sign', { schema: { tags: ['clinical'], params: IdParams } }, async (req) => signPrescription(ctx, requireProviderId(req), req.params.id));

  app.get('/prescriptions/:id/transcription', { schema: { tags: ['clinical'], params: IdParams } }, async (req) =>
    getTranscription(ctx, requireProviderId(req), req.params.id),
  );
  app.post('/prescriptions/:id/confirm-transcription', { schema: { tags: ['clinical'], params: IdParams } }, async (req) =>
    confirmTranscription(ctx, requireProviderId(req), req.params.id),
  );

  app.get('/prescriptions/:id', { schema: { tags: ['clinical'], params: IdParams } }, async (req) => getPrescriptionForViewer(ctx, req, req.params.id));

  app.get('/prescriptions/:id/pdf', { schema: { tags: ['clinical'], params: IdParams } }, async (req) => {
    const rx = await maybeOne(ctx.db, 'SELECT * FROM prescriptions WHERE id=$1', [req.params.id]);
    if (!rx || rx.status === 'draft') throw new AppError('NOT_FOUND', 'Prescription not found');
    if (rx.prescriber_id !== req.auth.providerId) await assertRecordAccess(ctx, req, rx.patient_id, 'prescription_pdf', rx.id);
    if (!rx.pdf_key) return { status: 'generating', url: null };
    return { status: 'ready', url: await ctx.adapters.storage.presignGet(rx.pdf_key, 300), expires_in: 300 };
  });
}
