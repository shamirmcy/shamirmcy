import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, maybeOne, one, tx } from '../../lib/db.js';
import { haversineMeters } from '../../lib/geo.js';
import { assertCanBook } from '../access.js';
import { consumeQuote, loadService } from '../catalogue/service.js';
import { assertDispatchable } from '../clinical/service.js';
import { notify } from '../notifications/service.js';
import { assertAccountActive, zoneForAddress } from '../requests/service.js';

// ───────────────────────────── Pharmacy ─────────────────────────────

const RX_SCHEDULES = new Set(['H', 'H1', 'X']);

export async function createPharmacyOrder(
  ctx: Ctx,
  userId: string,
  input: { patient_id: string; address_id: string; items: Array<{ sku: string; qty: number }>; prescription_id?: string },
) {
  return tx(ctx.db, async (c) => {
    await assertAccountActive(c, userId);
    await assertCanBook(c, userId, input.patient_id);
    const addr = await maybeOne(c, 'SELECT id FROM addresses WHERE id=$1 AND patient_id=$2 AND deleted_at IS NULL', [input.address_id, input.patient_id]);
    if (!addr) throw new AppError('VALIDATION_ERROR', 'Address does not belong to this patient');
    const zone = await zoneForAddress(c, input.address_id);
    if (!zone) throw new AppError('NOT_SERVICEABLE', 'We do not deliver to this area yet');

    const meds = await many(c, 'SELECT * FROM medicines WHERE sku = ANY($1) AND active', [input.items.map((i) => i.sku)]);
    const bySku = new Map(meds.map((m) => [m.sku as string, m]));
    const lines = input.items.map((i) => {
      const m = bySku.get(i.sku);
      if (!m) throw new AppError('VALIDATION_ERROR', `Medicine ${i.sku} is not available`);
      return { m, qty: i.qty, total: m.mrp_paise * i.qty };
    });
    const requiresRx = lines.some((l) => RX_SCHEDULES.has(l.m.schedule));
    if (requiresRx) {
      if (!input.prescription_id) throw new AppError('PRESCRIPTION_REQUIRED', 'Schedule H medicines need a signed prescription');
      const rx = await maybeOne(c, `SELECT status FROM prescriptions WHERE id=$1 AND patient_id=$2`, [input.prescription_id, input.patient_id]);
      if (!rx || rx.status !== 'signed') throw new AppError('PRESCRIPTION_REQUIRED', 'Schedule H medicines need a signed prescription');
    }
    const pharmacy = await maybeOne(c, `SELECT id FROM partners WHERE kind='pharmacy' AND active AND $1 = ANY(service_area_zone_ids) ORDER BY created_at LIMIT 1`, [zone.id]);
    const total = lines.reduce((s, l) => s + l.total, 0);
    const o = await one(
      c,
      `INSERT INTO pharmacy_orders (patient_id, booked_by_user_id, address_id, pharmacy_partner_id, prescription_id, status, requires_rx, total_paise)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, status`,
      [input.patient_id, userId, input.address_id, pharmacy?.id ?? null, input.prescription_id ?? null, requiresRx ? 'pending_verification' : 'placed', requiresRx, total],
    );
    for (const l of lines) {
      await c.query(
        `INSERT INTO pharmacy_order_items (order_id, medicine_id, name, schedule, qty, unit_price_paise, line_total_paise) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [o.id, l.m.id, `${l.m.name} ${l.m.strength ?? ''}`.trim(), l.m.schedule, l.qty, l.m.mrp_paise, l.total],
      );
    }
    return { id: o.id as string, status: o.status as string, requires_rx: requiresRx, total_paise: total, items: lines.map((l) => ({ sku: l.m.sku, name: l.m.name, qty: l.qty, unit_price_paise: l.m.mrp_paise, amount_paise: l.total })) };
  });
}

const PHARMACY_FLOW: Record<string, string[]> = {
  placed: ['packed', 'cancelled'],
  verified: ['packed', 'cancelled'],
  packed: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered'],
};

export async function updatePharmacyStatus(ctx: Ctx, partnerId: string, orderId: string, status: string) {
  return tx(ctx.db, async (c) => {
    const o = await maybeOne(c, 'SELECT * FROM pharmacy_orders WHERE id=$1 AND pharmacy_partner_id=$2 FOR UPDATE', [orderId, partnerId]);
    if (!o) throw new AppError('NOT_FOUND', 'Order not found');
    if (!PHARMACY_FLOW[o.status]?.includes(status)) throw new AppError('INVALID_TRANSITION', `Cannot move from ${o.status} to ${status}`);
    if (o.requires_rx && ['packed', 'out_for_delivery'].includes(status)) {
      if (!o.verified_at) throw new AppError('FORBIDDEN', 'Pharmacist verification required');
      await assertDispatchable(c, o.prescription_id, o.patient_id);
    }
    await c.query('UPDATE pharmacy_orders SET status=$2, courier_location = CASE WHEN $2 = $3 THEN NULL ELSE courier_location END WHERE id=$1', [orderId, status, 'delivered']);
    c.afterCommit(async () => {
      await ctx.realtime.publish(ctx.realtime.patientChannel(o.booked_by_user_id), 'order.status', { kind: 'pharmacy_order', id: orderId, status });
      if (status === 'out_for_delivery') await notify(ctx, o.booked_by_user_id, 'medicine_out_for_delivery', {});
    });
    return { id: orderId, status };
  });
}

export async function verifyPharmacyOrder(ctx: Ctx, partnerId: string, pharmacistUserId: string, orderId: string, approve: boolean) {
  const o = await maybeOne(ctx.db, 'SELECT * FROM pharmacy_orders WHERE id=$1 AND pharmacy_partner_id=$2', [orderId, partnerId]);
  if (!o) throw new AppError('NOT_FOUND', 'Order not found');
  if (o.status !== 'pending_verification') throw new AppError('INVALID_TRANSITION', 'Order is not awaiting verification');
  if (approve) await assertDispatchable(ctx.db, o.prescription_id, o.patient_id);
  await ctx.db.query(`UPDATE pharmacy_orders SET status=$2, verified_by=$3, verified_at=CASE WHEN $4 THEN now() END WHERE id=$1`, [
    orderId,
    approve ? 'verified' : 'rejected',
    pharmacistUserId,
    approve,
  ]);
  return { id: orderId, status: approve ? 'verified' : 'rejected' };
}

// ───────────────────────────── Equipment ─────────────────────────────

export async function createRental(ctx: Ctx, userId: string, input: { quote_token: string; patient_id: string; address_id: string; start_date: string }) {
  return tx(ctx.db, async (c) => {
    await assertAccountActive(c, userId);
    await assertCanBook(c, userId, input.patient_id);
    const q = await consumeQuote(ctx, c, input.quote_token, userId, 'equipment_rental');
    const addr = await maybeOne(c, 'SELECT id FROM addresses WHERE id=$1 AND patient_id=$2 AND deleted_at IS NULL', [input.address_id, input.patient_id]);
    if (!addr) throw new AppError('VALIDATION_ERROR', 'Address does not belong to this patient');
    const zone = await zoneForAddress(c, input.address_id);
    if (!zone) throw new AppError('NOT_SERVICEABLE', 'We do not serve this area yet');
    const supplier = await maybeOne(c, `SELECT id FROM partners WHERE kind='equipment' AND active AND $1 = ANY(service_area_zone_ids) ORDER BY created_at LIMIT 1`, [zone.id]);
    const { item, rate_type, quantity } = q.options;
    const r = await one(
      c,
      `INSERT INTO equipment_rentals (patient_id, booked_by_user_id, address_id, item, rate_type, quantity, start_date, end_date, rate_paise, total_paise, supplier_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date, ($7::date + ($6 * CASE WHEN $5='month' THEN 30 ELSE 1 END)), $8,$9,$10) RETURNING id, end_date, status`,
      [input.patient_id, userId, input.address_id, item, rate_type, quantity, input.start_date, q.line_items[0]!.unit_price_paise, q.total_paise, supplier?.id ?? null],
    );
    return { id: r.id, status: r.status, start_date: input.start_date, end_date: r.end_date, total_paise: q.total_paise, supplier_assigned: Boolean(supplier) };
  });
}

// ───────────────────────────── Ambulance ─────────────────────────────

/**
 * Emergency: never blocked by payment, KYC or account flags. Nearest suitable vehicle is assigned
 * automatically; ops is paged if the crew doesn't acknowledge in 45 s; 108 is always offered.
 */
export async function createAmbulanceRun(
  ctx: Ctx,
  userId: string,
  input: { type: 'normal' | 'oxygen' | 'ventilator'; patient_id?: string; pickup?: { lat: number; lng: number }; address_id?: string; destination_facility_id?: string; payment_method?: 'upi' | 'card' | 'cash' },
) {
  let pickup = input.pickup;
  if (input.address_id) {
    const a = await maybeOne(ctx.db, 'SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM addresses WHERE id=$1', [input.address_id]);
    if (a) pickup = { lat: a.lat, lng: a.lng };
  }
  if (!pickup) throw new AppError('VALIDATION_ERROR', 'Pickup location is required');

  let rate = 0;
  try {
    const { options } = await loadService(ctx.db, 'ambulance');
    rate = options.find((o) => o.code === `per_km_${input.type}`)?.price_paise ?? 0;
  } catch {
    rate = 0; // pricing problems must not block an emergency
  }
  let estimatedKm: number | null = null;
  if (input.destination_facility_id) {
    const f = await maybeOne(ctx.db, 'SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM facilities WHERE id=$1', [input.destination_facility_id]);
    if (f) estimatedKm = Math.round((haversineMeters(pickup, f) * ctx.config.assignment.straightLineFactor) / 100) / 10;
  }

  const run = await tx(ctx.db, async (c) => {
    const vehicle = await maybeOne(
      c,
      `SELECT v.* FROM ambulance_vehicles v JOIN partners p ON p.id=v.partner_id
       WHERE v.available AND p.active AND v.location IS NOT NULL AND v.location_at > now() - interval '15 minutes'
       ORDER BY (v.type = $3) DESC, ST_Distance(v.location, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) LIMIT 1 FOR UPDATE OF v SKIP LOCKED`,
      [pickup!.lng, pickup!.lat, input.type],
    );
    if (vehicle) await c.query('UPDATE ambulance_vehicles SET available=false WHERE id=$1', [vehicle.id]);
    return one(
      c,
      `INSERT INTO ambulance_runs (patient_id, requested_by_user_id, type, pickup, pickup_address_id, vehicle_id, per_km_rate_paise, estimated_km, destination_facility_id, status)
       VALUES ($1,$2,$3, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, $6,$7,$8,$9,$10,$11) RETURNING *`,
      [input.patient_id ?? null, userId, input.type, pickup!.lng, pickup!.lat, input.address_id ?? null, vehicle?.id ?? null, rate, estimatedKm, input.destination_facility_id ?? null, vehicle ? 'dispatched' : 'unassigned'],
    );
  });

  // Payment is best-effort and never blocks dispatch.
  let payment: { status: string; client?: unknown } = { status: 'not_attempted' };
  if (input.payment_method && input.payment_method !== 'cash' && estimatedKm) {
    try {
      const amount = Math.round(rate * estimatedKm);
      const order = await ctx.adapters.payments.createOrder(amount, `amb_${run.id}`, input.payment_method);
      await ctx.db.query(
        `INSERT INTO payments (user_id, target_type, target_id, method, amount_paise, status, gateway, gateway_order_id) VALUES ($1,'ambulance_run',$2,$3,$4,'pending',$5,$6)`,
        [userId, run.id, input.payment_method, amount, order.gateway, order.orderId],
      );
      payment = { status: 'pending', client: order.clientPayload };
    } catch (e) {
      ctx.log.warn({ run: run.id, err: (e as Error).message }, 'ambulance payment failed; dispatch continues');
      payment = { status: 'failed' };
    }
    await ctx.db.query('UPDATE ambulance_runs SET payment_status=$2 WHERE id=$1', [run.id, payment.status]);
  }

  await ctx.jobs.enqueue('ambulance.ack_timeout', { runId: run.id }, { delayMs: ctx.config.ambulance.ackTimeoutSeconds * 1000, jobId: `amb-ack:${run.id}` });
  if (!run.vehicle_id) await ctx.realtime.publish('ops', 'ambulance.unassigned', { run_id: run.id });
  await notify(ctx, userId, 'emergency_dispatched', { emergency_number: ctx.config.ambulance.emergencyNumber }, { urgent: true });

  return {
    id: run.id as string,
    status: run.status as string,
    type: run.type as string,
    vehicle_assigned: Boolean(run.vehicle_id),
    per_km_rate_paise: rate,
    estimated_km: estimatedKm,
    payment,
    escalation_108: escalation(ctx),
  };
}

export const escalation = (ctx: Ctx) => ({
  number: ctx.config.ambulance.emergencyNumber,
  available: true,
  message: 'If this is life-threatening, you can also call 108 (free government ambulance).',
});

export async function ambulanceAckTimeout(ctx: Ctx, runId: string) {
  const r = await maybeOne(
    ctx.db,
    `UPDATE ambulance_runs SET ops_paged_at=now() WHERE id=$1 AND acknowledged_at IS NULL AND ops_paged_at IS NULL AND status IN ('dispatched','unassigned') RETURNING id, vehicle_id`,
    [runId],
  );
  if (r) {
    ctx.log.error({ run_id: runId }, 'ambulance crew did not acknowledge; paging ops');
    await ctx.realtime.publish('ops', 'ambulance.unacknowledged', { run_id: runId, vehicle_id: r.vehicle_id });
  }
}

export async function ambulanceTracking(ctx: Ctx, userId: string, runId: string) {
  const r = await maybeOne(
    ctx.db,
    `SELECT a.*, v.registration_no, v.type AS vehicle_type, ST_Y(v.location::geometry) AS vlat, ST_X(v.location::geometry) AS vlng, v.location_at,
            p.name AS operator, p.phone_e164 AS operator_phone, f.name AS destination
     FROM ambulance_runs a LEFT JOIN ambulance_vehicles v ON v.id=a.vehicle_id LEFT JOIN partners p ON p.id=v.partner_id
     LEFT JOIN facilities f ON f.id=a.destination_facility_id WHERE a.id=$1 AND a.requested_by_user_id=$2`,
    [runId, userId],
  );
  if (!r) throw new AppError('NOT_FOUND', 'Ambulance request not found');
  return {
    id: r.id,
    status: r.status,
    type: r.type,
    vehicle: r.vehicle_id ? { registration_no: r.registration_no, type: r.vehicle_type, operator: r.operator, operator_phone: r.operator_phone } : null,
    // Live map is permitted for ambulances.
    live_location: r.vlat != null ? { lat: r.vlat, lng: r.vlng, at: r.location_at } : null,
    destination: r.destination,
    acknowledged: Boolean(r.acknowledged_at),
    escalated_to_108: r.escalated_to_108,
    escalation_108: escalation(ctx),
  };
}

// ───────────────────────────── Payments ─────────────────────────────

const TARGET_SQL: Record<string, string> = {
  service_request: 'SELECT total_paise AS amount, booked_by_user_id AS owner, status FROM service_requests WHERE id=$1',
  pharmacy_order: 'SELECT total_paise AS amount, booked_by_user_id AS owner, status FROM pharmacy_orders WHERE id=$1',
  equipment_rental: 'SELECT total_paise AS amount, booked_by_user_id AS owner, status FROM equipment_rentals WHERE id=$1',
  ambulance_run: `SELECT COALESCE(total_paise, round(per_km_rate_paise * COALESCE(km, estimated_km, 0))::int) AS amount, requested_by_user_id AS owner, status FROM ambulance_runs WHERE id=$1`,
};

export async function createPayment(ctx: Ctx, userId: string, input: { target_type: string; target_id: string; method: 'upi' | 'card' | 'cash' }) {
  const t = await maybeOne(ctx.db, TARGET_SQL[input.target_type]!, [input.target_id]);
  if (!t || t.owner !== userId) throw new AppError('NOT_FOUND', 'Nothing to pay for');
  const paid = await maybeOne(ctx.db, `SELECT 1 FROM payments WHERE target_type=$1 AND target_id=$2 AND status='captured'`, [input.target_type, input.target_id]);
  if (paid) throw new AppError('CONFLICT', 'Already paid');
  if (input.method === 'cash') {
    const p = await one(ctx.db, `INSERT INTO payments (user_id, target_type, target_id, method, amount_paise, status) VALUES ($1,$2,$3,'cash',$4,'pending') RETURNING id`, [
      userId,
      input.target_type,
      input.target_id,
      t.amount,
    ]);
    return { payment_id: p.id, method: 'cash', amount_paise: t.amount, status: 'pending' };
  }
  try {
    const order = await ctx.adapters.payments.createOrder(t.amount, `${input.target_type}_${input.target_id}`, input.method);
    const p = await one(
      ctx.db,
      `INSERT INTO payments (user_id, target_type, target_id, method, amount_paise, status, gateway, gateway_order_id) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7) RETURNING id`,
      [userId, input.target_type, input.target_id, input.method, t.amount, order.gateway, order.orderId],
    );
    return { payment_id: p.id, method: input.method, amount_paise: t.amount, status: 'pending', checkout: order.clientPayload };
  } catch (e) {
    await ctx.db.query(
      `INSERT INTO payments (user_id, target_type, target_id, method, amount_paise, status, failure_reason) VALUES ($1,$2,$3,$4,$5,'failed',$6)`,
      [userId, input.target_type, input.target_id, input.method, t.amount, (e as Error).message.slice(0, 200)],
    );
    throw new AppError('PAYMENT_FAILED', 'Payment could not be started. Try again or pay by cash.');
  }
}

/** Gateway webhook is the source of truth for payment state. Deduplicated by event id. */
export async function handlePaymentWebhook(ctx: Ctx, raw: string, signature: string | undefined) {
  if (!ctx.adapters.payments.verifyWebhook(raw, signature)) throw new AppError('UNAUTHENTICATED', 'Bad signature');
  const ev = JSON.parse(raw) as { id: string; type: string; order_id?: string; payment_id?: string; reason?: string };
  const fresh = await maybeOne(
    ctx.db,
    `INSERT INTO payment_webhook_events (gateway, event_id, payload) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
    [ctx.adapters.payments.name, ev.id, ev],
  );
  if (!fresh) return { duplicate: true };
  if (ev.type === 'payment.captured' || ev.type === 'payment.failed') {
    await ctx.db.query(
      `UPDATE payments SET status=$3, gateway_payment_id=COALESCE($4, gateway_payment_id), failure_reason=$5
       WHERE gateway=$1 AND gateway_order_id=$2 AND status IN ('created','pending','failed')`,
      [ctx.adapters.payments.name, ev.order_id, ev.type === 'payment.captured' ? 'captured' : 'failed', ev.payment_id ?? null, ev.reason ?? null],
    );
  }
  return { ok: true };
}

/** Job (nightly): settle payments still pending against the gateway. */
export async function reconcilePayments(ctx: Ctx) {
  const rows = await many(ctx.db, `SELECT id, gateway_order_id FROM payments WHERE status='pending' AND gateway_order_id IS NOT NULL AND created_at < now() - interval '15 minutes'`);
  for (const p of rows) {
    const s = await ctx.adapters.payments.fetchPaymentStatus(p.gateway_order_id);
    if (s !== 'pending') await ctx.db.query('UPDATE payments SET status=$2 WHERE id=$1', [p.id, s]);
  }
  return rows.length;
}

export async function refundPayment(ctx: Ctx, opsUserId: string, paymentId: string, amount: number, reason: string) {
  return tx(ctx.db, async (c) => {
    const p = await maybeOne(c, 'SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId]);
    if (!p) throw new AppError('NOT_FOUND', 'Payment not found');
    if (!['captured', 'partially_refunded'].includes(p.status)) throw new AppError('CONFLICT', 'Only captured payments can be refunded');
    const done = await one(c, `SELECT COALESCE(sum(amount_paise),0)::int AS n FROM refunds WHERE payment_id=$1 AND status <> 'failed'`, [paymentId]);
    if (done.n + amount > p.amount_paise) throw new AppError('VALIDATION_ERROR', 'Refund exceeds amount paid');
    let refundId: string | null = null;
    let status = 'processed';
    if (p.method !== 'cash') {
      try {
        refundId = (await ctx.adapters.payments.refund(p.gateway_payment_id ?? p.gateway_order_id, amount)).refundId;
      } catch {
        status = 'failed';
      }
    }
    const r = await one(c, `INSERT INTO refunds (payment_id, amount_paise, reason, status, gateway_refund_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [
      paymentId,
      amount,
      reason,
      status,
      refundId,
      opsUserId,
    ]);
    if (status === 'processed') {
      await c.query('UPDATE payments SET status=$2 WHERE id=$1', [paymentId, done.n + amount === p.amount_paise ? 'refunded' : 'partially_refunded']);
    }
    return { refund_id: r.id, status, amount_paise: amount };
  });
}
