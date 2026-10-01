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

/** A refund counts against the payment unless it failed and retries have given up. */
export const REFUND_RESERVED = `(r.status <> 'failed' OR r.gave_up_at IS NULL)`;

/** Net amount captured for a target (captured payments minus refunds made or still being retried). */
export async function netCaptured(db: Queryable, targetType: string, targetId: string) {
  const r = await one(
    db,
    `SELECT COALESCE(sum(p.amount_paise),0)::int AS paid,
            COALESCE((SELECT sum(r.amount_paise) FROM refunds r JOIN payments p2 ON p2.id=r.payment_id
                      WHERE p2.target_type=$1 AND p2.target_id=$2 AND ${REFUND_RESERVED}),0)::int AS refunded
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
      `SELECT p.*, p.amount_paise - COALESCE((SELECT sum(amount_paise) FROM refunds r WHERE r.payment_id=p.id AND ${REFUND_RESERVED}),0)::int AS refundable
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
      let error: string | null = null;
      if (p.method !== 'cash') {
        try {
          gatewayRefundId = (await ctx.adapters.payments.refund(p.gateway_payment_id ?? p.gateway_order_id, amount)).refundId;
        } catch (e) {
          status = 'failed'; // retried automatically by the refunds.retry job
          error = (e as Error).message.slice(0, 300);
          ctx.log.error({ payment: p.id, err: error }, 'settlement refund failed; will retry');
        }
      } else {
        status = 'pending'; // cash: paid back by the ops desk
      }
      await c.query(
        `INSERT INTO refunds (payment_id, amount_paise, reason, status, gateway_refund_id, source, last_error, next_retry_at)
         VALUES ($1,$2,$3,$4,$5,'settlement',$6, CASE WHEN $4='failed' THEN now() + make_interval(mins => $7) END)`,
        [p.id, amount, 'Settlement: amount paid above final bill', status, gatewayRefundId, error, retryDelayMinutes(1)],
      );
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

// ───────────────────────────── Refund retries ─────────────────────────────

export const MAX_REFUND_ATTEMPTS = 6;
/** 5, 10, 20, 40, 80 minutes between attempts. */
export const retryDelayMinutes = (attempts: number) => 5 * 2 ** (attempts - 1);

/** Recompute a payment's status from its refunds that have actually gone through. */
async function refreshPaymentRefundStatus(c: Queryable, paymentId: string) {
  await c.query(
    `UPDATE payments p SET status = CASE
        WHEN x.done >= p.amount_paise THEN 'refunded'
        WHEN x.done > 0 THEN 'partially_refunded'
        ELSE p.status END
     FROM (SELECT COALESCE(sum(amount_paise),0)::int AS done FROM refunds WHERE payment_id=$1 AND status IN ('processed','pending')) x
     WHERE p.id=$1 AND p.status IN ('captured','partially_refunded','refunded')`,
    [paymentId],
  );
}

/**
 * Job (every 15 min): retry gateway refunds that failed, with backoff. After MAX_REFUND_ATTEMPTS
 * the refund is given up and ops is alerted to handle it by hand. A retry never refunds more than
 * the payment still has available.
 */
export async function retryFailedRefunds(ctx: Ctx) {
  const due = await many(
    ctx.db,
    `SELECT id FROM refunds WHERE status='failed' AND gave_up_at IS NULL AND next_retry_at IS NOT NULL AND next_retry_at <= now() ORDER BY next_retry_at LIMIT 50`,
  );
  let processed = 0;
  for (const { id } of due) {
    const ok = await tx(ctx.db, async (c) => {
      const r = await maybeOne(
        c,
        `SELECT r.*, p.method, p.gateway_payment_id, p.gateway_order_id, p.amount_paise AS paid, p.user_id, p.target_type, p.target_id
         FROM refunds r JOIN payments p ON p.id=r.payment_id
         WHERE r.id=$1 AND r.status='failed' AND r.gave_up_at IS NULL FOR UPDATE OF r SKIP LOCKED`,
        [id],
      );
      if (!r) return false;
      const others = await one(c, `SELECT COALESCE(sum(amount_paise),0)::int AS n FROM refunds WHERE payment_id=$1 AND id<>$2 AND status IN ('processed','pending')`, [r.payment_id, r.id]);
      if (others.n + r.amount_paise > r.paid) {
        // Someone (e.g. ops) already refunded this money another way.
        await c.query(`UPDATE refunds SET gave_up_at=now(), last_error='superseded: payment already refunded' WHERE id=$1`, [r.id]);
        return false;
      }
      try {
        const res = await ctx.adapters.payments.refund(r.gateway_payment_id ?? r.gateway_order_id, r.amount_paise);
        await c.query(`UPDATE refunds SET status='processed', gateway_refund_id=$2, attempts=attempts+1, last_error=NULL, next_retry_at=NULL WHERE id=$1`, [r.id, res.refundId]);
        await refreshPaymentRefundStatus(c, r.payment_id);
        const { formatINR } = await import('../../lib/money.js');
        c.afterCommit(() => notify(ctx, r.user_id, 'refund_issued', { amount: formatINR(r.amount_paise) }));
        return true;
      } catch (e) {
        const attempts = r.attempts + 1;
        const giveUp = attempts >= MAX_REFUND_ATTEMPTS;
        await c.query(
          `UPDATE refunds SET attempts=$2, last_error=$3, next_retry_at = CASE WHEN $4 THEN NULL ELSE now() + make_interval(mins => $5) END,
             gave_up_at = CASE WHEN $4 THEN now() END WHERE id=$1`,
          [r.id, attempts, (e as Error).message.slice(0, 300), giveUp, retryDelayMinutes(attempts)],
        );
        if (giveUp) {
          c.afterCommit(() =>
            ctx.realtime.publish('ops', 'refund.failed_permanently', { refund_id: r.id, payment_id: r.payment_id, amount_paise: r.amount_paise, target_type: r.target_type, target_id: r.target_id }),
          );
        }
        return false;
      }
    });
    if (ok) processed++;
  }
  return processed;
}

