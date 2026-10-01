import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Field-level encryption for health data (AES-256-GCM). Database volumes must also be
 * encrypted at rest; this is defence in depth so dumps/replicas/logs never hold plaintext.
 * Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 */
export class FieldCipher {
  private readonly key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (base64)');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(token: string): string {
    const [v, iv, tag, ct] = token.split('.');
    if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported ciphertext');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  encryptJson(v: unknown): string | null {
    return v === undefined || v === null ? null : this.encrypt(JSON.stringify(v));
  }

  decryptJson<T>(token: string | null | undefined, fallback: T): T {
    return token ? (JSON.parse(this.decrypt(token)) as T) : fallback;
  }
}

export const hmac = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const numericCode = (digits: number) =>
  Array.from({ length: digits }, () => randomInt(0, 10)).join('');

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
