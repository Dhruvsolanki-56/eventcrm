import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

test('text-note count limits are enforced per workspace and service-wide', async ({ page }) => {
  test.skip(process.env.GATHER_NOTE_COUNT_QUOTA_MODE !== '1', 'Run with npm run test:note-count-quota to enable deliberately low test limits.');
  expect(process.env.NOTE_COUNT_WORKSPACE_LIMIT).toBe('6');
  expect(process.env.NOTE_COUNT_TOTAL_LIMIT).toBe('7');
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();

  const database = new Database(resolve(process.env.DATABASE_PATH ?? ''), { readonly: true });
  const state = (workspaceId: string, contactId: string) => ({
    notes: (database.prepare(`SELECT COUNT(*) AS count FROM notes WHERE workspace_id=? AND kind='text'`).get(workspaceId) as { count: number }).count,
    audit: (database.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id=? AND action='note_added' AND target_id=?`).get(workspaceId, contactId) as { count: number }).count,
    version: (database.prepare(`SELECT version FROM contacts WHERE workspace_id=? AND id=?`).get(workspaceId, contactId) as { version: number }).version,
  });
  const csrfToken = async () => page.evaluate(async () => {
    const result = await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json() as { csrfToken: string };
    const cookie = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('gather_csrf='))?.slice('gather_csrf='.length);
    return { ...result, cookieMatches: decodeURIComponent(cookie ?? '') === result.csrfToken };
  });
  const write = async (contactId: string, workspaceId: string, body: string, token: string) => page.evaluate(async ({ contactId, workspaceId, body, token }) => {
    const response = await fetch(`/api/contacts/${contactId}/notes`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, 'X-Workspace-Id': workspaceId },
      body: JSON.stringify({ body }),
    });
    return { status: response.status, text: await response.text() };
  }, { contactId, workspaceId, body, token });
  const logout = (token: string) => page.evaluate(async (csrfToken) => (await fetch('/api/auth/logout', {
    method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken },
  })).status, token);

  try {
    const northstar = 'demo-ns-contact-1';
    const northstarBefore = state('demo-northstar', northstar);
    let csrf = await csrfToken();
    expect(csrf.cookieMatches).toBe(true);
    const first = await write(northstar, 'demo-northstar', 'A short saved note.', csrf.csrfToken);
    expect(first.status, first.text).toBe(201);
    const afterFirst = state('demo-northstar', northstar);
    expect(afterFirst).toEqual({ notes: northstarBefore.notes + 1, audit: northstarBefore.audit + 1, version: northstarBefore.version + 1 });

    const workspaceRejected = await write('demo-ns-contact-2', 'demo-northstar', 'Another short note.', csrf.csrfToken);
    expect(workspaceRejected.status).toBe(413);
    expect(JSON.parse(workspaceRejected.text).code).toBe('note_storage_limit');
    expect(state('demo-northstar', northstar)).toEqual(afterFirst);

    expect(await logout(csrf.csrfToken)).toBe(200);
    await page.goto('/');
    await page.getByRole('button', { name: /Alex Rivera/ }).click();
    await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
    csrf = await csrfToken();
    expect(csrf.cookieMatches).toBe(true);
    const riverbend = 'demo-rb-contact-1';
    const riverbendBefore = state('demo-riverbend', riverbend);
    const second = await write(riverbend, 'demo-riverbend', 'A second workspace note.', csrf.csrfToken);
    expect(second.status, second.text).toBe(201);
    const afterSecond = state('demo-riverbend', riverbend);
    expect(afterSecond).toEqual({ notes: riverbendBefore.notes + 1, audit: riverbendBefore.audit + 1, version: riverbendBefore.version + 1 });

    expect(await logout(csrf.csrfToken)).toBe(200);
    await page.goto('/');
    await page.getByRole('button', { name: /Sam Patel/ }).click();
    await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
    csrf = await csrfToken();
    expect(csrf.cookieMatches).toBe(true);
    const sam = 'demo-sam-contact-1';
    const samBefore = state('demo-sam-space', sam);
    const serviceRejected = await write(sam, 'demo-sam-space', 'This exceeds the shared count.', csrf.csrfToken);
    expect(serviceRejected.status).toBe(413);
    expect(JSON.parse(serviceRejected.text).code).toBe('note_storage_limit');
    expect(state('demo-sam-space', sam)).toEqual(samBefore);
    expect(state('demo-northstar', northstar)).toEqual(afterFirst);
    expect(state('demo-riverbend', riverbend)).toEqual(afterSecond);
  } finally { database.close(); }
});
