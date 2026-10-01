import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError, jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Ctx } from './context.js';
import { AppError } from './lib/errors.js';
import { authPlugin } from './plugins/auth.js';
import { idempotencyPlugin } from './plugins/idempotency.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import { realtimeGateway } from './realtime/gateway.js';
import authRoutes from './modules/auth/routes.js';
import catalogueRoutes from './modules/catalogue/routes.js';
import consentRoutes from './modules/consents/routes.js';
import requestRoutes from './modules/requests/routes.js';
import familyRoutes from './modules/family/routes.js';
import uploadRoutes from './modules/uploads/routes.js';
import providerRoutes from './modules/providers/routes.js';
import clinicalRoutes from './modules/clinical/routes.js';
import recordRoutes from './modules/records/routes.js';
import commerceRoutes from './modules/commerce/routes.js';
import partnerRoutes from './modules/partners/routes.js';
import opsRoutes from './modules/ops/routes.js';
import contentRoutes from './modules/content/routes.js';

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { global: true });
  await app.register(websocket);
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'KM DocH API', version: '1.0.0', description: 'KM DocH (Doctor At Your Home) backend. Money is integer paise; times are UTC ISO-8601.' },
      servers: [{ url: ctx.config.env.PUBLIC_BASE_URL }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })) } });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ url: req.url }, 'response failed schema validation');
      return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal error' } });
    }
    const pg = err as unknown as { code?: string; message: string };
    if (typeof pg.message === 'string' && pg.message.startsWith('PRESCRIPTION_LOCKED')) {
      return reply.code(409).send({ error: { code: 'PRESCRIPTION_LOCKED', message: 'Signed prescriptions cannot be changed' } });
    }
    if (pg.code === '23505') return reply.code(409).send({ error: { code: 'CONFLICT', message: 'Already exists' } });
    if ((err as FastifyError).statusCode && (err as FastifyError).statusCode! < 500) {
      return reply.code((err as FastifyError).statusCode!).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    req.log.error({ err: { message: err.message, code: (err as FastifyError).code, stack: err.stack } }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal error' } });
  });

  await app.register(authPlugin, { ctx });
  await app.register(rateLimitPlugin, { ctx });
  await app.register(idempotencyPlugin, { ctx });

  app.get('/healthz', { config: { public: true }, schema: { hide: true } }, async () => {
    await ctx.db.query('SELECT 1');
    await ctx.redis.ping();
    return { ok: true };
  });
  app.get('/v1/openapi.json', { config: { public: true }, schema: { hide: true } }, async () => app.swagger());

  await app.register(
    async (v1) => {
      for (const mod of [authRoutes, catalogueRoutes, consentRoutes, requestRoutes, familyRoutes, uploadRoutes, providerRoutes, clinicalRoutes, recordRoutes, commerceRoutes, partnerRoutes, opsRoutes, contentRoutes]) {
        await v1.register(async (scoped) => mod(scoped, ctx));
      }
    },
    { prefix: '/v1' },
  );
  await realtimeGateway(app, ctx);

  if (ctx.config.env.STORAGE_DRIVER === 'local' && ctx.config.env.NODE_ENV !== 'production') {
    // Dev-only stand-in for presigned S3 PUT/GET.
    await app.register(async (scoped) => {
      scoped.addContentTypeParser('*', { parseAs: 'buffer' }, (_r, body, done) => done(null, body));
      scoped.put('/__local-storage/:key', { config: { public: true }, schema: { hide: true } }, async (req, reply) => {
        const key = decodeURIComponent((req.params as { key: string }).key);
        await ctx.adapters.storage.put(key, req.body as Buffer, String(req.headers['content-type'] ?? 'application/octet-stream'));
        return reply.code(200).send({ ok: true });
      });
      scoped.get('/__local-storage/:key', { config: { public: true }, schema: { hide: true } }, async (req, reply) => {
        const key = decodeURIComponent((req.params as { key: string }).key);
        return reply.send(await ctx.adapters.storage.get(key));
      });
    });
  }

  return app;
}
