import type { Ctx } from '../../context.js';
import { many, maybeOne, one, tx, type Queryable, type TxClient } from '../../lib/db.js';
import type { LineItem } from '../catalogue/defs.js';
import { notify } from '../notifications/service.js';
import { issueInvoice } from './billing.js';

export interface BilledLine {
  code: string;
  name: string;
  qty: number;
  quoted_paise: number;
  amount_paise: number;
  note?: string;
}

/**
 * What the patient actually owes for a request:
 *  - per-visit lines are billed only for completed visits (series stopped early, skipped, missed);
 *  - other lines are billed once if at least one visit was completed;
 *  - estimated lines ("up to ₹600", "~₹120") are billed at the recorded actual cost, never above the quote;
 *  - plus any cancellation fee.
 */
export async function computeBill(db: Queryable, requestId: string, outcome: 'completed' | 'cancelled') {
  const sr = await one(db, 'SELECT line_items, cancellation_fee_paise FROM service_requests WHERE id=$1', [requestId]);
  const done = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM visit_occurrences WHERE request_id=$1 AND status='completed'`, [requestId]);
  const adjustments = new Map(
    (await many(db, 'SELECT option_code, actual_paise FROM request_adjustments WHERE request_id=$1', [requestId])).map((a) => [a.option_code as string, a.actual_paise as number]),
  );
  const lines: BilledLine[] = [];
  for (const li of sr.line_items as LineItem[]) {
    const qty = li.per_visit ? Math.min(done.n, li.qty) : done.n > 0 ? li.qty : 0;
    let amount = li.unit_price_paise * qty;
    let note: string | undefined;
    if (li.per_visit && qty < li.qty) note = `${qty} of ${li.qty} visits completed`;
    const actual = adjustments.get(li.option_code);
    if (li.estimate && actual !== undefined && qty > 0) {
      if (actual < amount) note = 'Actual cost (quoted as an estimate)';
      amount = Math.min(amount, actual);
    }
    lines.push({ code: li.option_code, name: li.name, qty, quoted_paise: li.amount_paise, amount_paise: amount, ...(note ? { note } : {}) });
  }
  const fee = outcome === 'cancelled' ? Number(sr.cancellation_fee_paise ?? 0) : 0;
  if (fee > 0) lines.push({ code: 'cancellation_fee', name: 'Cancellation fee', qty: 1, quoted_paise: fee, amount_paise: fee });
  const billable = lines.filter((l) => l.amount_paise > 0);
  return { lines: billable, total: billable.reduce((s, l) => s + l.amount_paise, 0) };
}

/** Net amount captured for a target (captured payments minus non-failed refunds). */
export async function netCaptured(db: Queryable, targetType: string, targetId: string) {
  const r = await one(
    db,
    `SELECT COALESCE(sum(p.amount_paise),0)::int AS paid,
            COALESCE((SELECT sum(r.amount_paise) FROM refunds r JOIN payments p2 ON p2.id=r.payment_id
                      WHERE p2.target_type=$1 AND p2.target_id=$2 AND r.status <> 'failed'),0)::int AS refunded
     FROM payments p WHERE p.target_type=$1 AND p.target_id=$2 AND p.status IN ('captured','partially_refunded','refunded')`,
    [targetType, targetId],
  );
  return r.paid - r.refunded;
}

/**
 * Close the books on a request (once): final total, invoice, and — after commit — an automatic
 * refund of anything paid above the final total.
 */
export async function settleRequest(ctx: Ctx, c: TxClient, requestId: string, outcome: 'completed' | 'cancelled') {
  const sr = await one(c, 'SELECT * FROM service_requests WHERE id=$1 FOR UPDATE', [requestId]);
  if (sr.settled_at) {
    return { final_total_paise: sr.final_total_paise as number, refund_due_paise: Math.max(0, (await netCaptured(c, 'service_request', requestId)) - sr.final_total_paise) };
  }
  const bill = await computeBill(c, requestId, outcome);
  await c.query('UPDATE service_requests SET final_total_paise=$2, settled_at=now() WHERE id=$1', [requestId, bill.total]);
  if (bill.total > 0) {
    await issueInvoice(c, { userId: sr.booked_by_user_id, targetType: 'service_request', targetId: requestId, lineItems: bill.lines, totalPaise: bill.total });
  }
  const refundDue = Math.max(0, (await netCaptured(c, 'service_request', requestId)) - bill.total);
  if (refundDue > 0) c.afterCommit(() => refundOverpayment(ctx, requestId));
  return { final_total_paise: bill.total, refund_due_paise: refundDue };
}

/** Refund the difference between what was captured and the settled total, newest payment first. */
export async function refundOverpayment(ctx: Ctx, requestId: string) {
  return tx(ctx.db, async (c) => {
    const sr = await one(c, 'SELECT booked_by_user_id, final_total_paise FROM service_requests WHERE id=$1 FOR UPDATE', [requestId]);
    if (sr.final_total_paise == null) return { refunded_paise: 0 };
    let excess = (await netCaptured(c, 'service_request', requestId)) - sr.final_total_paise;
    if (excess <= 0) return { refunded_paise: 0 };
    const payments = await many(
      c,
      `SELECT p.*, p.amount_paise - COALESCE((SELECT sum(amount_paise) FROM refunds r WHERE r.payment_id=p.id AND r.status <> 'failed'),0)::int AS refundable
       FROM payments p WHERE p.target_type='service_request' AND p.target_id=$1 AND p.status IN ('captured','partially_refunded')
       ORDER BY p.created_at DESC FOR UPDATE`,
      [requestId],
    );
    let refunded = 0;
    for (const p of payments) {
      if (excess <= 0) break;
      const amount = Math.min(excess, p.refundable);
      if (amount <= 0) continue;
      let status = 'processed';
      let gatewayRefundId: string | null = null;
      if (p.method !== 'cash') {
        try {
          gatewayRefundId = (await ctx.adapters.payments.refund(p.gateway_payment_id ?? p.gateway_order_id, amount)).refundId;
        } catch (e) {
          status = 'failed'; // ops sees failed settlement refunds and retries
          ctx.log.error({ payment: p.id, err: (e as Error).message }, 'settlement refund failed');
        }
      } else {
        status = 'pending'; // cash: paid back by the ops desk
      }
      await c.query(`INSERT INTO refunds (payment_id, amount_paise, reason, status, gateway_refund_id, source) VALUES ($1,$2,$3,$4,$5,'settlement')`, [
        p.id,
        amount,
        'Settlement: amount paid above final bill',
        status,
        gatewayRefundId,
      ]);
      if (status !== 'failed') {
        const left = p.refundable - amount;
        await c.query('UPDATE payments SET status=$2 WHERE id=$1', [p.id, left === 0 ? 'refunded' : 'partially_refunded']);
        refunded += amount;
        excess -= amount;
      }
    }
    if (refunded > 0) {
      const { formatINR } = await import('../../lib/money.js');
      c.afterCommit(() => notify(ctx, sr.booked_by_user_id, 'refund_issued', { amount: formatINR(refunded) }));
    }
    return { refunded_paise: refunded };
  });
}

/** Amount still payable on a request (settled total if known, else the quote) minus what's been captured. */
export async function amountDue(db: Queryable, requestId: string) {
  const sr = await maybeOne(db, 'SELECT COALESCE(final_total_paise, total_paise) AS total FROM service_requests WHERE id=$1', [requestId]);
  if (!sr) return 0;
  return Math.max(0, sr.total - (await netCaptured(db, 'service_request', requestId)));
}
