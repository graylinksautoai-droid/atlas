import pg from 'pg';
import { config } from './config.ts';

const { Pool } = pg;

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export const pool: Db = new Pool({
  connectionString: config.databaseUrl,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
  application_name: 'atlas',
});

pool.on('error', (error) => {
  // A broken idle connection must not take the process down. Callers see errors
  // on their own queries, which is where they get handled.
  console.error(JSON.stringify({ level: 'error', msg: 'pg idle client error', error: String(error) }));
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const result = await pool.query<T>(text, params);
  return result.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function tx<T>(fn: (client: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is the one worth reporting.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = performance.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
