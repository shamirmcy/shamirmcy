import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { one } from '../../lib/db.js';
import { typed } from '../../lib/http.js';

const LIMITS: Record<string, { types: string[]; maxBytes: number }> = {
  prescription_photo: { types: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'], maxBytes: 10 * 1024 * 1024 },
  wound_photo: { types: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'], maxBytes: 10 * 1024 * 1024 },
  report: { types: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 20 * 1024 * 1024 },
  provider_document: { types: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 10 * 1024 * 1024 },
};
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };

export default async function uploadRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);

  app.post(
    '/uploads/presign',
    {
      schema: {
        tags: ['uploads'],
        body: z.object({ kind: z.enum(['prescription_photo', 'wound_photo', 'report', 'provider_document']), content_type: z.string(), size_bytes: z.number().int().positive() }),
      },
    },
    async (req) => {
      const lim = LIMITS[req.body.kind]!;
      if (!lim.types.includes(req.body.content_type)) throw new AppError('VALIDATION_ERROR', `Unsupported file type for ${req.body.kind}`);
      if (req.body.size_bytes > lim.maxBytes) throw new AppError('VALIDATION_ERROR', 'File too large');
      const key = `uploads/${req.body.kind}/${req.auth.userId}/${randomUUID()}.${EXT[req.body.content_type]}`;
      await one(ctx.db, 'INSERT INTO uploads (owner_user_id, kind, blob_key, content_type, size_bytes) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
        req.auth.userId,
        req.body.kind,
        key,
        req.body.content_type,
        req.body.size_bytes,
      ]);
      const put = await ctx.adapters.storage.presignPut(key, req.body.content_type, req.body.size_bytes);
      return { blob_key: key, upload_url: put.url, method: 'PUT', headers: put.headers, expires_in: put.expiresIn };
    },
  );
}
