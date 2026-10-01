import type { Ctx } from '../../context.js';
import { many, maybeOne } from '../../lib/db.js';
import { render, type Lang, type NotificationEvent } from './templates.js';

/** Events that escalate to a voice call if push and SMS cannot be confirmed. */
const VOICE_EVENTS = new Set<NotificationEvent>(['provider_at_door', 'emergency_dispatched']);

export async function notify(
  ctx: Ctx,
  userId: string,
  event: NotificationEvent,
  params: Record<string, string | number>,
  opts: { urgent?: boolean } = {},
) {
  await ctx.jobs.enqueue('notify', { userId, event, params, urgent: Boolean(opts.urgent) });
}

/** Channel order: push → SMS/WhatsApp → voice (door / emergency only). */
export async function deliver(ctx: Ctx, data: { userId: string; event: NotificationEvent; params: Record<string, string | number>; urgent: boolean }) {
  const user = await maybeOne(ctx.db, 'SELECT id, phone_e164, preferred_language FROM users WHERE id=$1', [data.userId]);
  if (!user) return;
  const lang = user.preferred_language as Lang;
  const msg = render(data.event, lang, data.params);
  const log = (channel: string, status: string, error?: string) =>
    ctx.db.query('INSERT INTO notifications (user_id, event, language, channel, status, error) VALUES ($1,$2,$3,$4,$5,$6)', [
      user.id,
      data.event,
      lang,
      channel,
      status,
      error ?? null,
    ]);

  const devices = await many(ctx.db, 'SELECT push_token FROM devices WHERE user_id=$1 AND revoked_at IS NULL AND push_token IS NOT NULL', [user.id]);
  let pushed = false;
  for (const d of devices) {
    try {
      await ctx.adapters.push.send(d.push_token, msg.title, msg.body, { event: data.event });
      pushed = true;
    } catch (e) {
      await log('push', 'failed', (e as Error).message);
    }
  }
  if (pushed) await log('push', 'sent');

  if (!pushed || data.urgent) {
    try {
      await ctx.adapters.sms.send(user.phone_e164, `${msg.title}: ${msg.body}`, 'sms');
      await log('sms', 'sent');
    } catch (e) {
      await log('sms', 'failed', (e as Error).message);
    }
  }
  if (data.urgent && VOICE_EVENTS.has(data.event)) {
    try {
      await ctx.adapters.sms.voiceCall(user.phone_e164, msg.body);
      await log('voice', 'sent');
    } catch (e) {
      await log('voice', 'failed', (e as Error).message);
    }
  }
}
