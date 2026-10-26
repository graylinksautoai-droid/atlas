import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, closePool } from '../src/db.ts';
import { ROOT } from '../src/config.ts';

export async function migrate(): Promise<string[]> {
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const existing = await client.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [version]);
      if (existing.rowCount && existing.rowCount > 0) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
        await client.query('COMMIT');
        applied.push(version);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    client.release();
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then((applied) => {
      console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema already current');
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
