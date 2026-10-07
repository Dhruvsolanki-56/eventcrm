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

type Detail = { campaign: { status: string }; counts: { draft: number; outbox: number }; recipients: Array<{ id: string; person_name: string; subject: string; status: string }> };

// A fixture event with four people: two who can be emailed, one with no address, one who opted out.
function addGroup() {
  const db = new Database(resolve(process.env.DATABASE_PATH!));
  const ids = { event: randomUUID(), company: randomUUID(), good1: randomUUID(), good2: randomUUID(), none: randomUUID(), optedOut: randomUUID() };
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO events(id,workspace_id,name,starts_at,ends_at,time_zone) VALUES (?,'demo-northstar',?,?,?,'UTC')").run(ids.event, `Batch Expo ${ids.event.slice(0, 6)}`, '2026-09-01T00:00:00.000Z', '2026-09-03T23:59:59.000Z');
      db.prepare("INSERT INTO event_access(workspace_id,event_id,user_id) VALUES ('demo-northstar',?,'demo-owner')").run(ids.event);
      db.prepare("INSERT INTO companies(id,workspace_id,name,normalized_name) VALUES (?,'demo-northstar',?,?)").run(ids.company, `Batch Co ${ids.company.slice(0, 6)}`, ids.company);
      const person = db.prepare("INSERT INTO contacts(id,workspace_id,company_id,name,email,email_normalized,quality,do_not_contact,owner_user_id) VALUES (?,'demo-northstar',?,?,?,?,'warm',?,'demo-owner')");
      person.run(ids.good1, ids.company, 'Priya Rao', `priya-${ids.good1.slice(0, 6)}@batch.example`, `priya-${ids.good1.slice(0, 6)}@batch.example`, 0);
      person.run(ids.good2, ids.company, 'Sam Ortiz', `sam-${ids.good2.slice(0, 6)}@batch.example`, `sam-${ids.good2.slice(0, 6)}@batch.example`, 0);
      person.run(ids.none, ids.company, 'No Address', '', '', 0);
      person.run(ids.optedOut, ids.company, 'Opted Out', `out-${ids.optedOut.slice(0, 6)}@batch.example`, `out-${ids.optedOut.slice(0, 6)}@batch.example`, 1);
      const meet = db.prepare("INSERT INTO encounters(id,workspace_id,contact_id,event_id,occurred_at) VALUES (?,'demo-northstar',?,?,'2026-09-01T10:00:00.000Z')");
      for (const contact of [ids.good1, ids.good2, ids.none, ids.optedOut]) meet.run(randomUUID(), contact, ids.event);
    })();
  } finally { db.close(); }
  return ids;
}

test('a group preview says who is left out and why, and a campaign makes one draft each from one template', async () => {
  const ids = addGroup();
  const maya = await signIn('demo-owner', 'demo-northstar');
  const preview = await (await maya.send('POST', '/api/campaigns/preview', { eventId: ids.event })).json() as { matched: number; eligible: number; excluded: { noEmail: number; optedOut: number } };
  expect(preview).toMatchObject({ matched: 4, eligible: 2, excluded: { noEmail: 1, optedOut: 1 } });

  const clientCampaignId = randomUUID();
  const body = { clientCampaignId, name: 'Thank you', subject: 'Great to meet you at {{event}}, {{firstName}}', body: 'Hi {{firstName}},\n\nThanks for stopping by. Is {{company}} still looking at new packaging?', audience: { eventId: ids.event } };
  const created = await maya.send('POST', '/api/campaigns', body);
  expect(created.status(), await created.text()).toBe(201);
  expect(await created.json()).toMatchObject({ id: clientCampaignId, recipients: 2, duplicate: false });
  // The same request again is the same campaign, not a second batch.
  const again = await maya.send('POST', '/api/campaigns', body);
  expect(again.status()).toBe(200);
  expect(await again.json()).toMatchObject({ duplicate: true, recipients: 2 });

  const detail = await (await maya.send('GET', `/api/campaigns/${clientCampaignId}`)).json() as Detail;
  expect(detail.campaign.status).toBe('draft');
  expect(detail.counts.draft).toBe(2);
  expect(detail.recipients.map((row) => row.person_name).sort()).toEqual(['Priya Rao', 'Sam Ortiz']);
  expect(detail.recipients.find((row) => row.person_name === 'Priya Rao')!.subject).toMatch(/^Great to meet you at Batch Expo \w+, Priya$/);

  // Group drafts stay out of the one-by-one Email Desk.
  const desk = await (await maya.send('GET', '/api/email-desk')).json() as { drafts: Array<{ person_name: string }> };
  expect(desk.drafts.some((draft) => ['Priya Rao', 'Sam Ortiz'].includes(draft.person_name))).toBe(false);

  // Rewording rewrites every unsent draft.
  const reword = await maya.send('PUT', `/api/campaigns/${clientCampaignId}`, { subject: 'Hello {{firstName}}', body: 'Quick note for {{name}} at {{company}}.' });
  expect(await reword.json()).toMatchObject({ updated: 2 });
  const after = await (await maya.send('GET', `/api/campaigns/${clientCampaignId}`)).json() as Detail;
  expect(after.recipients.find((row) => row.person_name === 'Sam Ortiz')!.subject).toBe('Hello Sam');

  // One person can be taken off before it goes.
  const removed = await maya.send('DELETE', `/api/campaigns/${clientCampaignId}/recipients/${after.recipients.find((row) => row.person_name === 'Sam Ortiz')!.id}`);
  expect(removed.status(), await removed.text()).toBe(200);
  expect(((await (await maya.send('GET', `/api/campaigns/${clientCampaignId}`)).json()) as Detail).counts.draft).toBe(1);

  // No mail server in this suite, so approval puts them in the outbox. Nothing is sent, and the batch cannot be approved twice.
  const approved = await maya.send('POST', `/api/campaigns/${clientCampaignId}/approve`, { staggerSeconds: 30 });
  expect(approved.status(), await approved.text()).toBe(200);
  expect(await approved.json()).toMatchObject({ approved: 1, skipped: 0 });
  expect((await maya.send('POST', `/api/campaigns/${clientCampaignId}/approve`, {})).status()).toBe(409);
  expect(((await (await maya.send('GET', `/api/campaigns/${clientCampaignId}`)).json()) as Detail).counts.outbox).toBe(1);
  await maya.ctx.dispose();
});

