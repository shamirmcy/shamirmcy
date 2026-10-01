import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { IdParams, typed } from '../../lib/http.js';
import { AppError } from '../../lib/errors.js';
import { maybeOne } from '../../lib/db.js';
import { requireApp } from '../../plugins/auth.js';
import { currentTemplates, listConsents } from './service.js';

export default async function consentRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);

  app.get(
    '/consent-templates',
    { config: { public: true }, schema: { tags: ['consents'], querystring: z.object({ service: z.string().optional() }) } },
    async (req) => ({ templates: await currentTemplates(ctx.db, req.query.service) }),
  );

  app.get('/consents', { schema: { tags: ['consents'] } }, async (req) => {
    requireApp(req, 'patient');
    return { consents: await listConsents(ctx, req.auth.userId) };
  });

  app.post('/consents/:id/withdraw', { schema: { tags: ['consents'], params: IdParams } }, async (req) => {
    requireApp(req, 'patient');
    const c = await maybeOne(
      ctx.db,
      `SELECT c.* FROM consents c JOIN family_links fl ON fl.patient_id=c.patient_id
       WHERE c.id=$1 AND fl.account_holder_id=$2 AND fl.deleted_at IS NULL AND (fl.relationship='self' OR fl.can_view_records)`,
      [req.params.id, req.auth.userId],
    );
    if (!c) throw new AppError('NOT_FOUND', 'Consent not found');
    if (c.withdrawn_at) return { id: c.id, withdrawn_at: c.withdrawn_at };
    const r = await ctx.db.query('UPDATE consents SET withdrawn_at=now() WHERE id=$1 RETURNING withdrawn_at', [c.id]);
    // Withdrawal of share_records immediately removes provider access (checked on every read).
    return { id: c.id, withdrawn_at: r.rows[0].withdrawn_at };
  });
}
