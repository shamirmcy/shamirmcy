import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, maybeOne, tx } from '../../lib/db.js';
import { loadRequestForPatientUser } from './service.js';

/** Ratings at or below this are sent to ops for follow-up. */
const LOW_RATING = 2;

/**
 * Patient rates the professionals on a visit once at least one visit has been completed.
 * Without provider_id every professional on the visit gets the same rating. One rating per
 * provider per request; providers.rating_avg (used in assignment ranking) is recomputed.
 */
export async function rateRequest(ctx: Ctx, userId: string, requestId: string, input: { stars: number; comment?: string; provider_id?: string }) {
  const result = await tx(ctx.db, async (c) => {
    const sr = await loadRequestForPatientUser(c, userId, requestId);
    const done = await maybeOne(c, `SELECT 1 FROM visit_occurrences WHERE request_id=$1 AND status='completed' LIMIT 1`, [sr.id]);
    if (!done) throw new AppError('INVALID_TRANSITION', 'You can rate once a visit has been completed');
    const team = await many(
      c,
      `SELECT DISTINCT ra.provider_id FROM request_assignments ra
       WHERE ra.request_id=$1 AND (ra.outcome='accepted' OR ra.provider_id IN (SELECT completed_by FROM visit_occurrences WHERE request_id=$1))`,
      [sr.id],
    );
    const targets = input.provider_id ? team.filter((t) => t.provider_id === input.provider_id) : team;
    if (targets.length === 0) throw new AppError('NOT_FOUND', 'That professional was not on this visit');
    const rated: string[] = [];
    for (const t of targets) {
      const r = await maybeOne(
        c,
        `INSERT INTO ratings (request_id, provider_id, rated_by_user_id, stars, comment) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
        [sr.id, t.provider_id, userId, input.stars, input.comment ?? null],
      );
      if (!r) continue;
      rated.push(t.provider_id);
      await c.query(
        `UPDATE providers SET rating_avg = s.avg, rating_count = s.n
         FROM (SELECT round(avg(stars)::numeric, 2) AS avg, count(*)::int AS n FROM ratings WHERE provider_id=$1) s WHERE id=$1`,
        [t.provider_id],
      );
    }
    if (rated.length === 0) throw new AppError('CONFLICT', 'You have already rated this visit');
    return { rated };
  });
  if (input.stars <= LOW_RATING) {
    for (const pid of result.rated) await ctx.realtime.publish('ops', 'rating.low', { request_id: requestId, provider_id: pid, stars: input.stars });
  }
  const summary = await many(ctx.db, 'SELECT id AS provider_id, rating_avg, rating_count FROM providers WHERE id = ANY($1)', [result.rated]);
  return { request_id: requestId, rated: summary };
}

/** Provider-facing summary: average, count and star breakdown — never who rated or their comment. */
export async function ratingSummary(ctx: Ctx, providerId: string) {
  const rows = await many<{ stars: number; n: number }>(ctx.db, 'SELECT stars, count(*)::int AS n FROM ratings WHERE provider_id=$1 GROUP BY stars', [providerId]);
  const count = rows.reduce((s, r) => s + r.n, 0);
  const sum = rows.reduce((s, r) => s + r.stars * r.n, 0);
  return {
    average: count ? Math.round((sum / count) * 100) / 100 : null,
    count,
    breakdown: Object.fromEntries([1, 2, 3, 4, 5].map((st) => [st, rows.find((r) => r.stars === st)?.n ?? 0])),
  };
}
