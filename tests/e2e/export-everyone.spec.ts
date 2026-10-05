import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { expect, request as pwRequest, test } from '@playwright/test';

// The people screen loads at most 200 at a time, but "Export people CSV" has to hand over everyone.
test('the people CSV contains every person, not just the first 200', async () => {
  const db = new Database(resolve(process.env.DATABASE_PATH!));
  db.pragma('foreign_keys = OFF');
  const cols = (db.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string }>).map((column) => column.name);
  const base = db.prepare("SELECT * FROM contacts WHERE id='demo-rb-contact-1'").get() as Record<string, unknown>;
  const insert = db.prepare(`INSERT INTO contacts (${cols.join(',')}) VALUES (${cols.map((column) => '@' + column).join(',')})`);
  const stamp = Date.now();
  db.transaction(() => { for (let i = 0; i < 260; i++) insert.run({ ...base, id: `export-${stamp}-${i}`, name: `Export Person ${i}`, email: `e${i}-${stamp}@export.example`, email_normalized: `e${i}-${stamp}@export.example`, phone: '', phone_normalized: '' }); })();
  db.close();
  const ctx = await pwRequest.newContext({ baseURL: `http://127.0.0.1:${process.env.E2E_API_PORT}` });
  const first = await (await ctx.get('/api/auth/csrf')).json() as { csrfToken: string };
  const login = await (await ctx.post('/api/dev/login-as', { headers: { 'X-CSRF-Token': first.csrfToken }, data: { accountId: 'demo-other-company', workspaceId: 'demo-riverbend' } })).json() as { csrfToken: string };
  const headers = { 'X-CSRF-Token': login.csrfToken, 'X-Workspace-Id': 'demo-riverbend' };
  const screen = await (await ctx.get('/api/contacts?pageSize=200', { headers })).json() as { people: unknown[]; total: number };
  expect(screen.people).toHaveLength(200);
  expect(screen.total).toBeGreaterThanOrEqual(261);
  const csv = await (await ctx.get('/api/export/people.csv', { headers })).text();
  expect(csv.split('\r\n').length - 1, 'one row per person, plus the header').toBeGreaterThanOrEqual(261);
});
