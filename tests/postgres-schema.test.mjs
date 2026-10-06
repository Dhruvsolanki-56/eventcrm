import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { PGlite } from '@electric-sql/pglite';
import { bindParameters, PostgresDatabase } from '../server/postgres-compat.ts';

describe('PostgreSQL baseline schema', () => {
  const db = new PGlite();

  beforeAll(async () => {
    const schema = await readFile(new URL('../server/migrations-postgres/001_core.sql', import.meta.url), 'utf8');
    await db.exec(schema);
    const compatibility = await readFile(new URL('../server/migrations-postgres/002_sqlite_compat.sql', import.meta.url), 'utf8');
    await db.exec(compatibility);
  });

  afterAll(async () => db.close());

  test('creates the complete current data model', async () => {
    const result = await db.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    expect(result.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining([
      'users', 'workspaces', 'memberships', 'sessions', 'invites', 'events', 'event_access',
      'products', 'companies', 'contacts', 'scans', 'encounters', 'notes', 'contact_products',
      'emails', 'tasks', 'jobs', 'notifications', 'digest_runs', 'audit_events', 'workspace_settings',
      'user_workspace_preferences', 'account_tokens', 'email_send_limits', 'voice_note_usage', 'company_aliases',
    ]));
    expect(result.rows).toHaveLength(26);
  });

  test('keeps every SQLite table and column represented in the hosted schema', async () => {
    const sqlite = new Database(':memory:');
    try {
      const migrationDirectory = new URL('../server/migrations/', import.meta.url);
      const migrationNames = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort();
      for (const name of migrationNames) {
        await sqlite.exec(await readFile(new URL(name, migrationDirectory), 'utf8'));
      }
      const sqliteTables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => row.name);
      const pgTables = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name <> 'gather_schema_migrations' ORDER BY table_name`)).rows.map((row) => row.table_name);
      expect(pgTables).toEqual(sqliteTables);
      for (const table of sqliteTables) {
        const sqliteColumns = sqlite.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all().map((column) => column.name);
        const pgColumns = (await db.query('SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position', [table])).rows.map((column) => column.column_name);
        expect(pgColumns, `columns in ${table}`).toEqual(sqliteColumns);
      }
    } finally {
      sqlite.close();
    }
  });

  test('enforces case-insensitive account uniqueness and one-to-many company ownership', async () => {
    await db.query('INSERT INTO users(id,name,email,password_hash) VALUES ($1,$2,$3,$4)', ['u-1', 'Demo User', 'Demo@Sample.invalid', 'test-hash']);
    await db.query('INSERT INTO workspaces(id,kind,name,owner_user_id) VALUES ($1,$2,$3,$4)', ['w-1', 'company', 'Demo workspace', 'u-1']);
    await db.query('INSERT INTO companies(id,workspace_id,name,normalized_name) VALUES ($1,$2,$3,$4)', ['co-1', 'w-1', 'Example Company', 'example-company']);
    await db.query('INSERT INTO contacts(id,workspace_id,company_id,name) VALUES ($1,$2,$3,$4),($5,$2,$3,$6)', ['p-1', 'w-1', 'co-1', 'Taylor One', 'p-2', 'Taylor Two']);

    await expect(db.query('INSERT INTO users(id,name,email,password_hash) VALUES ($1,$2,$3,$4)', ['u-2', 'Duplicate', 'demo@sample.invalid', 'test-hash'])).rejects.toThrow();
    await expect(db.query('INSERT INTO companies(id,workspace_id,name,normalized_name) VALUES ($1,$2,$3,$4)', ['co-2', 'w-1', 'Example Company', 'example-company'])).rejects.toThrow();
    const linked = await db.query('SELECT count(*)::int AS n FROM contacts WHERE workspace_id=$1 AND company_id=$2', ['w-1', 'co-1']);
    expect(linked.rows[0].n).toBe(2);
  });

  test('runs the current date and JSON query helpers with PostgreSQL semantics', async () => {
    const date = await db.query("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', $1, $2) AS shifted, datetime($1) AS normalized", ['2026-10-01T00:00:00.000Z', '+1 day']);
    expect(date.rows[0].shifted).toBe('2026-10-02T00:00:00.000Z');
    expect(date.rows[0].normalized).toBe('2026-10-01T00:00:00.000Z');
    const json = await db.query("SELECT json_extract($1, '$.emailId') AS id", ['{"emailId":"mail-1"}']);
    expect(json.rows[0].id).toBe('mail-1');
  });

  test('rewrites legacy placeholders and ignored inserts without touching literals or comments', () => {
    const rewritten = bindParameters('INSERT OR IGNORE INTO t(value) VALUES (?)', ['a?b']);
    expect(rewritten.text).toBe('INSERT INTO t(value) VALUES ($1) ON CONFLICT DO NOTHING');
    expect(rewritten.values).toEqual(['a?b']);
    const positional = bindParameters("SELECT '?' AS literal, ? -- ? is not a bind\n", ['value']);
    expect(positional.text).toBe("SELECT '?' AS literal, $1 -- ? is not a bind\n");
    const named = bindParameters("SELECT @workspaceId, '@workspaceId'", { workspaceId: 'ws-1' });
    expect(named).toEqual({ text: "SELECT $1, '@workspaceId'", values: ['ws-1'] });
    expect(bindParameters('SELECT id FROM users WHERE email = ? COLLATE NOCASE', ['PERSON@example.invalid']).text)
      .toBe('SELECT id FROM users WHERE lower(email) = lower($1)');
    expect(bindParameters('INSERT INTO users(email) VALUES (?) ON CONFLICT(email) DO UPDATE SET email=excluded.email', ['demo@example.invalid']).text)
      .toBe('INSERT INTO users(email) VALUES ($1) ON CONFLICT (lower(email)) DO UPDATE SET email=excluded.email');
    expect(bindParameters("SELECT name FROM companies WHERE name LIKE ? AND note='LIKE'", ['%acme%']).text)
      .toBe("SELECT name FROM companies WHERE name ILIKE $1 AND note='LIKE'");
    // Postgres rejects an unqualified column on the right of ON CONFLICT DO UPDATE, so the rewrite names the table.
    expect(bindParameters('UPDATE voice_note_usage SET created_count=MAX(created_count,excluded.created_count)', []).text)
      .toBe('UPDATE voice_note_usage SET created_count=GREATEST(voice_note_usage.created_count, excluded.created_count)');
  });

  test('binds the named parameter objects used by existing data queries', async () => {
    const database = new PostgresDatabase(db);
    const row = await database.prepare('SELECT @workspaceId AS id').get({ workspaceId: 'ws-1' });
    expect(row.id).toBe('ws-1');
  });
});
