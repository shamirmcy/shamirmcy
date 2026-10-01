export interface SmsAdapter {
  sendOtp(phoneE164: string, code: string): Promise<void>;
  send(phoneE164: string, text: string, channel: 'sms' | 'whatsapp'): Promise<void>;
  voiceCall(phoneE164: string, text: string): Promise<void>;
}

/** Development / test adapter. Keeps the last OTP per phone in memory so tests can read it. Never used in production. */
export class ConsoleSmsAdapter implements SmsAdapter {
  readonly lastOtp = new Map<string, string>();
  readonly sent: Array<{ to: string; text: string; channel: string }> = [];
  constructor(private readonly echo = false) {}
  async sendOtp(phone: string, code: string) {
    this.lastOtp.set(phone, code);
    // Local development only (production refuses SMS_PROVIDER=console).
    if (this.echo) console.info(`[dev-sms] OTP for ${phone.slice(0, 3)}******${phone.slice(-4)}: ${code}`);
  }
  async send(to: string, text: string, channel: 'sms' | 'whatsapp') {
    this.sent.push({ to, text, channel });
  }
  async voiceCall(to: string, text: string) {
    this.sent.push({ to, text, channel: 'voice' });
  }
}

/** MSG91 (India DLT-compliant SMS/OTP). WhatsApp and voice need provider-specific flows; wire them when chosen (open item). */
export class Msg91SmsAdapter implements SmsAdapter {
  constructor(
    private readonly authKey: string,
    private readonly otpTemplateId: string,
  ) {}
  async sendOtp(phone: string, code: string) {
    const res = await fetch('https://control.msg91.com/api/v5/otp', {
      method: 'POST',
      headers: { authkey: this.authKey, 'content-type': 'application/json' },
      body: JSON.stringify({ template_id: this.otpTemplateId, mobile: phone.replace('+', ''), otp: code }),
    });
    if (!res.ok) throw new Error(`MSG91 OTP send failed: ${res.status}`);
  }
  async send(phone: string, text: string) {
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: this.authKey, 'content-type': 'application/json' },
      body: JSON.stringify({ recipients: [{ mobiles: phone.replace('+', ''), message: text }] }),
    });
    if (!res.ok) throw new Error(`MSG91 send failed: ${res.status}`);
  }
  async voiceCall(): Promise<void> {
    throw new Error('Voice channel not configured');
  }
}
