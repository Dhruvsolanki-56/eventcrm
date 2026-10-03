import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
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
    const started = performance.now();
    const first = await page.request.post('/api/contacts/demo-ns-contact-1/conversations', { headers, data });
    console.log(`Local conversation save + template draft: ${Math.round(performance.now() - started)} ms (AI provider disabled in this test)`);
    expect(first.status(), await first.text()).toBe(201);
    const result = await first.json() as { autoDraft: { id: string; status: string; subject: string; body: string } };
    expect(result.autoDraft.status).toBe('draft');
    expect(result.autoDraft.body).toContain('updated sample dimensions');
    expect(emailCount()).toBe(before + 1);
    expect(jobCount()).toBe(beforeJobs);
    const draftJobId = randomUUID();
    const originalHash = createHash('sha256').update(`${result.autoDraft.subject}\u0000${result.autoDraft.body}`).digest('hex');
    database.prepare(`INSERT INTO jobs(id,workspace_id,type,payload_json,run_at,max_attempts) VALUES (?,'demo-northstar','email_draft',?,?,1)`)
      .run(draftJobId, JSON.stringify({ emailId: result.autoDraft.id, originalHash }), new Date().toISOString());
    await expect.poll(async () => (await (await page.request.get(`/api/emails/${result.autoDraft.id}`, { headers })).json() as { generation: string }).generation).toBe('fallback');
    expect((database.prepare('SELECT status FROM emails WHERE id=?').get(result.autoDraft.id) as { status: string }).status).toBe('draft');
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

test('a natural note is enough; optional AI context cannot silently save when unavailable', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/people/demo-ns-contact-1');
  await page.getByLabel('What did you discuss?').fill('Tessa asked for a sample specification; we have not promised a delivery date.');
  await page.getByText('Add checked details (optional)').click();
  await page.getByRole('button', { name: 'Suggest conversation context' }).click();
  await expect(page.getByText(/AI note help is not configured/)).toBeVisible();
  await expect(page.getByLabel('What did you discuss?')).toHaveValue('Tessa asked for a sample specification; we have not promised a delivery date.');
});
