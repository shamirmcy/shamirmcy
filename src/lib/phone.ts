import { z } from 'zod';

/** Accepts 10-digit Indian mobiles with optional +91 / 91 / 0 prefix; normalises to E.164. */
export function normalizeIndianPhone(input: string): string | null {
  const digits = input.replace(/[\s-()]/g, '');
  const m = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(digits);
  return m ? `+91${m[1]}` : null;
}

export const PhoneSchema = z
  .string()
  .transform((v, ctx) => {
    const n = normalizeIndianPhone(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit Indian mobile number' });
      return z.NEVER;
    }
    return n;
  });

export const maskPhone = (e164: string) => `${e164.slice(0, 3)}******${e164.slice(-4)}`;
