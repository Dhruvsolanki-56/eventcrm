import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

test('workspace draft automation saves an unsent draft only once for a conversation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json() as { authenticated?: boolean; user?: { name?: string } }).user?.name).toBe('Maya Chen');
  const csrfToken = (await page.context().cookies()).find((cookie) => cookie.name === 'gather_csrf')?.value;
  expect(csrfToken).toBeTruthy();
  const headers = { 'X-CSRF-Token': csrfToken!, 'X-Workspace-Id': 'demo-northstar' };
  const database = new Database(resolve(process.env.DATABASE_PATH!));
  const clientConversationId = randomUUID();
  const emailCount = () => (database.prepare("SELECT COUNT(*) AS count FROM emails WHERE workspace_id='demo-northstar' AND contact_id='demo-ns-contact-1'").get() as { count: number }).count;
  const jobCount = () => (database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE workspace_id='demo-northstar' AND type='email_send'").get() as { count: number }).count;
  const before = emailCount();
  const beforeJobs = jobCount();
  try {
    const enabled = await page.request.put('/api/settings', { headers, data: { key: 'draftAutomation', value: { autoDraftAfterConversation: true } } });
    expect(enabled.status(), await enabled.text()).toBe(200);
    const data = { body: 'Asked for updated sample dimensions; send only after I review.', eventId: 'event-main-active', clientConversationId };
    const first = await page.request.post('/api/contacts/demo-ns-contact-1/conversations', { headers, data });
    expect(first.status(), await first.text()).toBe(201);
    const result = await first.json() as { autoDraft: { status: string; body: string } };
    expect(result.autoDraft.status).toBe('draft');
    expect(result.autoDraft.body).toContain('updated sample dimensions');
    expect(emailCount()).toBe(before + 1);
    expect(jobCount()).toBe(beforeJobs);
    const retry = await page.request.post('/api/contacts/demo-ns-contact-1/conversations', { headers, data });
    expect(retry.status(), await retry.text()).toBe(200);
    expect((await retry.json() as { duplicate: boolean; autoDraft: unknown }).duplicate).toBe(true);
    expect(emailCount()).toBe(before + 1);
    expect(jobCount()).toBe(beforeJobs);
  } finally {
    await page.request.put('/api/settings', { headers, data: { key: 'draftAutomation', value: { autoDraftAfterConversation: false } } });
    database.close();
  }
});
