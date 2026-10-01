import type { Ctx } from '../../context.js';
import type { RouteEstimate } from '../../adapters/distance.js';
import type { LatLng } from '../../lib/geo.js';
import { many } from '../../lib/db.js';
import { addMinutes } from '../../lib/time.js';
import { notify } from '../notifications/service.js';

const round = (n: number) => n.toFixed(3); // ~100 m buckets for caching

/** Server-side ETA with Redis cache; falls back to straight-line × factor if the distance API fails. */
export async function estimateEta(ctx: Ctx, from: LatLng, to: LatLng): Promise<RouteEstimate> {
  const key = `eta:${round(from.lat)},${round(from.lng)}:${round(to.lat)},${round(to.lng)}`;
  const cached = await ctx.redis.get(key);
  if (cached) return JSON.parse(cached) as RouteEstimate;
  let est: RouteEstimate;
  try {
    est = await ctx.adapters.distance.estimate(from, to);
  } catch (e) {
    ctx.log.warn({ err: (e as Error).message }, 'distance API failed; using straight-line fallback');
    est = await ctx.adapters.straightLine.estimate(from, to);
  }
  await ctx.redis.set(key, JSON.stringify(est), 'EX', ctx.config.assignment.etaCacheSeconds);
  return est;
}

const ARRIVING_SOON_MINUTES = 10;

/** Job (every 60 s): refresh ETA for confirmed visits and push minutes-only updates to patients. */
export async function refreshEtas(ctx: Ctx) {
  const rows = await many(
    ctx.db,
    `SELECT sr.id, sr.booked_by_user_id, sr.eta_minutes, u.name,
            ST_Y(s.last_location::geometry) AS plat, ST_X(s.last_location::geometry) AS plng,
            ST_Y(a.location::geometry) AS alat, ST_X(a.location::geometry) AS alng
     FROM service_requests sr
     JOIN addresses a ON a.id = sr.address_id
     JOIN request_assignments ra ON ra.request_id = sr.id AND ra.outcome='accepted' AND ra.role_in_visit='lead'
     JOIN request_slots rs ON rs.id = ra.slot_id AND NOT rs.remote
     JOIN provider_sessions s ON s.provider_id = ra.provider_id AND s.on_duty AND s.last_location IS NOT NULL
     JOIN providers p ON p.id = ra.provider_id JOIN users u ON u.id = p.user_id
     WHERE sr.status = 'confirmed'`,
  );
  for (const r of rows) {
    const est = await estimateEta(ctx, { lat: r.plat, lng: r.plng }, { lat: r.alat, lng: r.alng });
    const expectedBy = addMinutes(new Date(), est.minutes);
    await ctx.db.query('UPDATE service_requests SET eta_minutes=$2, expected_by=$3 WHERE id=$1', [r.id, est.minutes, expectedBy]);
    await ctx.realtime.publish(ctx.realtime.patientChannel(r.booked_by_user_id), 'request.eta', {
      request_id: r.id,
      eta_minutes: est.minutes,
      expected_by: expectedBy.toISOString(),
    });
    if (est.minutes <= ARRIVING_SOON_MINUTES) {
      const first = await ctx.redis.set(`arriving-soon:${r.id}`, '1', 'EX', 6 * 3600, 'NX');
      if (first === 'OK') await notify(ctx, r.booked_by_user_id, 'provider_arriving_soon', { name: r.name ?? 'Your care professional', minutes: est.minutes });
    }
  }
  return rows.length;
}
