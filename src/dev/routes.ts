import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { ConsoleSmsAdapter } from '../adapters/sms.js';
import { AppError } from '../lib/errors.js';
import { typed } from '../lib/http.js';
import { PhoneSchema } from '../lib/phone.js';
import { requireProviderId } from '../plugins/auth.js';

const STATIC = join(dirname(fileURLToPath(import.meta.url)), 'static');
const FILES: Record<string, string> = { '/dev': 'index.html', '/dev/app.js': 'app.js', '/dev/app.css': 'app.css' };
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

/**
 * Test page for trying the backend in a browser (/dev), plus two shortcuts it needs.
 * Registered only when NODE_ENV is not production and DEV_TOOLS is on; config refuses
 * console SMS/WhatsApp adapters in production, so dev codes can never leak there.
 */
export async function devTools(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);

  for (const [path, file] of Object.entries(FILES)) {
    app.get(path, { config: { public: true }, schema: { hide: true } }, async (_req, reply) => {
      const body = await readFile(join(STATIC, file), 'utf8');
      return reply.type(TYPES[file.split('.').pop()!]!).header('cache-control', 'no-store').send(body);
    });
  }

  /** The code just "sent" by the dev WhatsApp/SMS adapters, so you can sign in without a real phone. */
  app.get('/v1/__dev/otp', { config: { public: true }, schema: { hide: true, querystring: z.object({ phone: PhoneSchema }) } }, async (req) => {
    const sms = ctx.adapters.sms;
    if (!(sms instanceof ConsoleSmsAdapter)) throw new AppError('NOT_FOUND', 'Real SMS/WhatsApp is configured; check your phone');
    const code = sms.lastOtp.get(req.query.phone);
    if (!code) throw new AppError('NOT_FOUND', 'No code sent to this number yet');
    return { phone: req.query.phone, code };
  });

  /** Skip the ops verification step for a provider you just signed in as, and cover every service zone. */
  app.post('/v1/__dev/provider-ready', { schema: { hide: true } }, async (req) => {
    const pid = requireProviderId(req);
    await ctx.db.query(
      `UPDATE providers SET verification_status='verified', service_area_zone_ids=(SELECT COALESCE(array_agg(id), '{}') FROM service_zones WHERE active),
         languages = CASE WHEN languages = '{}' THEN ARRAY['English','Tamil','Kannada','Hindi'] ELSE languages END,
         qualifications = CASE WHEN qualifications = '{}' AND role IN ('doctor','consultant') THEN ARRAY['MBBS'] ELSE qualifications END,
         years_experience = COALESCE(years_experience, 8)
       WHERE id=$1`,
      [pid],
    );
    return { provider_id: pid, verification_status: 'verified' };
  });
}
