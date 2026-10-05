import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { request as pwRequest, test } from '@playwright/test';
const api = () => `http://127.0.0.1:${process.env.E2E_API_PORT}`;
// Opt-in: SCALE_TEST=1 npm run test:e2e -- scale   (SCALE_N sets the size, default 100000). Seeds a throwaway test database and prints how long each screen's data takes.
test.skip(!process.env.SCALE_TEST, 'set SCALE_TEST=1 to run');
test('scale: every list and report answers on a large workspace', async () => {
  test.setTimeout(580_000);
  const N = Number(process.env.SCALE_N ?? 100000);
  const db = new Database(resolve(process.env.DATABASE_PATH!)); db.pragma('foreign_keys = OFF'); db.pragma('synchronous = OFF');
  const cols = (db.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string }>).map((c) => c.name);
  const base = db.prepare("SELECT * FROM contacts WHERE id='demo-ns-contact-1'").get() as Record<string, unknown>;
  const ins = db.prepare(`INSERT INTO contacts (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`);
  const enc = db.prepare('SELECT * FROM encounters LIMIT 1').get() as Record<string, unknown>; const ec = Object.keys(enc);
  const ie = db.prepare(`INSERT INTO encounters (${ec.join(',')}) VALUES (${ec.map((c) => '@' + c).join(',')})`);
  const note = db.prepare("SELECT * FROM notes LIMIT 1").get() as Record<string, unknown> | undefined; const nc = note ? Object.keys(note) : [];
  const inn = note ? db.prepare(`INSERT INTO notes (${nc.join(',')}) VALUES (${nc.map((c) => '@' + c).join(',')})`) : null;
  const stages = ['new', 'contacted', 'replied', 'meeting', 'won', 'lost'];
  const t0 = Date.now();
  db.transaction(() => { for (let i = 0; i < N; i++) {
    ins.run({ ...base, id: `scale-${i}`, name: `Person ${i} Scale`, email: `p${i}@co${i % 2000}.example`, email_normalized: `p${i}@co${i % 2000}.example`, phone: `+1555${String(i).padStart(7, '0')}`, phone_normalized: `1555${String(i).padStart(7, '0')}`, stage: stages[i % 6], updated_at: new Date(Date.now() - i * 1000).toISOString() });
    ie.run({ ...enc, id: `scale-enc-${i}`, contact_id: `scale-${i}` });
    if (inn && i % 2 === 0) inn.run({ ...note, id: `scale-note-${i}`, contact_id: `scale-${i}`, encounter_id: `scale-enc-${i}` });
  } })();
  db.exec('ANALYZE'); db.close();
  console.log('SCALE seeded', N, 'people in', Date.now() - t0, 'ms');
  const ctx = await pwRequest.newContext({ baseURL: api() });
  const first = await (await ctx.get('/api/auth/csrf')).json() as { csrfToken: string };
  const login = await (await ctx.post('/api/dev/login-as', { headers: { 'X-CSRF-Token': first.csrfToken }, data: { accountId: 'demo-owner', workspaceId: 'demo-northstar' } })).json() as { csrfToken: string };
  const rep = await (async () => { const c = await pwRequest.newContext({ baseURL: api() }); const f = await (await c.get('/api/auth/csrf')).json() as { csrfToken: string }; const l = await (await c.post('/api/dev/login-as', { headers: { 'X-CSRF-Token': f.csrfToken }, data: { accountId: 'demo-rep', workspaceId: 'demo-northstar' } })).json() as { csrfToken: string }; return { c, h: { 'X-CSRF-Token': l.csrfToken, 'X-Workspace-Id': 'demo-northstar' } }; })();
  const h = { 'X-CSRF-Token': login.csrfToken, 'X-Workspace-Id': 'demo-northstar' };
  const time = async (who: string, c: typeof ctx, hh: typeof h, path: string) => { const s = Date.now(); const r = await c.get(path, { headers: hh }); const b = await r.body(); const ms = Date.now() - s; console.log('SCALE', who.padEnd(5), path.padEnd(48), r.status(), `${ms}ms`.padStart(8), `${b.length}B`); if (r.status() !== 200) throw new Error(`${path} returned ${r.status()}`); if (ms > 8000) throw new Error(`${path} took ${ms}ms`); };
  for (const [who, c, hh] of [['admin', ctx, h], ['rep', rep.c, rep.h]] as const) {
    for (const p of ['/api/contacts?pageSize=10', '/api/contacts?pageSize=10&page=5000', '/api/contacts?stage=meeting&pageSize=40', '/api/contacts?q=Person%2099999&pageSize=10', '/api/contacts?q=co1999&pageSize=10', '/api/contacts?q=zzzz&pageSize=10', '/api/companies', '/api/dashboard', '/api/tasks', '/api/email-desk', '/api/contacts/scale-5000', '/api/notifications']) await time(who, c, hh, p);
  }
  for (const p of ['/api/analytics?days=30', '/api/reports', '/api/export/people.csv', '/api/problems']) await time('admin', ctx, h, p);
});
