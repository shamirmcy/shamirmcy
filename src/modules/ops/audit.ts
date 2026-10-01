import type { FastifyRequest } from 'fastify';
import type { Queryable } from '../../lib/db.js';

/** Append-only (DB trigger forbids UPDATE/DELETE). */
export async function audit(db: Queryable, req: FastifyRequest, action: string, entityType: string, entityId: string | null, before: unknown, after: unknown) {
  await db.query('INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before, after, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    req.auth?.userId ?? null,
    action,
    entityType,
    entityId,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    req.ip,
  ]);
}
