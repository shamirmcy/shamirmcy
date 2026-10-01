import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Ctx } from '../context.js';
import { AppError } from '../lib/errors.js';

/**
 * Fixed one-minute windows in Redis: per signed-in user, or per IP for public endpoints.
 * Payment webhooks and health checks are exempt. OTP sending has its own stricter limits.
 * Registered after auth so signed-in callers are counted by user, not by shared IP.
 */
export const rateLimitPlugin = fp(async (app: FastifyInstance, opts: { ctx: Ctx }) => {
  const { ctx } = opts;
  const { authedPerMinute, publicPerMinute } = ctx.config.rateLimit;
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]!;
    if (url === '/healthz' || url.startsWith('/v1/webhooks/') || url === '/v1/realtime' || url.startsWith('/__local-storage/')) return;
    const minute = Math.floor(Date.now() / 60_000);
    const who = req.auth ? `u:${req.auth.userId}` : `ip:${req.ip}`;
    const limit = req.auth ? authedPerMinute : publicPerMinute;
    const key = `rl:${who}:${minute}`;
    const n = await ctx.redis.incr(key);
    if (n === 1) await ctx.redis.expire(key, 70);
    if (n > limit) {
      reply.header('retry-after', String(60 - Math.floor((Date.now() / 1000) % 60)));
      throw new AppError('RATE_LIMITED', 'Too many requests. Please wait a minute and try again.');
    }
  });
});
