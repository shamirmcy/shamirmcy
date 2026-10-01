import type { Queryable } from '../../lib/db.js';

/**
 * SQL predicate (for a provider expression and a request id parameter): true when the provider has
 * an accepted, still-open visit elsewhere whose time window overlaps any open visit of this request.
 */
export const clashSql = (providerExpr: string, requestParam: string) => `EXISTS (
  SELECT 1 FROM request_assignments cra
  JOIN service_requests csr ON csr.id = cra.request_id
  JOIN visit_occurrences co ON co.request_id = csr.id AND co.status IN ('scheduled','in_progress')
  JOIN visit_occurrences cn ON cn.request_id = ${requestParam} AND cn.status IN ('scheduled','in_progress')
  WHERE cra.provider_id = ${providerExpr} AND cra.outcome = 'accepted' AND csr.id <> ${requestParam}
    AND csr.status IN ('confirmed','provider_arrived','in_progress')
    AND occurrence_window(co.scheduled_for, co.created_at, co.duration_minutes)
        && occurrence_window(cn.scheduled_for, cn.created_at, cn.duration_minutes)
)`;

/** Does taking this request double-book the provider? */
export async function providerHasClash(db: Queryable, providerId: string, requestId: string): Promise<boolean> {
  const r = await db.query(`SELECT ${clashSql('$1', '$2')} AS clash`, [providerId, requestId]);
  return Boolean(r.rows[0]?.clash);
}
