import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

test('text-note workspace and shared-service quotas reject writes atomically', async ({ page }) => {
  test.skip(process.env.GATHER_NOTE_QUOTA_MODE !== '1', 'Run with npm run test:note-quota to enable deliberately low test limits.');
  expect(process.env.NOTE_STORAGE_WORKSPACE_LIMIT_BYTES).toBe('3000');
  expect(process.env.NOTE_STORAGE_TOTAL_LIMIT_BYTES).toBe('5000');
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();

  const database = new Database(resolve(process.env.DATABASE_PATH ?? ''), { readonly: true });
  const state = (workspaceId: string, contactId: string) => ({
    notes: (database.prepare(`SELECT COUNT(*) AS count FROM notes WHERE workspace_id=? AND kind='text'`).get(workspaceId) as { count: number }).count,
    audit: (database.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id=? AND action='note_added' AND target_id=?`).get(workspaceId, contactId) as { count: number }).count,
    version: (database.prepare(`SELECT version FROM contacts WHERE workspace_id=? AND id=?`).get(workspaceId, contactId) as { version: number }).version,
  });

  try {
    const northstarContact = 'demo-ns-contact-1';
    const northstarBefore = state('demo-northstar', northstarContact);
    const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
    const headers = { 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': 'demo-northstar' };
    const first = await page.request.post(`/api/contacts/${northstarContact}/notes`, { data: { body: 'a'.repeat(2500) }, headers });
    expect(first.status(), await first.text()).toBe(201);

    const afterFirst = state('demo-northstar', northstarContact);
    expect(afterFirst).toEqual({ notes: northstarBefore.notes + 1, audit: northstarBefore.audit + 1, version: northstarBefore.version + 1 });
    const otherContactBefore = state('demo-northstar', 'demo-ns-contact-2');
    await page.goto('/people/demo-ns-contact-2');
    await expect(page.getByRole('heading', { name: 'Noah Price' })).toBeVisible();
    await page.locator('#person-note').fill('b'.repeat(600));
    await page.getByRole('button', { name: 'Add conversation' }).click();
    await expect(page.locator('.note-form .form-error')).toContainText('This space has reached its saved-note limit.');
    expect(state('demo-northstar', northstarContact)).toEqual(afterFirst);
    expect(state('demo-northstar', 'demo-ns-contact-2')).toEqual(otherContactBefore);

    const logout = await page.request.post('/api/auth/logout', { headers: { 'X-CSRF-Token': csrf.csrfToken } });
    expect(logout.status()).toBe(200);
    await page.goto('/');
    await page.getByRole('button', { name: /Alex Rivera/ }).click();
    await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
    const riverbendContact = 'demo-rb-contact-1';
    const riverbendBefore = state('demo-riverbend', riverbendContact);
    const riverbendCsrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
    const riverbendHeaders = { 'X-CSRF-Token': riverbendCsrf.csrfToken, 'X-Workspace-Id': 'demo-riverbend' };
    const second = await page.request.post(`/api/contacts/${riverbendContact}/notes`, { data: { body: 'c'.repeat(1800) }, headers: riverbendHeaders });
    expect(second.status(), await second.text()).toBe(201);
    const afterSecond = state('demo-riverbend', riverbendContact);
    expect(afterSecond).toEqual({ notes: riverbendBefore.notes + 1, audit: riverbendBefore.audit + 1, version: riverbendBefore.version + 1 });

    const sharedRejected = await page.request.post(`/api/contacts/${riverbendContact}/notes`, { data: { body: 'd'.repeat(800) }, headers: riverbendHeaders });
    expect(sharedRejected.status()).toBe(413);
    expect(await sharedRejected.json()).toMatchObject({ code: 'note_storage_limit', message: /shared service/i });
    expect(state('demo-riverbend', riverbendContact)).toEqual(afterSecond);
    expect(state('demo-northstar', northstarContact)).toEqual(afterFirst);
  } finally { database.close(); }
});