test('an unknown placeholder, an empty group and a representative are all refused', async () => {
  const ids = addGroup();
  const maya = await signIn('demo-owner', 'demo-northstar');
  const unknown = await maya.send('POST', '/api/campaigns', { clientCampaignId: randomUUID(), name: 'Bad', subject: 'Hi {{nickname}}', body: 'Hello', audience: { eventId: ids.event } });
  expect(unknown.status()).toBe(409);
  expect(((await unknown.json()) as { message: string }).message).toContain('{{nickname}}');
  const empty = await maya.send('POST', '/api/campaigns', { clientCampaignId: randomUUID(), name: 'Nobody', subject: 'Hi', body: 'Hello', audience: { contactIds: [ids.none, ids.optedOut] } });
  expect(empty.status()).toBe(409);
  expect(((await empty.json()) as { message: string }).message).toContain('No one in this group');
  const invalid = await maya.send('POST', '/api/campaigns/preview', { stages: ['nonsense'] });
  expect(invalid.status()).toBe(400);
  await maya.ctx.dispose();

  const jordan = await signIn('demo-rep', 'demo-northstar');
  expect((await jordan.send('POST', '/api/campaigns/preview', { eventId: ids.event })).status()).toBe(403);
  expect((await jordan.send('GET', '/api/campaigns')).status()).toBe(403);
  await jordan.ctx.dispose();

  const alex = await signIn('demo-other-company', 'demo-riverbend');
  const preview = await (await alex.send('POST', '/api/campaigns/preview', { eventId: ids.event })).json() as { matched: number };
  expect(preview.matched).toBe(0);
  await alex.ctx.dispose();
});

test('cancelling a campaign removes what has not gone out', async () => {
  const ids = addGroup();
  const maya = await signIn('demo-owner', 'demo-northstar');
  const id = randomUUID();
  expect((await maya.send('POST', '/api/campaigns', { clientCampaignId: id, name: 'To cancel', subject: 'Hi {{firstName}}', body: 'Hello there.', audience: { eventId: ids.event } })).status()).toBe(201);
  const cancelled = await maya.send('POST', `/api/campaigns/${id}/cancel`);
  expect(cancelled.status(), await cancelled.text()).toBe(200);
  expect(await cancelled.json()).toMatchObject({ removed: 2 });
  expect((await maya.send('POST', `/api/campaigns/${id}/cancel`)).status()).toBe(409);
  expect(((await (await maya.send('GET', `/api/campaigns/${id}`)).json()) as Detail).campaign.status).toBe('cancelled');
  await maya.ctx.dispose();
});

test('the Group emails screen builds a group, shows who is left out, and approves it', async ({ page }) => {
  const ids = addGroup();
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Group emails', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Group emails', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New group email' }).click();
  await page.getByLabel('Event for this group email').selectOption(ids.event);
  await expect(page.getByRole('status').filter({ hasText: '2 people will get this email' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('1 with no email address, 1 who opted out');
  await page.getByLabel('Name of this group email').fill('UI thank you');
  await page.getByLabel('Subject').fill('Nice to meet you, {{firstName}}');
  await page.getByLabel('Message').fill('Hi {{firstName}}, thanks for visiting. — Maya');
  await page.getByRole('button', { name: 'Prepare drafts' }).click();
  await expect(page.getByRole('heading', { name: 'UI thank you' })).toBeVisible();
  const list = page.getByRole('list', { name: 'People in this group email' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list).toContainText('Nice to meet you, Priya');
  await page.getByRole('button', { name: 'Remove Sam Ortiz' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Approve 1 emails' }).click();
  await page.getByRole('button', { name: 'Approve all' }).click();
  await expect(list).toContainText('In outbox');
  await expect(page.getByRole('button', { name: /Approve \d+ emails/ })).toHaveCount(0);
});

test('a representative does not see Group emails', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Jordan Lee/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Group emails' })).toHaveCount(0);
});
