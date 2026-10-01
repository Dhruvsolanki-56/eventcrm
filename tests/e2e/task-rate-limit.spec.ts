import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

test('task creation is rate-limited per member, not shared by workspace or client IP', async ({ page }) => {
  test.skip(process.env.GATHER_TASK_RATE_MODE !== '1', 'Run with npm run test:task-rate to enable the deliberately low test limit.');
  expect(process.env.GATHER_TASK_RATE_LIMIT).toBe('2');
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();

  const database = new Database(resolve(process.env.DATABASE_PATH ?? ''), { readonly: true });
  const tasks = () => (database.prepare(`SELECT COUNT(*) AS count FROM tasks`).get() as { count: number }).count;
  const csrfToken = async () => page.evaluate(async () => {
    const result = await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json() as { csrfToken: string };
    const cookie = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('gather_csrf='))?.slice('gather_csrf='.length);
    return { ...result, cookieMatches: decodeURIComponent(cookie ?? '') === result.csrfToken };
  });
  const write = async (contactId: string, workspaceId: string, token: string) => page.evaluate(async ({ contactId: id, workspaceId: spaceId, csrf }) => {
    const response = await fetch(`/api/contacts/${id}/tasks`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-Workspace-Id': spaceId },
      body: JSON.stringify({ kind: 'follow_up', dueAt: '2035-06-15T17:00:00.000Z', title: 'Rate limit test follow-up', note: 'Synthetic test only.', timeZone: 'UTC', allowOverlap: false }),
    });
    return { status: response.status, body: await response.json() as { code?: string } };
  }, { contactId, workspaceId, csrf: token });

  try {
    let csrf = await csrfToken();
    expect(csrf.cookieMatches).toBe(true);
    const initial = tasks();
    for (const contactId of ['demo-ns-contact-1', 'demo-ns-contact-2']) {
      const response = await write(contactId, 'demo-northstar', csrf.csrfToken);
      expect(response.status, `${contactId}: ${JSON.stringify(response.body)}`).toBe(201);
    }
    const afterAllowedRequests = tasks();
    expect(afterAllowedRequests).toBe(initial + 2);

    const limited = await write('demo-ns-contact-3', 'demo-northstar', csrf.csrfToken);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('task_rate_limit');
    expect(tasks()).toBe(afterAllowedRequests);

    expect(await page.evaluate(async (token) => (await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': token } })).status, csrf.csrfToken)).toBe(200);
    await page.goto('/');
    await page.getByRole('button', { name: /Alex Rivera/ }).click();
    csrf = await csrfToken();
    expect(csrf.cookieMatches).toBe(true);
    const otherMember = await write('demo-rb-contact-1', 'demo-riverbend', csrf.csrfToken);
    expect(otherMember.status, JSON.stringify(otherMember.body)).toBe(201);
    expect(tasks()).toBe(afterAllowedRequests + 1);
  } finally { database.close(); }
});
