import type { Ctx } from '../context.js';
import { many } from '../lib/db.js';
import type { JobHandler, JobName } from './runner.js';
import { expireOffer, runAssignment } from '../modules/assignment/engine.js';
import { refreshEtas } from '../modules/assignment/eta.js';
import { reapIdleDuty } from '../modules/providers/service.js';
import { generatePrescriptionPdf, processPrescriptionOcr } from '../modules/clinical/service.js';
import { runWeeklyPayouts } from '../modules/commerce/billing.js';
import { ambulanceAckTimeout, reconcilePayments } from '../modules/commerce/service.js';
import { deliver, notify } from '../modules/notifications/service.js';
import { sweepMissedVisits } from '../modules/visits/service.js';
import { retryFailedRefunds } from '../modules/commerce/settlement.js';

async function followUpReminders(ctx: Ctx) {
  const rows = await many(
    ctx.db,
    `UPDATE consultations c SET follow_up_reminded_at=now() FROM service_requests sr
     WHERE sr.id=c.request_id AND c.follow_up_at IS NOT NULL AND c.follow_up_reminded_at IS NULL
       AND c.follow_up_at < now() + interval '1 day' AND c.follow_up_at > now() - interval '1 day'
     RETURNING sr.booked_by_user_id`,
  );
  for (const r of rows) await notify(ctx, r.booked_by_user_id, 'follow_up_reminder', {});
  return rows.length;
}

async function rentalReminders(ctx: Ctx) {
  const rows = await many(
    ctx.db,
    `UPDATE equipment_rentals SET end_reminder_sent_at=now()
     WHERE status IN ('delivered','active') AND end_reminder_sent_at IS NULL AND end_date <= (now() AT TIME ZONE 'Asia/Kolkata')::date + 2
     RETURNING booked_by_user_id, to_char(end_date, 'DD Mon YYYY') AS end_date`,
  );
  for (const r of rows) await notify(ctx, r.booked_by_user_id, 'rental_ending', { date: r.end_date });
  return rows.length;
}

/** Location pings: keep partitions ahead of time and drop anything older than 30 days. */
async function pingRetention(ctx: Ctx) {
  await ctx.db.query('SELECT ensure_location_ping_partitions(3)');
  await ctx.db.query('UPDATE otp_challenges SET code_enc=NULL WHERE code_enc IS NOT NULL AND (consumed_at IS NOT NULL OR expires_at < now())');
  const r = await ctx.db.query('SELECT drop_old_location_ping_partitions($1) AS n', [ctx.config.pingRetentionDays]);
  // Belt and braces for rows that landed in a partition spanning the cutoff.
  await ctx.db.query(`DELETE FROM location_pings WHERE recorded_at < now() - make_interval(days => $1)`, [ctx.config.pingRetentionDays]);
  return r.rows[0].n;
}

export const jobHandlers: Record<JobName, JobHandler> = {
  'assignment.run': (ctx, d) => runAssignment(ctx, d.requestId),
  'assignment.offer_expiry': (ctx, d) => expireOffer(ctx, d.assignmentId),
  'eta.refresh': (ctx) => refreshEtas(ctx),
  'duty.reaper': (ctx) => reapIdleDuty(ctx),
  'prescription.pdf': (ctx, d) => generatePrescriptionPdf(ctx, d.prescriptionId),
  'prescription.ocr': (ctx, d) => processPrescriptionOcr(ctx, d.prescriptionId),
  'followup.reminders': (ctx) => followUpReminders(ctx),
  'payouts.weekly': (ctx) => runWeeklyPayouts(ctx),
  'payments.reconcile': (ctx) => reconcilePayments(ctx),
  'pings.retention': (ctx) => pingRetention(ctx),
  'rentals.reminders': (ctx) => rentalReminders(ctx),
  'ambulance.ack_timeout': (ctx, d) => ambulanceAckTimeout(ctx, d.runId),
  'visits.sweep': (ctx) => sweepMissedVisits(ctx),
  'refunds.retry': (ctx) => retryFailedRefunds(ctx),
  notify: (ctx, d) => deliver(ctx, d),
};
