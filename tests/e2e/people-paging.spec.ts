import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { expect, request as pwRequest, test } from '@playwright/test';

// The people list is paged by the server, so a workspace with thousands of people loads one page at a time and every person is reachable.
test('the people list is paged by the server and every person is reachable', async () => {
  const stamp = `pg${Date.now()}`;
  const db = new Database(resolve(process.env.DATABASE_PATH!));
  db.pragma('foreign_keys = OFF');
  const cols = (db.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string }>).map((column) => column.name);
  const base = db.prepare("SELECT * FROM contacts WHERE id='demo-rb-contact-1'").get() as Record<string, unknown>;
  const insert = db.prepare(`INSERT INTO contacts (${cols.join(',')}) VALUES (${cols.map((column) => '@' + column).join(',')})`);
  db.transaction(() => { for (let i = 0; i < 25; i++) insert.run({ ...base, id: `${stamp}-${i}`, name: `${stamp} Person ${String(i).padStart(2, '0')}`, email: `${stamp}${i}@paging.example`, email_normalized: `${stamp}${i}@paging.example`, phone: '', phone_normalized: '', stage: i < 5 ? 'meeting' : 'new', updated_at: new Date(Date.now() - i * 1000).toISOString() }); })();
  db.close();
  const ctx = await pwRequest.newContext({ baseURL: `http://127.0.0.1:${process.env.E2E_API_PORT}` });
  const first = await (await ctx.get('/api/auth/csrf')).json() as { csrfToken: string };
  const login = await (await ctx.post('/api/dev/login-as', { headers: { 'X-CSRF-Token': first.csrfToken }, data: { accountId: 'demo-other-company', workspaceId: 'demo-riverbend' } })).json() as { csrfToken: string };
  const headers = { 'X-CSRF-Token': login.csrfToken, 'X-Workspace-Id': 'demo-riverbend' };
  type Page = { people: Array<{ id: string; stage: string }>; total: number; page: number; pageSize: number; stageCounts: Record<string, number> };
  const get = async (query: string) => await (await ctx.get(`/api/contacts?q=${stamp}&${query}`, { headers })).json() as Page;

  const seen = new Set<string>();
  for (let page = 1; page <= 3; page++) {
    const result = await get(`page=${page}&pageSize=10`);
    expect(result.total).toBe(25);
    expect(result.people).toHaveLength(page === 3 ? 5 : 10);
    for (const person of result.people) { expect(seen.has(person.id), 'no person appears on two pages').toBe(false); seen.add(person.id); }
  }
  expect(seen.size).toBe(25);

  const meeting = await get('page=1&pageSize=10&stage=meeting');
  expect(meeting.total).toBe(5);
  expect(meeting.people.every((person) => person.stage === 'meeting')).toBe(true);
  expect(meeting.stageCounts).toMatchObject({ meeting: 5, new: 20 });

  const beyond = await get('page=99&pageSize=10');
  expect(beyond.page, 'a page past the end lands on the last page').toBe(3);
  expect(beyond.people).toHaveLength(5);

  for (const bad of ['page=0', 'page=abc', 'pageSize=0', 'pageSize=5000', 'stage=bogus']) expect((await ctx.get(`/api/contacts?${bad}`, { headers })).status(), bad).toBe(400);
});

test('the People screen pages through the server and keeps the stage counts', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  await page.goto('/people');
  await expect(page.getByRole('navigation', { name: 'People pages' })).toBeVisible();
  const firstPage = await page.locator('.people-row.records-row strong').allTextContents();
  expect(firstPage).toHaveLength(10);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect.poll(async () => (await page.locator('.people-row.records-row strong').allTextContents())[0]).not.toBe(firstPage[0]);
  await expect(page.getByText(/^11–20 of /)).toBeVisible();
});

test('each Pipeline column shows its true total and loads more on request', async ({ page }) => {
  const db = new Database(resolve(process.env.DATABASE_PATH!));
  db.pragma('foreign_keys = OFF');
  const cols = (db.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string }>).map((column) => column.name);
  const base = db.prepare("SELECT * FROM contacts WHERE id='demo-rb-contact-1'").get() as Record<string, unknown>;
  const insert = db.prepare(`INSERT INTO contacts (${cols.join(',')}) VALUES (${cols.map((column) => '@' + column).join(',')})`);
  const stamp = Date.now();
  db.transaction(() => { for (let i = 0; i < 205; i++) insert.run({ ...base, id: `board-${stamp}-${i}`, name: `Board ${i}`, email: `b${i}-${stamp}@board.example`, email_normalized: `b${i}-${stamp}@board.example`, phone: '', phone_normalized: '', stage: 'replied' }); })();
  db.close();
  await page.goto('/');
  await page.getByRole('button', { name: /Alex Rivera/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  await page.goto('/pipeline');
  const column = page.locator('.pipeline-column').filter({ has: page.getByRole('heading', { name: 'Replied', exact: true }) });
  await expect(column.locator('.pipeline-count')).toHaveText(/^\d{3,}$/);
  const total = Number(await column.locator('.pipeline-count').textContent());
  expect(total).toBeGreaterThanOrEqual(205);
  await expect(column.locator('.pipeline-item')).toHaveCount(40);
  await column.getByRole('button', { name: /^Show more/ }).click();
  await expect(column.locator('.pipeline-item')).toHaveCount(80);
  for (let step = 0; step < 3; step++) await column.getByRole('button', { name: /^Show more/ }).click({ timeout: 8000 }).catch(() => undefined);
  await expect(column.locator('.pipeline-item')).toHaveCount(200);
  await expect(column.getByRole('note')).toContainText(`Showing the 200 most recent of ${total}`);
});

test('a slow answer to an earlier search never replaces the answer to the latest one', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  await page.goto('/people');
  await expect(page.locator('.people-row.records-row').first()).toBeVisible();
  await page.route(/\/api\/contacts\?q=Tessa/, async (route) => { await new Promise((done) => setTimeout(done, 1500)); await route.continue(); });
  const search = page.getByLabel('Search companies and people');
  await search.fill('Tessa');
  await page.waitForTimeout(400);
  await search.fill('Noah');
  await expect(page.locator('.people-row.records-row strong').first()).toHaveText(/Noah/);
  await page.waitForTimeout(2000);
  await expect(page.locator('.people-row.records-row strong').first()).toHaveText(/Noah/);
  await expect(page.locator('.people-row.records-row strong').filter({ hasText: 'Tessa' })).toHaveCount(0);
});
