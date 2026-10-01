import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { jwtVerify, SignJWT } from 'jose';
import type { Ctx } from '../context.js';
import { AppError } from '../lib/errors.js';
import { maybeOne } from '../lib/db.js';

export type AppRole = 'patient' | 'provider' | 'partner' | 'ops';

export interface AuthInfo {
  userId: string;
  roles: string[];
  deviceId: string;
  app: AppRole;
  providerId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo;
  }
  interface FastifyContextConfig {
    public?: boolean;
    idempotent?: boolean;
  }
}

const enc = (s: string) => new TextEncoder().encode(s);

export async function signAccessToken(ctx: Ctx, a: AuthInfo): Promise<string> {
  return new SignJWT({ roles: a.roles, did: a.deviceId, app: a.app, pid: a.providerId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(a.userId)
    .setIssuer('kmdoch')
    .setAudience('kmdoch-api')
    .setIssuedAt()
    .setExpirationTime(`${ctx.config.auth.accessTtlSeconds}s`)
    .sign(enc(ctx.config.env.JWT_SECRET));
}

export async function verifyAccessToken(ctx: Ctx, token: string): Promise<AuthInfo> {
  try {
    const { payload } = await jwtVerify(token, enc(ctx.config.env.JWT_SECRET), { issuer: 'kmdoch', audience: 'kmdoch-api' });
    return {
      userId: payload.sub!,
      roles: (payload.roles as string[]) ?? [],
      deviceId: payload.did as string,
      app: payload.app as AppRole,
      providerId: (payload.pid as string | undefined) ?? undefined,
    };
  } catch {
    throw new AppError('UNAUTHENTICATED', 'Invalid or expired access token');
  }
}

export const authPlugin = fp(async (app: FastifyInstance, opts: { ctx: Ctx }) => {
  const { ctx } = opts;
  app.decorateRequest('auth', null as unknown as AuthInfo);
  // onRequest: authenticate before the body is parsed or validated.
  app.addHook('onRequest', async (req) => {
    if (req.routeOptions.config?.public) return;
    // Interactive API docs (dev only; registered only outside production).
    if (req.url === '/docs' || req.url.startsWith('/docs/')) return;
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED', 'Missing bearer token');
    req.auth = await verifyAccessToken(ctx, h.slice(7));
    // Revoked devices lose access immediately, not after token expiry.
    const dev = await maybeOne(ctx.db, 'SELECT revoked_at FROM devices WHERE id = $1', [req.auth.deviceId]);
    if (!dev || dev.revoked_at) throw new AppError('UNAUTHENTICATED', 'Session revoked');
  });
});

export function requireApp(req: FastifyRequest, ...apps: AppRole[]) {
  if (!apps.includes(req.auth.app)) throw new AppError('FORBIDDEN', `Requires ${apps.join(' or ')} sign-in`);
}

export function requireRole(req: FastifyRequest, ...roles: string[]) {
  if (!roles.some((r) => req.auth.roles.includes(r))) throw new AppError('FORBIDDEN', `Requires role: ${roles.join(' | ')}`);
}

export function requireProviderId(req: FastifyRequest): string {
  requireApp(req, 'provider');
  if (!req.auth.providerId) throw new AppError('FORBIDDEN', 'Provider account required');
  return req.auth.providerId;
}
