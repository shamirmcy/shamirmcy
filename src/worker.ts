import { loadConfig } from './config.js';
import { closeCtx, createCtx, redisConnectionOptions } from './context.js';
import { BullJobRunner, registerSchedules, startWorker } from './jobs/runner.js';
import { jobHandlers } from './jobs/handlers.js';

const config = loadConfig();
const ctx = createCtx(config);
const connection = redisConnectionOptions(config.env.REDIS_URL);
if (ctx.jobs instanceof BullJobRunner) await registerSchedules(ctx.jobs.queue);
const worker = startWorker(ctx, connection, jobHandlers);
worker.on('failed', (job, err) => ctx.log.error({ job: job?.name, id: job?.id, err: err.message }, 'job failed'));
ctx.log.info('worker started');

const shutdown = async () => {
  await worker.close();
  await closeCtx(ctx);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
