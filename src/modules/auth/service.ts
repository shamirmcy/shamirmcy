import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { hmac, numericCode, randomToken, safeEqualHex } from '../../lib/crypto.js';
import { maybeOne, one, tx, type Queryable, many } from '../../lib/db.js';
import { addSeconds } from '../../lib/time.js';
import { signAccessToken, type AppRole, type AuthInfo } from '../../plugins/auth.js';
import type { OtpLang } from '../../adapters/whatsapp.js';
import { REG_TYPE_BY_ROLE, type ProviderRole } from '../providers/roles.js';

const otpHash = (ctx: Ctx, challengeId: string, code: string) => hmac(ctx.config.env.OTP_PEPPER, `${challengeId}:${code}`);
const tokenHash = (t: string) => hmac('refresh', t);

export interface OtpRequestInput {
  phone: string;
  app_role: AppRole;
  provider_role?: ProviderRole;
  reg_number?: string;
  /** Preferred channel. WhatsApp falls back to SMS automatically if it fails. */
  channel?: 'whatsapp' | 'sms';
}

export async function requestOtp(ctx: Ctx, input: OtpRequestInput, ip: string) {
  const { auth } = ctx.config;
  if (input.app_role === 'provider' && (!input.provider_role || !input.reg_number)) {
    throw new AppError('VALIDATION_ERROR', 'provider_role and reg_number are required for provider sign-in');
  }
  const recent = await one<{ n: number }>(
    ctx.db,
    `SELECT count(*)::int AS n FROM otp_challenges WHERE phone_e164=$1 AND created_at > now() - make_interval(secs => $2)`,
    [input.phone, auth.otpWindowSeconds],
  );
  if (recent.n >= auth.otpMaxSendsPerWindow) throw new AppError('RATE_LIMITED', 'Too many OTP requests. Try again in a few minutes.');

  // Coarse per-IP limit to slow down SMS pumping.
  const ipKey = `otp:ip:${ip}`;
  const ipCount = await ctx.redis.incr(ipKey);
  if (ipCount === 1) await ctx.redis.expire(ipKey, auth.otpWindowSeconds);
  if (ipCount > 20) throw new AppError('RATE_LIMITED', 'Too many OTP requests from this network');

  const code = numericCode(auth.otpLength);
  const expiresAt = addSeconds(new Date(), auth.otpTtlSeconds);
  const meta = input.app_role === 'provider' ? { provider_role: input.provider_role, reg_number: normalizeReg(input.reg_number!) } : {};
  const ch = await one(
    ctx.db,
    `INSERT INTO otp_challenges (phone_e164, code_hash, purpose, meta, expires_at) VALUES ($1,'pending',$2,$3,$4) RETURNING id`,
    [input.phone, input.app_role, meta, expiresAt],
  );

  const wantWhatsApp = (input.channel ?? 'whatsapp') === 'whatsapp' && ctx.adapters.whatsapp.enabled;
  let channel: 'whatsapp' | 'sms' = 'sms';
  let messageId: string | null = null;
  let fallback = false;
  if (wantWhatsApp) {
    try {
      const user = await maybeOne(ctx.db, 'SELECT preferred_language FROM users WHERE phone_e164=$1', [input.phone]);
      messageId = (await ctx.adapters.whatsapp.sendOtp(input.phone, code, (user?.preferred_language ?? 'en') as OtpLang)).messageId;
      channel = 'whatsapp';
    } catch (e) {
      ctx.log.warn({ err: (e as Error).message }, 'WhatsApp OTP failed; falling back to SMS');
      fallback = true;
    }
  }
  if (channel === 'sms') {
    try {
      await ctx.adapters.sms.sendOtp(input.phone, code);
    } catch (e) {
      await ctx.db.query('DELETE FROM otp_challenges WHERE id=$1', [ch.id]); // not counted against the send limit
      ctx.log.error({ err: (e as Error).message }, 'SMS OTP failed');
      throw new AppError('INTERNAL', 'We could not send your code. Please try again.');
    }
  }
  await ctx.db.query('UPDATE otp_challenges SET code_hash=$2, channel=$3, provider_message_id=$4, code_enc=$5 WHERE id=$1', [
    ch.id,
    otpHash(ctx, ch.id, code),
    channel,
    messageId,
    // Kept (encrypted) only for WhatsApp, so a later delivery failure can resend the same code by SMS.
    channel === 'whatsapp' ? ctx.cipher.encrypt(code) : null,
  ]);
  return { challenge_id: ch.id as string, expires_at: expiresAt.toISOString(), length: auth.otpLength, channel, fallback };
}

