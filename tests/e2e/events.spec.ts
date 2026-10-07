import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, request as pwRequest, test } from '@playwright/test';

const api = () => `http://127.0.0.1:${process.env.E2E_API_PORT}`;
async function signIn(accountId: string, workspaceId: string) {
  const ctx = await pwRequest.newContext({ baseURL: api() });
  const first = await (await ctx.get('/api/auth/csrf')).json() as { csrfToken: string };
  const login = await ctx.post('/api/dev/login-as', { headers: { 'X-CSRF-Token': first.csrfToken }, data: { accountId, workspaceId } });
  expect(login.status(), await login.text()).toBe(200);
  const { csrfToken } = await login.json() as { csrfToken: string };
  const send = (method: string, path: string, data?: unknown) => ctx.fetch(path, { method, headers: { 'X-CSRF-Token': csrfToken, 'X-Workspace-Id': workspaceId, ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { data } : {}) });
  return { ctx, send };
}
type Summary = { id: string; name: string; people: number; conversations: number; spend_minor: number | null; deals: { open: number; won: number; lost: number; openValue: number; wonValue: number } };
type Detail = {
  event: { id: string; name: string; spend_minor: number | null }; canManage: boolean; canSeeMoney: boolean;
  metrics: { people: number; companies: number; conversations: number };
  deals: Array<{ stage: string; count: number; value: number }>; team: Array<{ name: string }>;
  daily: Array<{ day: string; people: number }>; cost: { spend: number | null; perPerson: number | null };
};

// Two fixture events with known people and deals, so the numbers can be checked exactly.
function addFixture() {
  const db = new Database(resolve(process.env.DATABASE_PATH!));
  const ids = { E: randomUUID(), F: randomUUID(), company: randomUUID(), p1: randomUUID(), p2: randomUUID() };
  try {
    db.transaction(() => {
      const addEvent = db.prepare("INSERT INTO events(id,workspace_id,name,starts_at,ends_at,time_zone,spend_minor) VALUES (?,'demo-northstar',?,?,?,'UTC',?)");
      addEvent.run(ids.E, `Fixture Expo ${ids.E.slice(0, 6)}`, '2026-09-01T00:00:00.000Z', '2026-09-03T23:59:59.000Z', 500000);
      addEvent.run(ids.F, `Fixture Forum ${ids.F.slice(0, 6)}`, '2026-09-10T00:00:00.000Z', '2026-09-11T23:59:59.000Z', null);
      for (const event of [ids.E, ids.F]) db.prepare("INSERT INTO event_access(workspace_id,event_id,user_id) VALUES ('demo-northstar',?,'demo-owner')").run(event);
      db.prepare("INSERT INTO companies(id,workspace_id,name,normalized_name) VALUES (?,'demo-northstar',?,?)").run(ids.company, `Fixture Co ${ids.company.slice(0, 6)}`, ids.company);
      const person = db.prepare("INSERT INTO contacts(id,workspace_id,company_id,name,email,email_normalized,quality,owner_user_id) VALUES (?,'demo-northstar',?,?,?,?,?,'demo-owner')");
      person.run(ids.p1, ids.company, 'Fixture One', 'one@fixture.example', 'one@fixture.example', 'hot');
      person.run(ids.p2, ids.company, 'Fixture Two', 'two@fixture.example', 'two@fixture.example', 'cold');
      const meet = db.prepare("INSERT INTO encounters(id,workspace_id,contact_id,event_id,occurred_at) VALUES (?,'demo-northstar',?,?,?)");
      const m1 = randomUUID();
      meet.run(m1, ids.p1, ids.E, '2026-09-01T10:00:00.000Z');
      meet.run(randomUUID(), ids.p2, ids.E, '2026-09-02T10:00:00.000Z');
      meet.run(randomUUID(), ids.p2, ids.F, '2026-09-10T10:00:00.000Z');
      const deal = db.prepare("INSERT INTO deals(id,workspace_id,contact_id,company_id,encounter_id,event_id,title,value_minor,stage,owner_user_id) VALUES (?,'demo-northstar',?,?,?,?,?,?,?,'demo-owner')");
      deal.run(randomUUID(), ids.p1, ids.company, m1, ids.E, 'Linked deal', 100000, 'new');
      deal.run(randomUUID(), ids.p2, ids.company, null, null, 'Unlinked deal', 200000, 'won');
    })();
  } finally { db.close(); }
  return ids;
}

test('the events list shows every event the person can reach with its own numbers', async () => {
  const ids = addFixture();
  const maya = await signIn('demo-owner', 'demo-northstar');
  const res = await maya.send('GET', '/api/events');
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json() as { events: Summary[]; canManage: boolean; canSeeMoney: boolean };
  expect(body.canManage).toBe(true);
  const active = body.events.find((event) => event.id === 'event-main-active')!;
  expect(active.people).toBeGreaterThanOrEqual(30);
  expect(active.deals.open + active.deals.won + active.deals.lost).toBeGreaterThan(20);
  expect(body.events.find((event) => event.id === ids.E)).toMatchObject({ people: 2, conversations: 2, spend_minor: 500000, deals: { open: 1, won: 1, lost: 0, openValue: 100000, wonValue: 200000 } });
  // Person two was met at both events; their unlinked deal belongs to the first one, so the second shows none.
  expect(body.events.find((event) => event.id === ids.F)).toMatchObject({ people: 1, conversations: 1, deals: { open: 0, won: 0, lost: 0 } });
  await maya.ctx.dispose();
});

