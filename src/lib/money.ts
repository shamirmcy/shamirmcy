/** All money is integer paise. These helpers never produce fractions. */
export type Paise = number;

export const rupees = (r: number): Paise => Math.round(r * 100);

export function assertPaise(v: number): Paise {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Invalid paise amount: ${v}`);
  return v;
}

export type PayoutRule =
  | { type: 'percent_fee'; fee_bps: number } // platform keeps fee_bps/10000
  | { type: 'full' } // provider gets 100%
  | { type: 'fixed'; provider_paise: number }
  | { type: 'none' }; // not paid to an individual provider (platform / partner revenue)

export function splitPayout(gross: Paise, rule: PayoutRule): { net: Paise; fee: Paise } {
  switch (rule.type) {
    case 'percent_fee': {
      const fee = Math.round((gross * rule.fee_bps) / 10000);
      return { net: gross - fee, fee };
    }
    case 'full':
      return { net: gross, fee: 0 };
    case 'fixed':
      return { net: Math.min(rule.provider_paise, gross), fee: gross - Math.min(rule.provider_paise, gross) };
    case 'none':
      return { net: 0, fee: gross };
  }
}

export const formatINR = (p: Paise) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(p / 100);