/**
 * WhatsApp delivery-status webhook (Meta). When an OTP message fails to deliver — typically because
 * the number is not on WhatsApp — the same code is sent by SMS, once, while it is still valid.
 */
export async function handleWhatsAppStatus(ctx: Ctx, raw: string, signature: string | undefined) {
  if (!ctx.adapters.whatsapp.verifyWebhook(raw, signature)) throw new AppError('UNAUTHENTICATED', 'Bad signature');
  const body = JSON.parse(raw) as { entry?: Array<{ changes?: Array<{ value?: { statuses?: Array<{ id: string; status: string }> } }> }> };
  let resent = 0;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const st of change.value?.statuses ?? []) {
        if (st.status !== 'failed') continue;
        const ch = await maybeOne(
          ctx.db,
          `UPDATE otp_challenges SET fallback_sent_at=now()
           WHERE provider_message_id=$1 AND channel='whatsapp' AND fallback_sent_at IS NULL AND consumed_at IS NULL AND expires_at > now() AND code_enc IS NOT NULL
           RETURNING id, phone_e164, code_enc`,
          [st.id],
        );
        if (!ch) continue;
        await ctx.adapters.sms.sendOtp(ch.phone_e164, ctx.cipher.decrypt(ch.code_enc));
        resent++;
      }
    }
  }
  return { ok: true, resent };
}

export const normalizeReg = (r: string) => r.trim().toUpperCase().replace(/\s+/g, '');

export interface VerifyInput {
  challenge_id: string;
  phone: string;
  code: string;
  device: { id: string; platform: 'android' | 'ios' | 'web'; push_token?: string };
  name?: string;
  preferred_language?: 'en' | 'ta' | 'kn' | 'hi';
}

