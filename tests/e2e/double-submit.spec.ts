import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { expect, request as pwRequest, test } from '@playwright/test';

// A double click, a retry after a lost response, or two open tabs must never create two of the same thing.
// These fire the same request several times at once, directly at the API.
const api = () => `http://127.0.0.1:${process.env.E2E_API_PORT}`;
async function signIn(accountId: string, workspaceId: string) {
  const ctx = await pwRequest.newContext({ baseURL: api() });
  const first = await (await ctx.get('/api/auth/csrf')).json() as { csrfToken: string };
  const login = await ctx.post('/api/dev/login-as', { headers: { 'X-CSRF-Token': first.csrfToken }, data: { accountId, workspaceId } });
  const { csrfToken } = await login.json() as { csrfToken: string };
  return (method: string, path: string, data?: unknown) => ctx.fetch(path, { method, headers: { 'X-CSRF-Token': csrfToken, 'X-Workspace-Id': workspaceId, ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { data } : {}) });
}
const burst = <T>(n: number, make: () => Promise<T>) => Promise.all(Array.from({ length: n }, make));
const statuses = (responses: Array<{ status(): number }>) => responses.map((response) => response.status()).sort();

test('the same event, note, follow-up and draft sent six times at once is saved once', async () => {
  const maya = await signIn('demo-owner', 'demo-northstar');
  const db = new Database(resolve(process.env.DATABASE_PATH!), { readonly: true });
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const stamp = Date.now();
  try {
    // Events: same name and dates is the same event.
    const event = { name: `Double Expo ${stamp}`, startsAt: '2027-04-01T00:00:00.000Z', endsAt: '2027-04-03T00:00:00.000Z', timeZone: 'UTC', spendMinor: null, active: false };
    const events = await burst(6, () => maya('POST', '/api/events', event));
    expect(statuses(events)).toEqual([200, 200, 200, 200, 200, 201]);
    expect(count('SELECT COUNT(*) n FROM events WHERE name=?', event.name)).toBe(1);
    const ids = new Set((await Promise.all(events.map((response) => response.json()))).map((body) => (body as { id: string }).id));
    expect(ids.size, 'every response names the same event').toBe(1);
    // ...but a different date range is a different event, and so is a different name.
    expect((await maya('POST', '/api/events', { ...event, startsAt: '2027-05-01T00:00:00.000Z', endsAt: '2027-05-02T00:00:00.000Z' })).status()).toBe(201);
    expect((await maya('POST', '/api/events', { ...event, name: `${event.name} West` })).status()).toBe(201);
    expect(count('SELECT COUNT(*) n FROM events WHERE name LIKE ?', `Double Expo ${stamp}%`)).toBe(3);
    // Reusing the event with "active" switches to it without creating another.
    const reused = await maya('POST', '/api/events', { ...event, active: true });
    expect(reused.status()).toBe(200);
    expect(count(`SELECT COUNT(*) n FROM events WHERE workspace_id='demo-northstar' AND is_active=1`)).toBe(1);
    expect(count(`SELECT is_active n FROM events WHERE name=? AND starts_at LIKE '2027-04-01%'`, event.name)).toBe(1);
    await maya('PUT', `/api/events/event-main-active`, { name: 'Pacific Packaging Expo', startsAt: new Date(Date.now() - 86400000).toISOString(), endsAt: new Date(Date.now() + 2 * 86400000).toISOString(), timeZone: 'America/Los_Angeles', spendMinor: null, active: true });

    // Notes: identical text for the same person moments apart is one note; different text is another note.
    const note = { body: `double note ${stamp}` };
    expect(statuses(await burst(6, () => maya('POST', '/api/contacts/demo-ns-contact-2/notes', note)))).toEqual([200, 200, 200, 200, 200, 201]);
    expect((await maya('POST', '/api/contacts/demo-ns-contact-2/notes', { body: `${note.body} (second thought)` })).status()).toBe(201);
    expect(count('SELECT COUNT(*) n FROM notes WHERE body LIKE ?', `double note ${stamp}%`)).toBe(2);

    // Follow-ups: same person, time and wording is one; another time is another.
    const task = { kind: 'follow_up', dueAt: '2027-04-05T17:00:00.000Z', title: `double task ${stamp}`, note: '', timeZone: 'UTC', allowOverlap: false };
    const tasks = await burst(6, () => maya('POST', '/api/contacts/demo-ns-contact-2/tasks', task));
    expect(statuses(tasks)).toEqual([200, 200, 200, 200, 200, 201]);
    expect((await maya('POST', '/api/contacts/demo-ns-contact-2/tasks', { ...task, dueAt: '2027-04-06T17:00:00.000Z' })).status()).toBe(201);
    expect(count('SELECT COUNT(*) n FROM tasks WHERE title=?', task.title)).toBe(2);

    // Drafts: one open draft per person and conversation. A new conversation gets its own draft.
    const drafts = await burst(6, () => maya('POST', '/api/contacts/demo-ns-contact-3/email-draft'));
    expect(statuses(drafts)).toEqual([200, 200, 200, 200, 200, 201]);
    const draftIds = new Set((await Promise.all(drafts.map((response) => response.json()))).map((body) => (body as { id: string }).id));
    expect(draftIds.size).toBe(1);
    const draftId = [...draftIds][0]!;
    // An edit made to the draft is kept when the draft is asked for again.
    const edit = await maya('PUT', `/api/emails/${draftId}`, { subject: `My own subject ${stamp}`, body: 'My own words about samples.' });
    expect(edit.status(), await edit.text()).toBeLessThan(300);
    const again = await (await maya('POST', '/api/contacts/demo-ns-contact-3/email-draft')).json() as { id: string; subject: string; body: string };
    expect(again.id).toBe(draftId);
    expect(again.subject).toBe(`My own subject ${stamp}`);
    // Sending the same draft six times at once approves it once.
    const sends = await burst(6, () => maya('POST', `/api/emails/${draftId}/send`, { subject: `My own subject ${stamp}`, body: 'My own words about samples.' }));
    expect(statuses(sends).filter((status) => status === 200)).toHaveLength(1);
    expect(count(`SELECT COUNT(*) n FROM emails WHERE id=? AND status IN ('queued','outbox','sent')`, draftId)).toBe(1);
    // Once it is out of drafts, asking again starts a fresh draft.
    const fresh = await maya('POST', '/api/contacts/demo-ns-contact-3/email-draft');
    expect(fresh.status()).toBe(201);
    expect(((await fresh.json()) as { id: string }).id).not.toBe(draftId);
  } finally {
    db.close();
    await maya('PUT', `/api/events/event-main-active`, { name: 'Pacific Packaging Expo', startsAt: new Date(Date.now() - 86400000).toISOString(), endsAt: new Date(Date.now() + 2 * 86400000).toISOString(), timeZone: 'America/Los_Angeles', spendMinor: null, active: true });
  }
});
