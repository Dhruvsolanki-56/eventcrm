import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

test('Email Desk approval is explicit and stays in outbox when sending is unavailable', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json() as { user?: { name?: string } }).user?.name).toBe('Maya Chen');
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const headers = { 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': 'demo-northstar' };
  const response = await page.request.post('/api/contacts/demo-ns-contact-1/email-draft', { headers });
  expect(response.status(), await response.text()).toBe(201);
  const draft = await response.json() as { id: string };
  await page.goto('/email');
  await page.locator(`.email-desk-row[data-draft-id="${draft.id}"]`).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Approve email' }).click();
  await page.locator('[data-confirm-accept]').click();
  await expect(page.getByText('Approved for outbox. No mail server sent this message.')).toBeVisible();
  const status = await (await page.request.get(`/api/emails/${draft.id}`, { headers })).json() as { status: string };
  expect(status.status).toBe('outbox');
});

test('checked conversation context becomes a saved draft, appears in Email Desk, and counts in event analytics', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json() as { user?: { name: string } }).user?.name).toBe('Maya Chen');
  const database = new Database(resolve(process.env.DATABASE_PATH!));
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const headers = { 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': 'demo-northstar' };
  const before = await (await page.request.get('/api/analytics?days=7&eventId=event-main-active', { headers })).json() as { workflow: { draftsPrepared: number } };
  const id = randomUUID();
  try {
    const saved = await page.request.post('/api/contacts/demo-ns-contact-1/conversations', { headers, data: {
      body: 'Tessa asked whether the short-run cartons can use recycled stock.', eventId: 'event-main-active', clientConversationId: id,
      summary: 'Tessa needs a short-run recycled carton option.', openQuestion: 'Can the cartons use recycled stock?',
      promisedNextStep: 'I will share the material specification.', changedSinceLast: 'She now has a firm October launch.',
    } });
    expect(saved.status(), await saved.text()).toBe(201);
    const encounterId = (await saved.json() as { encounterId: string }).encounterId;
    const draftResponse = await page.request.post('/api/contacts/demo-ns-contact-1/email-draft', { headers });
    expect(draftResponse.status(), await draftResponse.text()).toBe(201);
    const draft = await draftResponse.json() as { id: string; body: string; sourcesUsed: Array<{ label: string }> };
    expect(draft.body).toContain('short-run recycled carton');
    expect(draft.sourcesUsed.map((source) => source.label)).toContain('Agreed next step');
    await page.goto('/email');
    await expect(page.getByRole('heading', { name: 'Email Desk' })).toBeVisible();
    await page.locator(`.email-desk-row[data-draft-id="${draft.id}"]`).click();
    await expect(page.getByText('She now has a firm October launch.')).toBeVisible();
    await page.screenshot({ path: resolve('test-results/email-desk-desktop.png'), fullPage: true });
    await page.getByLabel('Subject').fill('Material details for October');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Saved draft · not sent')).toBeVisible();
    expect((database.prepare('SELECT subject,status FROM emails WHERE id=?').get(draft.id) as { subject: string; status: string })).toEqual({ subject: 'Material details for October', status: 'draft' });
    const after = await (await page.request.get('/api/analytics?days=7&eventId=event-main-active', { headers })).json() as { workflow: { draftsPrepared: number } };
    expect(after.workflow.draftsPrepared).toBe(before.workflow.draftsPrepared + 1);
    const correction = await page.request.put(`/api/contacts/demo-ns-contact-1/conversations/${encounterId}/context`, { headers, data: { summary: 'Tessa needs a short-run recycled carton option.', openQuestion: 'Can the cartons use recycled stock?', promisedNextStep: 'I will share the material specification.', changedSinceLast: 'Launch timing has been confirmed for October.' } });
    expect(correction.status(), await correction.text()).toBe(200);
    await page.goto('/people/demo-ns-contact-1');
    await expect(page.getByText('Launch timing has been confirmed for October.')).toBeVisible();
    await page.getByRole('button', { name: 'Correct context' }).first().click();
    await page.getByLabel('What changed', { exact: true }).fill('The launch moved to November.');
    await page.getByRole('button', { name: 'Save correction' }).click();
    await expect(page.getByText('The launch moved to November.')).toBeVisible();
    await page.goto('/email');
    await page.locator(`.email-desk-row[data-draft-id="${draft.id}"]`).click();
    await expect(page.getByText('She now has a firm October launch.')).toBeVisible();
    await expect(page.getByText('The launch moved to November.')).toHaveCount(0);
    await page.getByRole('button', { name: /Approved & outbox/ }).click();
    await expect(page.getByRole('button', { name: /Approved & outbox/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: /Prepare next/ }).click();
    await expect(page.getByRole('button', { name: /Prepare next/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('Search email queue').fill('no matching person');
    await expect(page.getByText('No people ready for a draft')).toBeVisible();
    await page.getByLabel('Search email queue').fill('');
    await page.getByRole('button', { name: 'Prepare draft' }).first().click();
    await expect(page.getByRole('button', { name: /Drafts/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByRole('button', { name: /Drafts/ }).click();
    await page.locator(`.email-desk-row[data-draft-id="${draft.id}"]`).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => page.locator('[data-rail]').evaluate((element) => element.getBoundingClientRect().right <= 0)).toBe(true);
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
    await page.screenshot({ path: resolve('test-results/email-desk-phone.png') });
  } finally { database.close(); }
});

test('Email Desk excludes another event and another tenant', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Priya Shah/ }).click();
  const manager = await (await page.request.get('/api/email-desk', { headers: { 'X-Workspace-Id': 'demo-northstar' } })).json() as { drafts: Array<{ id: string }> };
  expect(manager.drafts.some((draft) => draft.id === 'demo-email-tessa-sent')).toBe(false);
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const denied = await page.request.put('/api/contacts/demo-ns-contact-1/conversations/demo-encounter-tessa-ended/context', { headers: { 'X-Workspace-Id': 'demo-northstar', 'X-CSRF-Token': csrf.csrfToken }, data: { summary: 'Should not save', openQuestion: '', promisedNextStep: '', changedSinceLast: '' } });
  expect(denied.status()).toBe(404);
  await page.goto('/email');
  await expect(page.getByRole('heading', { name: 'Email Desk' })).toBeVisible();
  await page.locator('[data-account-trigger]').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: /Sam Patel/ }).click();
  const personal = await (await page.request.get('/api/email-desk', { headers: { 'X-Workspace-Id': 'demo-sam-space' } })).json() as { drafts: Array<{ contact_id: string }>; people: Array<{ id: string }> };
  expect(personal.drafts.every((draft) => draft.contact_id.startsWith('demo-sam'))).toBe(true);
  expect(personal.people.every((person) => person.id.startsWith('demo-sam'))).toBe(true);
});

