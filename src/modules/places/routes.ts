import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import type { ResolvedAddress } from '../../adapters/places.js';
import { AppError } from '../../lib/errors.js';
import { maybeOne } from '../../lib/db.js';
import { typed } from '../../lib/http.js';

/** Is this point (or pincode) inside an active service zone? */
async function serviceability(ctx: Ctx, a: { lat: number; lng: number; pincode: string | null }) {
  const z1 = await maybeOne(
    ctx.db,
    `SELECT name, city FROM service_zones
     WHERE active AND ((area IS NOT NULL AND ST_Covers(area, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography)) OR ($3::text IS NOT NULL AND $3 = ANY(pincodes)))
     LIMIT 1`,
    [a.lng, a.lat, a.pincode],
  );
  return { serviceable: Boolean(z1), zone: z1 ? `${z1.name}, ${z1.city}` : null };
}

const withServiceability = async (ctx: Ctx, a: ResolvedAddress | null) => {
  if (!a) throw new AppError('NOT_FOUND', 'Address not found');
  return { address: a, ...(await serviceability(ctx, a)) };
};

/** Maps provider failures shouldn't look like server crashes to the app. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('INTERNAL', 'Address search is unavailable right now. Drop a pin on the map instead.');
  }
}

/**
 * Address search for the patient app. Calls go through the server so the maps key is never in the
 * app; signed-in users only (each call costs money). The app picks a result, then POSTs /addresses.
 */
export default async function placesRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);
  const Session = z.string().min(8).max(64).describe('Random token per search session (Google bills per session)');

  app.get(
    '/places/autocomplete',
    {
      schema: {
        tags: ['places'],
        querystring: z.object({ q: z.string().trim().min(2).max(120), session_token: Session, lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() }),
      },
    },
    async (req) => {
      const { q, session_token, lat, lng } = req.query;
      const near = lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
      return { suggestions: await guard(() => ctx.adapters.places.autocomplete(q, session_token, near)) };
    },
  );

  app.get(
    '/places/reverse',
    { schema: { tags: ['places'], querystring: z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }) } },
    async (req) => {
      const key = `geo:rev:${req.query.lat.toFixed(4)},${req.query.lng.toFixed(4)}`;
      const cached = await ctx.redis.get(key);
      const a = cached ? (JSON.parse(cached) as ResolvedAddress) : await guard(() => ctx.adapters.places.reverse(req.query));
      if (a && !cached) await ctx.redis.set(key, JSON.stringify(a), 'EX', 86400);
      return withServiceability(ctx, a);
    },
  );

  app.get(
    '/places/:placeId',
    { schema: { tags: ['places'], params: z.object({ placeId: z.string().min(3).max(300) }), querystring: z.object({ session_token: Session }) } },
    async (req) => withServiceability(ctx, await guard(() => ctx.adapters.places.details(req.params.placeId, req.query.session_token))),
  );
}
