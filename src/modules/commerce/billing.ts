import type { Ctx } from '../../context.js';
import { many, maybeOne, one, type Queryable } from '../../lib/db.js';
import { splitPayout, type PayoutRule } from '../../lib/money.js';
import type { LineItem } from '../catalogue/defs.js';

export async function issueInvoice(c: Queryable, a: { userId: string; targetType: string; targetId: string; lineItems: unknown[]; totalPaise: number }) {
  const existing = await maybeOne(c, 'SELECT * FROM invoices WHERE target_type=$1 AND target_id=$2', [a.targetType, a.targetId]);
  if (existing) return existing;
  const seq = await one(c, `SELECT nextval('invoice_number_seq') AS n`);
  const fy = financialYear(new Date());
  return one(
    c,
    `INSERT INTO invoices (number, user_id, target_type, target_id, line_items, total_paise) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [`KMD/${fy}/${String(seq.n).padStart(6, '0')}`, a.userId, a.targetType, a.targetId, JSON.stringify(a.lineItems), a.totalPaise],
  );
}

/** Indian financial year label, e.g. 2026-27. */
function financialYear(d: Date) {
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/**
 * Ledger lines for providers from each line item's payout_rule.
 *  - `{ visitSeq }`: per-visit lines for that one completed visit (code suffixed `#seq`);
 *  - `{ final: true }`: the once-per-request lines, when the request completes.
 */
export async function createPayoutLines(c: Queryable, requestId: string, opts: { visitSeq: number } | { final: true }) {
  const sr = await one(c, 'SELECT line_items FROM service_requests WHERE id=$1', [requestId]);
  const team = await many(
    c,
    `SELECT ra.provider_id, p.role FROM request_assignments ra JOIN providers p ON p.id=ra.provider_id WHERE ra.request_id=$1 AND ra.outcome='accepted'`,
    [requestId],
  );
  for (const li of sr.line_items as LineItem[]) {
    if (!li.payee_role) continue;
    const perVisit = Boolean(li.per_visit);
    if ('visitSeq' in opts !== perVisit) continue;
    const payee = team.find((t) => t.role === li.payee_role);
    if (!payee) continue;
    const gross = perVisit ? li.unit_price_paise : li.amount_paise;
    const code = 'visitSeq' in opts ? `${li.option_code}#${opts.visitSeq}` : li.option_code;
    const { net, fee } = splitPayout(gross, li.payout_rule as PayoutRule);
    await c.query(
      `INSERT INTO payout_lines (provider_id, request_id, option_code, gross_paise, platform_fee_paise, net_paise)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [payee.provider_id, requestId, code, gross, fee, net],
    );
  }
}

/** Job (weekly, Monday 02:00 IST): roll unpaid ledger lines into payouts for the previous week. */
export async function runWeeklyPayouts(ctx: Ctx, now = new Date()) {
  const periodEnd = new Date(now);
  const periodStart = new Date(now.getTime() - 7 * 86400 * 1000);
  const groups = await many(
    ctx.db,
    `SELECT provider_id, sum(gross_paise)::int AS gross, sum(platform_fee_paise)::int AS fee, sum(net_paise)::int AS net
     FROM payout_lines WHERE payout_id IS NULL AND created_at < $1 GROUP BY provider_id`,
    [periodEnd],
  );
  const { formatINR } = await import('../../lib/money.js');
  const { notify } = await import('../notifications/service.js');
  for (const g of groups) {
    const p = await one(
      ctx.db,
      `INSERT INTO payouts (provider_id, period_start, period_end, gross_paise, platform_fee_paise, net_paise, status, sent_at)
       VALUES ($1,$2::date,$3::date,$4,$5,$6,'sent',now())
       ON CONFLICT (provider_id, period_start, period_end) DO UPDATE SET gross_paise=payouts.gross_paise
       RETURNING id, net_paise`,
      [g.provider_id, periodStart, periodEnd, g.gross, g.fee, g.net],
    );
    await ctx.db.query('UPDATE payout_lines SET payout_id=$1 WHERE provider_id=$2 AND payout_id IS NULL AND created_at < $3', [p.id, g.provider_id, periodEnd]);
    // Bank transfer itself goes through the payout rail (open item); we record and notify.
    const u = await one(ctx.db, 'SELECT user_id FROM providers WHERE id=$1', [g.provider_id]);
    await notify(ctx, u.user_id, 'payout_sent', { amount: formatINR(p.net_paise) });
  }
  return groups.length;
}