test('analytics distinguishes approval, server acceptance and a recorded reply', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json() as { user?: { name: string } }).user?.name).toBe('Maya Chen');
  const database = new Database(resolve(process.env.DATABASE_PATH!));
  const emailId = randomUUID();
  const url = '/api/analytics?days=7&eventId=event-main-active';
  try {
    const before = await (await page.request.get(url, { headers: { 'X-Workspace-Id': 'demo-northstar' } })).json() as { workflow: { userApproved: number; serverAccepted: number; repliesRecorded: number } };
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO emails(id,workspace_id,contact_id,encounter_id,recipient,subject,body,status,approved_at,sent_to_server_at,reply_recorded_at,created_at,created_by)
      VALUES (?,'demo-northstar','demo-ns-contact-1','demo-encounter-1','tessa@acmepackaging.example','Test stage','Test stage','replied',?,?,?,?,'demo-owner')`)
      .run(emailId, now, now, now, now);
    const after = await (await page.request.get(url, { headers: { 'X-Workspace-Id': 'demo-northstar' } })).json() as { workflow: { userApproved: number; serverAccepted: number; repliesRecorded: number } };
    expect(after.workflow.userApproved).toBe(before.workflow.userApproved + 1);
    expect(after.workflow.serverAccepted).toBe(before.workflow.serverAccepted + 1);
    expect(after.workflow.repliesRecorded).toBe(before.workflow.repliesRecorded + 1);
  } finally { database.prepare('DELETE FROM emails WHERE id=?').run(emailId); database.close(); }
});