export async function verifyOtp(ctx: Ctx, input: VerifyInput) {
  const ch = await maybeOne(ctx.db, 'SELECT * FROM otp_challenges WHERE id=$1', [input.challenge_id]);
  if (!ch || ch.phone_e164 !== input.phone) throw new AppError('OTP_INVALID', 'Invalid code');
  if (ch.consumed_at || ch.expires_at < new Date()) throw new AppError('OTP_EXPIRED', 'Code expired. Request a new one.');
  if (ch.attempts >= ctx.config.auth.otpMaxAttempts) throw new AppError('OTP_LOCKED', 'Too many attempts. Request a new code.');
  const { rows } = await ctx.db.query(
    'UPDATE otp_challenges SET attempts = attempts + 1 WHERE id=$1 AND attempts < $2 AND consumed_at IS NULL RETURNING attempts',
    [ch.id, ctx.config.auth.otpMaxAttempts],
  );
  if (!rows[0]) throw new AppError('OTP_LOCKED', 'Too many attempts. Request a new code.');
  if (!safeEqualHex(otpHash(ctx, ch.id, input.code), ch.code_hash)) {
    throw new AppError('OTP_INVALID', 'Incorrect code', { attempts_left: ctx.config.auth.otpMaxAttempts - rows[0].attempts });
  }

  const app = ch.purpose as AppRole;
  return tx(ctx.db, async (c) => {
    const consumed = await c.query('UPDATE otp_challenges SET consumed_at=now(), code_enc=NULL WHERE id=$1 AND consumed_at IS NULL', [ch.id]);
    if (consumed.rowCount === 0) throw new AppError('OTP_EXPIRED', 'Code already used');

    const user = await one(
      c,
      `INSERT INTO users (phone_e164, name, preferred_language) VALUES ($1,$2,COALESCE($3,'en'))
       ON CONFLICT (phone_e164) DO UPDATE SET name = COALESCE(users.name, EXCLUDED.name)
       RETURNING *`,
      [input.phone, input.name ?? null, input.preferred_language ?? null],
    );
    if (user.status === 'blocked' && app !== 'patient') throw new AppError('FORBIDDEN', 'Account blocked');

    let providerId: string | undefined;
    if (app === 'patient') {
      await ensurePatientAccount(c, user.id, user.name ?? input.name ?? 'Me');
    } else if (app === 'provider') {
      providerId = await ensureProvider(c, user.id, ch.meta.provider_role, ch.meta.reg_number);
    } else if (app === 'partner') {
      const m = await maybeOne(c, 'SELECT 1 FROM partner_members pm JOIN partners p ON p.id=pm.partner_id WHERE pm.user_id=$1 AND p.active', [user.id]);
      if (!m) throw new AppError('FORBIDDEN', 'Not a registered partner member');
      await c.query(`INSERT INTO user_roles (user_id, role) VALUES ($1,'partner') ON CONFLICT DO NOTHING`, [user.id]);
    } else if (app === 'ops') {
      const allow = ctx.config.env.OPS_ADMIN_PHONES.split(',').map((s) => s.trim()).filter(Boolean);
      if (allow.includes(user.phone_e164)) {
        await c.query(`INSERT INTO user_roles (user_id, role) VALUES ($1,'ops_admin') ON CONFLICT DO NOTHING`, [user.id]);
      }
      const r = await maybeOne(c, `SELECT 1 FROM user_roles WHERE user_id=$1 AND role='ops_admin'`, [user.id]);
      if (!r) throw new AppError('FORBIDDEN', 'Not an ops admin');
    }

    const device = await one(
      c,
      `INSERT INTO devices (user_id, client_device_id, platform, push_token) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, client_device_id) DO UPDATE
         SET platform=EXCLUDED.platform, push_token=COALESCE(EXCLUDED.push_token, devices.push_token), revoked_at=NULL
       RETURNING id`,
      [user.id, input.device.id, input.device.platform, input.device.push_token ?? null],
    );
    // A fresh sign-in on a device starts a new refresh family and kills the old one.
    await c.query('UPDATE refresh_tokens SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL', [device.id]);

    const roles = (await many<{ role: string }>(c, 'SELECT role FROM user_roles WHERE user_id=$1', [user.id])).map((r) => r.role);
    const auth: AuthInfo = { userId: user.id, roles, deviceId: device.id, app, providerId };
    const tokens = await issueTokens(ctx, c, auth, crypto.randomUUID());
    return { ...tokens, user: publicUser(user, roles), provider_id: providerId ?? null };
  });
}

async function ensurePatientAccount(c: Queryable, userId: string, name: string) {
  await c.query(`INSERT INTO user_roles (user_id, role) VALUES ($1,'patient') ON CONFLICT DO NOTHING`, [userId]);
  const p = await one(
    c,
    `INSERT INTO patients (user_id, name) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING id`,
    [userId, name],
  );
  await c.query(
    `INSERT INTO family_links (account_holder_id, patient_id, relationship, can_book, can_view_records)
     VALUES ($1,$2,'self',true,true) ON CONFLICT DO NOTHING`,
    [userId, p.id],
  );
}

/**
 * Provider sign-in: registration number must match the provider on file for this phone.
 * First sign-in creates a `pending` provider that ops must verify before they can go on duty.
 */
