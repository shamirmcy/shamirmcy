import { loadConfig } from './config.js';
import { closeCtx, createCtx } from './context.js';
import { buildApp } from './app.js';

const config = loadConfig();
const ctx = createCtx(config);
const app = await buildApp(ctx);

const shutdown = async () => {
  await app.close();
  await closeCtx(ctx);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.env.PORT, host: config.env.HOST });
