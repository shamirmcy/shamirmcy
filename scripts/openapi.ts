// Writes the OpenAPI 3.1 document to openapi.json (no database/Redis traffic needed beyond connecting).
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { closeCtx, createCtx } from '../src/context.js';
import { buildApp } from '../src/app.js';

const ctx = createCtx(loadConfig({ INLINE_JOBS: 'true', LOG_LEVEL: 'silent' }));
const app = await buildApp(ctx);
await app.ready();
writeFileSync('openapi.json', JSON.stringify(app.swagger(), null, 2));
await app.close();
await closeCtx(ctx);
console.log('wrote openapi.json');
