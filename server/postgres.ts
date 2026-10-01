import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type PoolClient } from 'pg';
import { closePostgresPool, getPostgresPool as getPool } from './postgres-compat.js';
const migrationsPath = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations-postgres');

export function isPostgresConfigured() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export async function withPostgresTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function migratePostgres() {
  const database = getPool();
  await database.query(`CREATE TABLE IF NOT EXISTS gather_schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const names = (await readdir(migrationsPath)).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name)).sort();
  for (const name of names) {
    const alreadyApplied = await database.query('SELECT 1 FROM gather_schema_migrations WHERE name = $1', [name]);
    if (alreadyApplied.rowCount) continue;
    const sql = await readFile(resolve(migrationsPath, name), 'utf8');
    await withPostgresTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO gather_schema_migrations(name) VALUES ($1)', [name]);
    });
  }
}

export async function postgresHealthCheck() {
  try {
    const result = await getPool().query<{ ok: number }>('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

export async function closePostgres() {
  await closePostgresPool();
}
