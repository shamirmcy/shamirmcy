import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { maybeOne } from '../../lib/db.js';
import { typed } from '../../lib/http.js';

export default async function contentRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);
  /** Mediator model and who is responsible for what — stored as data so it can be edited without a release. */
  app.get('/about', { config: { public: true }, schema: { tags: ['content'] } }, async () => {
    const about = await maybeOne(ctx.db, `SELECT content, updated_at FROM content_blocks WHERE key='patient_about'`);
    return { ...(about?.content ?? {}), updated_at: about?.updated_at ?? null };
  });
}
