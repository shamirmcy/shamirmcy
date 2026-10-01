import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { seedDemoZones, seedReference } from '../src/db/seed.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://kmdoch:kmdoch@localhost:5432/kmdoch_test';

/** Fresh schema for every test run. */
export default async function setup() {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(TEST_DB, () => undefined);
  const c2 = new pg.Client({ connectionString: TEST_DB });
  await c2.connect();
  await seedReference(c2);
  await seedDemoZones(c2);
  await c2.end();
}
