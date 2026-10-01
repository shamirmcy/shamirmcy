import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type OtpLang = 'en' | 'ta' | 'kn' | 'hi';

/** WhatsApp messages. OTPs use a pre-approved "authentication" template. */
export interface WhatsAppAdapter {
  readonly enabled: boolean;
  /** Returns the provider message id, used to match later delivery-status webhooks. */
  sendOtp(phoneE164: string, code: string, lang: OtpLang): Promise<{ messageId: string }>;
  /** Verifies the X-Hub-Signature-256 header of a status webhook. */
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
}

/** Development / test adapter: records OTPs in the shared dev inbox. Never used in production. */
export class ConsoleWhatsAppAdapter implements WhatsAppAdapter {
  readonly enabled = true;
  /** Number of upcoming sends that should fail (simulates WhatsApp outages). */
  failNext = 0;
  readonly sent: Array<{ to: string; code: string; lang: OtpLang; messageId: string }> = [];
  constructor(
    private readonly inbox: Map<string, string>,
    private readonly echo = false,
    private readonly webhookSecret = 'dev-only-whatsapp-secret',
  ) {}
  async sendOtp(to: string, code: string, lang: OtpLang) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('WhatsApp unavailable');
    }
    const messageId = `wamid.dev.${randomUUID()}`;
    this.inbox.set(to, code);
    this.sent.push({ to, code, lang, messageId });
    if (this.echo) console.info(`[dev-whatsapp] OTP for ${to.slice(0, 3)}******${to.slice(-4)}: ${code}`);
    return { messageId };
  }
  verifyWebhook(rawBody: string, signature: string | undefined) {
    return verifyMetaSignature(this.webhookSecret, rawBody, signature);
  }
}

/** WhatsApp disabled: OTPs go by SMS only. */
export class DisabledWhatsAppAdapter implements WhatsAppAdapter {
  readonly enabled = false;
  async sendOtp(): Promise<{ messageId: string }> {
    throw new Error('WhatsApp is not configured');
  }
  verifyWebhook() {
    return false;
  }
}

/**
 * Meta WhatsApp Cloud API. Needs an approved authentication template (default name `kmdoch_otp`)
 * with a "copy code" button, in each language used (en, ta, kn, hi).
 */
export class MetaWhatsAppAdapter implements WhatsAppAdapter {
  readonly enabled = true;
  constructor(
    private readonly token: string,
    private readonly phoneNumberId: string,
    private readonly templateName: string,
    private readonly appSecret: string,
    private readonly apiVersion = 'v21.0',
  ) {}
  async sendOtp(to: string, code: string, lang: OtpLang) {
    const res = await fetch(`https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace('+', ''),
        type: 'template',
        template: {
          name: this.templateName,
          language: { code: lang },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`WhatsApp send failed: ${res.status}`);
    const body = (await res.json()) as { messages?: Array<{ id: string }> };
    const messageId = body.messages?.[0]?.id;
    if (!messageId) throw new Error('WhatsApp send returned no message id');
    return { messageId };
  }
  verifyWebhook(rawBody: string, signature: string | undefined) {
    return verifyMetaSignature(this.appSecret, rawBody, signature);
  }
}

export function verifyMetaSignature(secret: string, rawBody: string, signature: string | undefined) {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(signature.slice(7));
  return expected.length === got.length && timingSafeEqual(expected, got);
}
