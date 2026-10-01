import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Ctx } from '../context.js';

export type RouteModule = (app: FastifyInstance, ctx: Ctx) => void | Promise<void>;

export const typed = (app: FastifyInstance) => app.withTypeProvider<ZodTypeProvider>();

export const Uuid = z.string().uuid();
export const IdParams = z.object({ id: Uuid });

export const clientMeta = (req: FastifyRequest) => ({
  ip: req.ip,
  device: (req.headers['x-device-id'] as string | undefined) ?? req.auth?.deviceId ?? null,
});