test('an event page reports people, deals, cost and a daily series, and counts a deal toward the right event', async () => {
  const ids = addFixture();
  const maya = await signIn('demo-owner', 'demo-northstar');
  const detail = await (await maya.send('GET', `/api/events/${ids.E}`)).json() as Detail;
  expect(detail.metrics).toMatchObject({ people: 2, conversations: 2, companies: 1 });
  expect(detail.deals.find((row) => row.stage === 'new')).toMatchObject({ count: 1, value: 100000 });
  expect(detail.deals.find((row) => row.stage === 'won')).toMatchObject({ count: 1, value: 200000 });
  expect(detail.daily.map((row) => row.day)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  expect(detail.daily.map((row) => row.people)).toEqual([1, 1, 0]);
  expect(detail.team).toEqual([expect.objectContaining({ name: 'Maya Chen', people: 2, wonValue: 200000 })]);
  expect(detail.cost).toMatchObject({ spend: 500000, perPerson: 250000, perWonDeal: 500000, wonValuePerSpend: 0.4 });
  const other = await (await maya.send('GET', `/api/events/${ids.F}`)).json() as Detail;
  expect(other.deals.every((row) => row.count === 0)).toBe(true);

  // Spend can be changed from the event page's own editor route, and the cost follows.
  const saved = await maya.send('PUT', `/api/events/${ids.E}`, { name: detail.event.name, startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-03T23:59:59.000Z', timeZone: 'UTC', spendMinor: 1000000, active: false });
  expect(saved.status(), await saved.text()).toBe(200);
  expect(((await (await maya.send('GET', `/api/events/${ids.E}`)).json()) as Detail).cost).toMatchObject({ spend: 1000000, perPerson: 500000 });
  await maya.ctx.dispose();
});

test('a representative sees only their events and no money, and cannot manage events', async () => {
  const jordan = await signIn('demo-rep', 'demo-northstar');
  const list = await (await jordan.send('GET', '/api/events')).json() as { events: Summary[]; canManage: boolean; canSeeMoney: boolean };
  expect(list.canManage).toBe(false);
  expect(list.canSeeMoney).toBe(false);
  expect(list.events.every((event) => event.spend_minor === null)).toBe(true);
  const detail = await jordan.send('GET', `/api/events/${list.events[0]!.id}`);
  expect(detail.status()).toBe(200);
  expect(((await detail.json()) as Detail).team).toEqual([]);
  const create = await jordan.send('POST', '/api/events', { name: 'Rep event', startsAt: '2027-01-01T00:00:00.000Z', endsAt: '2027-01-02T00:00:00.000Z', timeZone: 'UTC', spendMinor: null, active: false });
  expect(create.status()).toBe(403);
  const edit = await jordan.send('PUT', '/api/events/event-main-active', { name: 'Hijacked', startsAt: '2027-01-01T00:00:00.000Z', endsAt: '2027-01-02T00:00:00.000Z', timeZone: 'UTC', spendMinor: null, active: true });
  expect(edit.status()).toBe(403);
  await jordan.ctx.dispose();
});

test('another company cannot open these events, and an unknown event is a clean 404', async () => {
  const alex = await signIn('demo-other-company', 'demo-riverbend');
  const peek = await alex.send('GET', '/api/events/event-main-active');
  expect(peek.status()).toBe(404);
  expect(await peek.text()).not.toContain('Pacific');
  const list = await (await alex.send('GET', '/api/events')).json() as { events: Summary[] };
  expect(list.events.some((event) => event.id === 'event-main-active')).toBe(false);
  const missing = await alex.send('GET', '/api/events/nope');
  expect(missing.status()).toBe(404);
  await alex.ctx.dispose();
});

test('the Events screen lists events, opens one with its charts, and fits a phone', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Events', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Events', exact: true })).toBeVisible();
  const card = page.locator('.event-card').filter({ hasText: 'Pacific Packaging Expo' });
  await expect(card).toContainText('People met');
  await expect(card.locator('.active-event-label')).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/events\/event-main-active$/);
  await expect(page.getByRole('heading', { name: /Pacific Packaging Expo/ })).toBeVisible();
  await expect(page.getByRole('img', { name: /Daily captures for Pacific Packaging Expo/ })).toBeVisible();
  for (const heading of ['Deals by stage', 'Lead quality', 'Email follow-up', 'By team member', 'Recently met']) await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await expect(page.locator('.event-stat').filter({ hasText: 'People met' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('link', { name: '← Events' }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a representative has no Add event or Edit event button', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Jordan Lee/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  await page.goto('/events');
  await expect(page.getByRole('heading', { name: 'Events', exact: true })).toBeVisible();
  await expect(page.locator('.event-card').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add event' })).toHaveCount(0);
  await page.locator('.event-card').first().click();
  await expect(page.getByRole('button', { name: 'Edit event' })).toHaveCount(0);
  await expect(page.locator('.event-stat').filter({ hasText: 'Spend' })).toHaveCount(0);
});
