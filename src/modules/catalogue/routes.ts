import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { typed } from '../../lib/http.js';
import { createQuote, listCatalogue } from './service.js';

export default async function catalogueRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);

  app.get('/services', { config: { public: true }, schema: { tags: ['catalogue'] } }, async () => ({ services: await listCatalogue(ctx.db) }));

  app.post(
    '/quotes',
    {
      schema: {
        tags: ['catalogue'],
        // Any price-like fields a client sends are ignored: only service_code + options are read.
        body: z.object({ service_code: z.string(), options: z.record(z.string(), z.unknown()).default({}) }).passthrough(),
      },
    },
    async (req) => createQuote(ctx, req.auth.userId, req.body.service_code, req.body.options),
  );
}
