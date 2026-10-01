import pg from 'pg';

// Return bigint/numeric as JS numbers where safe; dates stay Date objects.
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric

export type Queryable = pg.Pool | pg.PoolClient;
export type Db = pg.Pool;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 20 });
}

export async function one<T = any>(db: Queryable, sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query(sql, params);
  if (r.rowCount === 0) throw new Error('Expected one row, got none');
  return r.rows[0] as T;
}

export async function maybeOne<T = any>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, params);
  return r.rows as T[];
}

/** Run fn in a transaction. Callbacks registered via afterCommit run only if the commit succeeds. */
export async function tx<T>(pool: pg.Pool, fn: (c: TxClient) => Promise<T>): Promise<T> {
  const client = (await pool.connect()) as TxClient;
  const after: Array<() => unknown> = [];
  client.afterCommit = (cb) => void after.push(cb);
  let result: T;
  try {
    await client.query('BEGIN');
    result = await fn(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  for (const cb of after) {
    try {
      await cb();
    } catch (e) {
      // Post-commit side effects (realtime, jobs, notifications) must never fail the request.
      console.error('afterCommit hook failed', (e as Error).message);
    }
  }
  return result;
}

export type TxClient = pg.PoolClient & { afterCommit: (cb: () => unknown) => void };

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string };
  return err?.code === '23505' && (!constraint || err.constraint === constraint);
}

/** geography(Point) literal helper: ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography */
export const POINT = (lngParam: string, latParam: string) =>
  `ST_SetSRID(ST_MakePoint(${lngParam}, ${latParam}), 4326)::geography`;
