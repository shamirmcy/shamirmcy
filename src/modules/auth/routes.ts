import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { typed, Uuid } from '../../lib/http.js';
import { PhoneSchema } from '../../lib/phone.js';
import { many, maybeOne, one } from '../../lib/db.js';
import { PROVIDER_ROLES } from '../providers/roles.js';
import { logout, publicUser, refresh, requestOtp, verifyOtp } from './service.js';

export default async function authRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);

  app.post(
    '/auth/otp/request',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        body: z.object({
          phone: PhoneSchema,
          app_role: z.enum(['patient', 'provider', 'partner', 'ops']),
          provider_role: z.enum(PROVIDER_ROLES).optional(),
          reg_number: z.string().min(3).max(40).optional(),
        }),
      },
    },
    async (req) => requestOtp(ctx, req.body, req.ip),
  );

  app.post(
    '/auth/otp/verify',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        body: z.object({
          challenge_id: Uuid,
          phone: PhoneSchema,
          code: z.string().regex(/^\d{4,6}$/),
          device: z.object({ id: z.string().min(8).max(128), platform: z.enum(['android', 'ios', 'web']), push_token: z.string().max(4096).optional() }),
          name: z.string().min(1).max(120).optional(),
          preferred_language: z.enum(['en', 'ta', 'kn', 'hi']).optional(),
        }),
      },
    },
    async (req) => verifyOtp(ctx, req.body),
  );

  app.post(
    '/auth/refresh',
    {
      config: { public: true },
      schema: { tags: ['auth'], body: z.object({ refresh_token: z.string().min(20), device_id: z.string().min(8).max(128) }) },
    },
    async (req) => refresh(ctx, req.body.refresh_token, req.body.device_id),
  );

  app.post('/auth/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    await logout(ctx, req.auth.deviceId);
    return reply.code(204).send();
  });

  app.get('/me', { schema: { tags: ['auth'] } }, async (req) => {
    const user = await one(ctx.db, 'SELECT * FROM users WHERE id=$1', [req.auth.userId]);
    const roles = (await many(ctx.db, 'SELECT role FROM user_roles WHERE user_id=$1', [user.id])).map((r) => r.role as string);
    const patient = await maybeOne(ctx.db, 'SELECT id, name, dob, sex, abha_id FROM patients WHERE user_id=$1 AND deleted_at IS NULL', [user.id]);
    const provider = req.auth.providerId
      ? await maybeOne(ctx.db, 'SELECT id, role, reg_number, verification_status FROM providers WHERE id=$1', [req.auth.providerId])
      : null;
    return { user: publicUser(user, roles), app: req.auth.app, patient, provider };
  });

  app.patch(
    '/me',
    { schema: { tags: ['auth'], body: z.object({ name: z.string().min(1).max(120).optional(), preferred_language: z.enum(['en', 'ta', 'kn', 'hi']).optional() }) } },
    async (req) => {
      const u = await one(
        ctx.db,
        'UPDATE users SET name=COALESCE($2,name), preferred_language=COALESCE($3,preferred_language) WHERE id=$1 RETURNING *',
        [req.auth.userId, req.body.name ?? null, req.body.preferred_language ?? null],
      );
      if (req.body.name) await ctx.db.query('UPDATE patients SET name=$2 WHERE user_id=$1', [req.auth.userId, req.body.name]);
      return { user: publicUser(u, req.auth.roles) };
    },
  );
}