async function ensureProvider(c: Queryable, userId: string, role: ProviderRole, regNumber: string): Promise<string> {
  const byReg = await maybeOne(c, 'SELECT * FROM providers WHERE reg_number=$1', [regNumber]);
  const byUser = await maybeOne(c, 'SELECT * FROM providers WHERE user_id=$1', [userId]);
  if (byReg && (byReg.user_id !== userId || byReg.role !== role)) {
    throw new AppError('PROVIDER_MISMATCH', 'Registration number does not match this phone and role');
  }
  if (!byReg && byUser) throw new AppError('PROVIDER_MISMATCH', 'This phone is registered with a different registration number');
  let id = byReg?.id as string | undefined;
  if (!id) {
    const p = await one(c, `INSERT INTO providers (user_id, role, reg_type, reg_number) VALUES ($1,$2,$3,$4) RETURNING id`, [
      userId,
      role,
      REG_TYPE_BY_ROLE[role],
      regNumber,
    ]);
    id = p.id as string;
  }
  await c.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, role]);
  await c.query('INSERT INTO provider_sessions (provider_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  return id;
}

async function issueTokens(ctx: Ctx, c: Queryable, auth: AuthInfo, familyId: string) {
  const refresh = randomToken(32);
  await c.query(
    `INSERT INTO refresh_tokens (device_id, family_id, app, token_hash, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5))`,
    [auth.deviceId, familyId, auth.app, tokenHash(refresh), ctx.config.auth.refreshTtlDays],
  );
  return {
    access_token: await signAccessToken(ctx, auth),
    refresh_token: refresh,
    token_type: 'Bearer' as const,
    expires_in: ctx.config.auth.accessTtlSeconds,
  };
}

/** Rotating refresh tokens bound to a device. Re-use of a spent token revokes the whole family. */
export async function refresh(ctx: Ctx, refreshToken: string, clientDeviceId: string) {
  const result = await tx(ctx.db, async (c) => {
    const rt = await maybeOne(
      c,
      `SELECT rt.*, d.user_id, d.client_device_id, d.revoked_at AS device_revoked
       FROM refresh_tokens rt JOIN devices d ON d.id = rt.device_id WHERE rt.token_hash=$1 FOR UPDATE OF rt`,
      [tokenHash(refreshToken)],
    );
    if (!rt || rt.client_device_id !== clientDeviceId || rt.device_revoked) return { error: 'Invalid refresh token' } as const;
    if (rt.used_at || rt.revoked_at) {
      if (rt.used_at) {
        // Reuse of a rotated token: assume theft and kill the family. Committed before we reject.
        await c.query('UPDATE refresh_tokens SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL', [rt.family_id]);
        c.afterCommit(() => ctx.log.warn({ device: rt.device_id }, 'refresh token reuse detected; family revoked'));
      }
      return { error: 'Refresh token no longer valid' } as const;
    }
    if (rt.expires_at < new Date()) return { error: 'Refresh token expired' } as const;
    await c.query('UPDATE refresh_tokens SET used_at=now() WHERE id=$1', [rt.id]);
    const user = await one(c, 'SELECT * FROM users WHERE id=$1', [rt.user_id]);
    if (user.status === 'blocked' && rt.app !== 'patient') throw new AppError('FORBIDDEN', 'Account blocked');
    const roles = (await many<{ role: string }>(c, 'SELECT role FROM user_roles WHERE user_id=$1', [rt.user_id])).map((r) => r.role);
    const prov = rt.app === 'provider' ? await maybeOne(c, 'SELECT id FROM providers WHERE user_id=$1', [rt.user_id]) : null;
    return { tokens: await issueTokens(ctx, c, { userId: rt.user_id, roles, deviceId: rt.device_id, app: rt.app, providerId: prov?.id }, rt.family_id) };
  });
  if ('error' in result) throw new AppError('UNAUTHENTICATED', result.error);
  return result.tokens;
}

export async function logout(ctx: Ctx, deviceId: string) {
  await ctx.db.query('UPDATE refresh_tokens SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL', [deviceId]);
  await ctx.db.query('UPDATE devices SET revoked_at=now(), push_token=NULL WHERE id=$1', [deviceId]);
}

export const publicUser = (u: any, roles: string[]) => ({
  id: u.id as string,
  phone: u.phone_e164 as string,
  name: (u.name as string | null) ?? null,
  preferred_language: u.preferred_language as string,
  roles,
});
