import { jwtVerify, SignJWT } from 'jose';
import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, maybeOne, one, type Queryable } from '../../lib/db.js';
import { addSeconds } from '../../lib/time.js';
import { getDef, type LineItem, type OptionRow } from './defs.js';

export async function loadService(db: Queryable, code: string) {
  const svc = await maybeOne(db, 'SELECT * FROM services WHERE code=$1 AND active', [code]);
  if (!svc) throw new AppError('NOT_FOUND', `Service ${code} is not available`);
  const options = await many<OptionRow>(db, 'SELECT * FROM service_options WHERE service_id=$1 AND active ORDER BY code', [svc.id]);
  return { svc, options };
}

/** Server-side pricing. The only source of truth for what the patient pays. */
export async function priceService(db: Queryable, serviceCode: string, rawOptions: unknown) {
  const def = getDef(serviceCode);
  const parsed = def.optionsSchema.safeParse(rawOptions ?? {});
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid service options', parsed.error.issues);
  const { svc, options } = await loadService(db, serviceCode);
  const byCode = new Map(options.map((o) => [o.code, o]));
  const opt = (code: string) => {
    const o = byCode.get(code);
    if (!o) throw new AppError('NOT_FOUND', `Option ${code} is not available for ${serviceCode}`);
    return o;
  };
  const lineItems = def.lines(parsed.data, opt);
  const total = lineItems.reduce((s, l) => s + l.amount_paise, 0);
  return { def, svc, options: parsed.data, lineItems, total };
}

const quoteKey = (ctx: Ctx) => new TextEncoder().encode(ctx.config.env.QUOTE_SECRET);

export async function createQuote(ctx: Ctx, userId: string, serviceCode: string, rawOptions: unknown) {
  const { options, lineItems, total, svc } = await priceService(ctx.db, serviceCode, rawOptions);
  const expiresAt = addSeconds(new Date(), ctx.config.quoteTtlSeconds);
  const q = await one(
    ctx.db,
    `INSERT INTO quotes (user_id, service_code, options, line_items, total_paise, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, serviceCode, options, JSON.stringify(lineItems), total, expiresAt],
  );
  const token = await new SignJWT({ qid: q.id, svc: serviceCode, total })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(quoteKey(ctx));
  return {
    quote_token: token,
    service: { code: svc.code as string, name: svc.name as string },
    options,
    line_items: lineItems.map(publicLine),
    total_paise: total,
    currency: 'INR',
    expires_at: expiresAt.toISOString(),
  };
}

export const publicLine = (l: LineItem) => ({
  code: l.option_code,
  name: l.name,
  unit_price_paise: l.unit_price_paise,
  qty: l.qty,
  amount_paise: l.amount_paise,
});

/** Verify and consume a quote token inside the booking transaction. */
export async function consumeQuote(ctx: Ctx, c: Queryable, token: string, userId: string, expectService?: string) {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, quoteKey(ctx)));
  } catch (e) {
    const expired = (e as { code?: string }).code === 'ERR_JWT_EXPIRED';
    throw new AppError(expired ? 'QUOTE_EXPIRED' : 'QUOTE_INVALID', expired ? 'Quote expired. Please review the price again.' : 'Invalid quote');
  }
  if (payload.sub !== userId) throw new AppError('QUOTE_INVALID', 'Quote belongs to another user');
  const q = await maybeOne(c, 'SELECT * FROM quotes WHERE id=$1 FOR UPDATE', [payload.qid]);
  if (!q) throw new AppError('QUOTE_INVALID', 'Unknown quote');
  if (q.used_at) throw new AppError('QUOTE_INVALID', 'Quote already used');
  if (q.expires_at < new Date()) throw new AppError('QUOTE_EXPIRED', 'Quote expired');
  if (expectService && q.service_code !== expectService) throw new AppError('QUOTE_INVALID', 'Quote is for a different service');
  await c.query('UPDATE quotes SET used_at=now() WHERE id=$1', [q.id]);
  return q as { id: string; service_code: string; options: any; line_items: LineItem[]; total_paise: number };
}

export async function listCatalogue(db: Queryable) {
  const services = await many(db, 'SELECT * FROM services WHERE active ORDER BY sort_order, name');
  const options = await many(db, 'SELECT * FROM service_options WHERE active ORDER BY code');
  return services.map((s) => ({
    code: s.code,
    name: s.name,
    category: s.category,
    description: s.description,
    promised_window_minutes: s.promised_window_minutes,
    emergency: s.emergency,
    options: options
      .filter((o) => o.service_id === s.id)
      .map((o) => ({ code: o.code, name: o.name, price_paise: o.price_paise, unit: o.unit, meta: o.meta })),
  }));
}
