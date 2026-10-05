import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { expect, request as pwRequest, test } from '@playwright/test';

test('a person who asked not to be emailed cannot be sent a draft, and the draft stays a draft', async () => {
  const ctx = await pwRequest.newContext({ baseURL: `http://127.0.0.1:${process.env.E2E_API_PORT}` });
  const first = await (await ctx.get('/api/auth/csrf')).json() as { csrfToken: string };
  const login = await (await ctx.post('/api/dev/login-as', { headers: { 'X-CSRF-Token': first.csrfToken }, data: { accountId: 'demo-owner', workspaceId: 'demo-northstar' } })).json() as { csrfToken: string };
  const headers = { 'X-CSRF-Token': login.csrfToken, 'X-Workspace-Id': 'demo-northstar' };
  const people = (await (await ctx.get('/api/contacts?pageSize=30', { headers })).json() as { people: Array<{ id: string; email: string }> }).people;
  const person = people.filter((item) => item.email).at(-1)!;
  const draftResponse = await ctx.post(`/api/contacts/${person.id}/email-draft`, { headers });
  expect(draftResponse.status(), await draftResponse.text()).toBeLessThan(300);
  const draft = await draftResponse.json() as { id: string; subject: string; body: string };
  const db = new Database(resolve(process.env.DATABASE_PATH!));
  db.prepare('UPDATE contacts SET do_not_contact=1 WHERE id=?').run(person.id);
  try {
    const send = await ctx.post(`/api/emails/${draft.id}/send`, { headers, data: { subject: draft.subject, body: draft.body } });
    expect(send.status(), await send.text()).toBeGreaterThanOrEqual(400);
    expect(send.status()).toBeLessThan(500);
    expect(await send.text()).toContain('asked not to receive');
    expect((db.prepare('SELECT status FROM emails WHERE id=?').get(draft.id) as { status: string }).status).toBe('draft');
  } finally {
    db.prepare('UPDATE contacts SET do_not_contact=0 WHERE id=?').run(person.id);
    db.close();
  }
});
