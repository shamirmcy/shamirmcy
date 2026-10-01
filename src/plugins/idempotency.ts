import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Ctx } from '../context.js';
import { AppError } from '../lib/errors.js';
import { maybeOne } from '../lib/db.js';

declare module 'fastify' {
  interface FastifyRequest {
    idem?: { key: string; route: string; userId: string };
  }
}

/**
 * Idempotency for money / assignment mutations. Routes opt in with `config: { idempotent: true }`
 * and must then be called with an `Idempotency-Key` header. Same key + same body replays the stored
 * response; same key + different body is rejected.
 */
export const idempotencyPlugin = fp(async (app: FastifyInstance, opts: { ctx: Ctx }) => {
  const { db } = opts.ctx;

  app.addHook('preHandler', async (req, reply) => {
    if (!req.routeOptions.config?.idempotent) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
      throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (8-128 chars) is required');
    }
    const userId = req.auth?.userId ?? '00000000-0000-0000-0000-000000000000';
    const route = `${req.method} ${req.url.split('?')[0]}`;
    const hash = createHash('sha256').update(JSON.stringify(req.body ?? null)).digest('hex');

    const inserted = await maybeOne(
      db,
      `INSERT INTO idempotency_keys (key, user_id, route, request_hash) VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING RETURNING key`,
      [key, userId, route, hash],
    );
    if (inserted) {
      req.idem = { key, route, userId };
      return;
    }
    const row = await maybeOne(db, 'SELECT * FROM idempotency_keys WHERE key=$1 AND user_id=$2 AND route=$3', [key, userId, route]);
    if (!row) throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'Retry the request');
    if (row.request_hash !== hash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different request');
    if (row.response_status === null) throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'The original request is still being processed');
    return reply.code(row.response_status).header('idempotent-replayed', 'true').type('application/json').send(row.response_body);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.idem) return payload;
    const { key, route, userId } = req.idem;
    if (reply.statusCode >= 500) {
      await db.query('DELETE FROM idempotency_keys WHERE key=$1 AND user_id=$2 AND route=$3', [key, userId, route]);
    } else {
      await db.query('UPDATE idempotency_keys SET response_status=$4, response_body=$5 WHERE key=$1 AND user_id=$2 AND route=$3', [
        key,
        userId,
        route,
        reply.statusCode,
        typeof payload === 'string' ? payload : JSON.stringify(payload ?? null),
      ]);
    }
    return payload;
  });
});
