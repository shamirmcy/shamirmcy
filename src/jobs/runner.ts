import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Ctx } from '../context.js';

export type JobName =
  | 'assignment.run'
  | 'assignment.offer_expiry'
  | 'eta.refresh'
  | 'duty.reaper'
  | 'prescription.pdf'
  | 'prescription.ocr'
  | 'followup.reminders'
  | 'payouts.weekly'
  | 'payments.reconcile'
  | 'pings.retention'
  | 'rentals.reminders'
  | 'ambulance.ack_timeout'
  | 'visits.sweep'
  | 'refunds.retry'
  | 'notify';

export type JobHandler = (ctx: Ctx, data: any) => Promise<unknown>;

export interface EnqueueOptions {
  delayMs?: number;
  jobId?: string;
}

export interface JobRunner {
  enqueue(name: JobName, data: Record<string, unknown>, opts?: EnqueueOptions): Promise<void>;
  close(): Promise<void>;
}

export const QUEUE_NAME = 'kmdoch';

/** Production runner: BullMQ queue. Workers run in a separate process (src/worker.ts). */
export class BullJobRunner implements JobRunner {
  readonly queue: Queue;
  constructor(connection: ConnectionOptions) {
    this.queue = new Queue(QUEUE_NAME, { connection });
  }
  async enqueue(name: JobName, data: Record<string, unknown>, opts: EnqueueOptions = {}) {
    await this.queue.add(name, data, {
      delay: opts.delayMs,
      jobId: opts.jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }
  async close() {
    await this.queue.close();
  }
}

/**
 * In-process runner for tests and single-process dev. Immediate jobs run right away (awaited);
 * delayed jobs are held until `runDue()` is called with a clock.
 */
export class InlineJobRunner implements JobRunner {
  ctx!: Ctx;
  readonly delayed: Array<{ name: JobName; data: any; dueAt: number; jobId?: string }> = [];
  readonly log: Array<{ name: JobName; data: any }> = [];
  constructor(private readonly handlers: Record<JobName, JobHandler>) {}

  async enqueue(name: JobName, data: Record<string, unknown>, opts: EnqueueOptions = {}) {
    this.log.push({ name, data });
    if (opts.delayMs && opts.delayMs > 0) {
      if (opts.jobId && this.delayed.some((j) => j.jobId === opts.jobId)) return;
      this.delayed.push({ name, data, dueAt: Date.now() + opts.delayMs, jobId: opts.jobId });
      return;
    }
    await this.handlers[name](this.ctx, data);
  }

  /** Run delayed jobs due by `now` (pass a future time to simulate the clock moving). */
  async runDue(now = Date.now(), filter?: JobName) {
    const due = this.delayed.filter((j) => j.dueAt <= now && (!filter || j.name === filter));
    for (const j of due) this.delayed.splice(this.delayed.indexOf(j), 1);
    for (const j of due) await this.handlers[j.name](this.ctx, j.data);
    return due.length;
  }

  async close() {}
}

export function startWorker(ctx: Ctx, connection: ConnectionOptions, handlers: Record<JobName, JobHandler>) {
  return new Worker(
    QUEUE_NAME,
    async (job) => {
      const h = handlers[job.name as JobName];
      if (!h) throw new Error(`No handler for job ${job.name}`);
      return h(ctx, job.data);
    },
    { connection, concurrency: 10 },
  );
}

/** Repeating schedules (BullMQ job schedulers). Cron times are in IST. */
export async function registerSchedules(queue: Queue) {
  const tz = 'Asia/Kolkata';
  const every = (id: JobName, ms: number) => queue.upsertJobScheduler(id, { every: ms }, { name: id, data: {} });
  const cron = (id: JobName, pattern: string) => queue.upsertJobScheduler(id, { pattern, tz }, { name: id, data: {} });
  await every('eta.refresh', 60_000);
  await every('duty.reaper', 60_000);
  await every('visits.sweep', 3_600_000);
  await every('refunds.retry', 15 * 60_000);
  await cron('followup.reminders', '0 9 * * *');
  await cron('payouts.weekly', '0 2 * * 1');
  await cron('payments.reconcile', '30 1 * * *');
  await cron('pings.retention', '15 3 * * *');
  await cron('rentals.reminders', '0 10 * * *');
}
