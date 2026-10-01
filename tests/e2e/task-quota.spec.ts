import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

test('follow-up limits are enforced per workspace and service-wide without partial writes', async ({ page }) => {
  test.skip(process.env.GATHER_TASK_QUOTA_MODE !== '1', 'Run with npm run test:task-quota to enable deliberately low test limits.');
  expect(process.env.TASK_COUNT_WORKSPACE_LIMIT).toBe('8');
  expect(process.env.TASK_COUNT_TOTAL_LIMIT).toBe('9');
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();

  const database = new Database(resolve(process.env.DATABASE_PATH ?? ''), { readonly: true });
  const state = () => ({
    allTasks: (database.prepare(`SELECT COUNT(*) AS count FROM tasks`).get() as { count: number }).count,
    allTaskAudit: (database.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE action='task_created'`).get() as { count: number }).count,
    northstarTasks: (database.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE workspace_id='demo-northstar'`).get() as { count: number }).count,
    northstarTaskAudit: (database.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id='demo-northstar' AND action='task_created'`).get() as { count: number }).count,
    riverbendTasks: (database.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE workspace_id='demo-riverbend'`).get() as { count: number }).count,
    riverbendTaskAudit: (database.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id='demo-riverbend' AND action='task_created'`).get() as { count: number }).count,
  });
  const write = async (contactId: string, workspaceId: string, token: string) => page.evaluate(async ({ contactId, workspaceId, token }) => {
    const response = await fetch(`/api/contacts/${contactId}/tasks`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, 'X-Workspace-Id': workspaceId },
      body: JSON.stringify({
        kind: 'follow_up', dueAt: '2035-06-15T17:00:00.000Z', title: 'Quota test follow-up',
        note: 'Synthetic test only.', timeZone: 'UTC', allowOverlap: false,
      }),
    });
    return { status: response.status, text: await response.text() };
  }, { contactId, workspaceId, token });
  const logout = (token: string) => page.evaluate(async (csrfToken) => (await fetch('/api/auth/logout', {
    method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken },
  })).status, token);

  try {
    const initial = state();
    expect(initial.northstarTasks).toBe(7);
    expect(initial.allTasks).toBe(7);
    let csrf = await page.evaluate(async () => (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json() as Promise<{ csrfToken: string }>);
    const first = await write('demo-ns-contact-1', 'demo-northstar', csrf.csrfToken);
    expect(first.status, first.text).toBe(201);
    const afterFirst = state();
    expect(afterFirst).toEqual({ ...initial, allTasks: 8, allTaskAudit: initial.allTaskAudit + 1, northstarTasks: 8, northstarTaskAudit: initial.northstarTaskAudit + 1 });

    const workspaceRejected = await write('demo-ns-contact-2', 'demo-northstar', csrf.csrfToken);
    expect(workspaceRejected.status).toBe(413);
    expect(JSON.parse(workspaceRejected.text).code).toBe('task_storage_limit');
    expect(state()).toEqual(afterFirst);

    expect(await logout(csrf.csrfToken)).toBe(200);
    await page.goto('/');
    await page.getByRole('button', { name: /Alex Rivera/ }).click();
    csrf = await page.evaluate(async () => (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json() as Promise<{ csrfToken: string }>);
    const second = await write('demo-rb-contact-1', 'demo-riverbend', csrf.csrfToken);
    expect(second.status, second.text).toBe(201);
    const afterSecond = state();
    expect(afterSecond.allTasks).toBe(9);
    expect(afterSecond.allTaskAudit).toBe(initial.allTaskAudit + 2);
    expect(afterSecond.riverbendTasks).toBe(1);
    expect(afterSecond.riverbendTaskAudit).toBe(1);

    expect(await logout(csrf.csrfToken)).toBe(200);
    await page.goto('/');
    await page.getByRole('button', { name: /Sam Patel/ }).click();
    csrf = await page.evaluate(async () => (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json() as Promise<{ csrfToken: string }>);
    const serviceRejected = await write('demo-sam-contact-1', 'demo-sam-space', csrf.csrfToken);
    expect(serviceRejected.status).toBe(413);
    expect(JSON.parse(serviceRejected.text).code).toBe('task_storage_limit');
    expect(state()).toEqual(afterSecond);
  } finally { database.close(); }
});
