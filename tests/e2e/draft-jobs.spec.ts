import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// AI is switched off in the test server, so an improvement job cannot succeed. What matters here is how many times it is tried.
test('AI draft polish is tried twice, but a draft you already changed is never retried', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json() as { user?: { name?: string } }).user?.name).toBe('Maya Chen');
  const csrfToken = (await page.context().cookies()).find((cookie) => cookie.name === 'gather_csrf')?.value;
  const headers = { 'X-CSRF-Token': csrfToken!, 'X-Workspace-Id': 'demo-northstar' };
  const database = new Database(resolve(process.env.DATABASE_PATH!));
  try {
    await page.request.put('/api/settings', { headers, data: { key: 'draftAutomation', value: { autoDraftAfterConversation: true } } });
    const saved = await page.request.post('/api/contacts/demo-ns-contact-1/conversations', { headers, data: { body: `Wants revised carton sizes ${randomUUID()}`, eventId: 'event-main-active', clientConversationId: randomUUID() } });
    expect(saved.status(), await saved.text()).toBe(201);
    const draft = (await saved.json() as { autoDraft: { id: string; subject: string; body: string } }).autoDraft;
    const hashOf = (subject: string, body: string) => createHash('sha256').update(`${subject}\u0000${body}`).digest('hex');
    const queue = (originalHash: string) => {
      const id = randomUUID();
      database.prepare(`INSERT INTO jobs(id,workspace_id,type,payload_json,run_at,max_attempts) VALUES (?,'demo-northstar','email_draft',?,?,2)`)
        .run(id, JSON.stringify({ emailId: draft.id, originalHash }), new Date().toISOString());
      return id;
    };
    const result = (id: string) => database.prepare('SELECT status, attempts FROM jobs WHERE id=?').get(id) as { status: string; attempts: number };

    // The AI cannot help: one more try, then the template stays.
    const unavailable = queue(hashOf(draft.subject, draft.body));
    await expect.poll(() => result(unavailable).status, { timeout: 15_000 }).toBe('failed');
    expect(result(unavailable).attempts).toBe(2);

    // The text no longer matches what the job started from (the person edited it): stop at once, nothing to retry.
    const edited = queue(hashOf('Something else', 'The person rewrote this'));
    await expect.poll(() => result(edited).status, { timeout: 15_000 }).toBe('failed');
    expect(result(edited).attempts).toBe(1);
  } finally {
    await page.request.put('/api/settings', { headers, data: { key: 'draftAutomation', value: { autoDraftAfterConversation: false } } });
    database.close();
  }
});
