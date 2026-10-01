import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

test('Home points to review, due follow-ups, missing details, then capture', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();

  const database = new Database(resolve(process.env.DATABASE_PATH ?? ''));
  const workspaceId = 'demo-northstar';
  const actorId = 'demo-owner';
  const reviewScanId = randomUUID();
  const dueTaskId = randomUUID();
  const originalDueTasks = database.prepare(`SELECT id,status,snoozed_until FROM tasks
    WHERE workspace_id=? AND kind='follow_up' AND status='open' AND date(due_at)<=date('now')
      AND (snoozed_until IS NULL OR datetime(snoozed_until)<=datetime('now'))`).all(workspaceId) as Array<{ id: string; status: string; snoozed_until: string | null }>;
  const originalKnowledge = database.prepare(`SELECT value_json,updated_at FROM workspace_settings WHERE workspace_id=? AND key='knowledge'`)
    .get(workspaceId) as { value_json: string; updated_at: string } | undefined;
  try {
    database.transaction(() => {
      database.prepare(`INSERT INTO scans(id,workspace_id,client_scan_id,source,status,created_by) VALUES (?,?,?,'gallery','ready',?)`)
        .run(reviewScanId, workspaceId, randomUUID(), actorId);
    })();

    await page.goto('/home');
    const actionCard = page.locator('.next-action-card');
    await expect(actionCard.getByRole('heading', { name: '1 card is waiting for review.' })).toBeVisible();
    await expect(actionCard.getByRole('link', { name: /Review next card/ })).toHaveAttribute('href', `/review/${reviewScanId}`);
    await actionCard.getByRole('link', { name: /Review next card/ }).click();
    await expect(page).toHaveURL(`/review/${reviewScanId}`);

    database.transaction(() => {
      database.prepare(`UPDATE scans SET status='saved' WHERE id=? AND workspace_id=?`).run(reviewScanId, workspaceId);
      database.prepare(`INSERT INTO tasks(id,workspace_id,contact_id,kind,status,due_at,time_zone,title,note,created_by)
        VALUES (?,?,?,'follow_up','open',?,'UTC','Call about samples','Check sample options',?)`)
        .run(dueTaskId, workspaceId, 'demo-ns-contact-1', new Date(Date.now() - 60_000).toISOString(), actorId);
    })();
    await page.goto('/home');
    const dueDashboard = await (await page.request.get('/api/dashboard')).json() as { counts: { follow_ups_due: number } };
    expect(dueDashboard.counts.follow_ups_due).toBeGreaterThan(0);
    const dueCount = dueDashboard.counts.follow_ups_due;
    await expect(actionCard.getByRole('heading', { name: `${dueCount} ${dueCount === 1 ? 'follow-up needs' : 'follow-ups need'} attention.` })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await actionCard.getByRole('link', { name: 'Open follow-ups' }).click();
    await expect(page).toHaveURL('/follow-ups');

    database.transaction(() => {
      database.prepare(`UPDATE tasks SET status='done' WHERE id=? AND workspace_id=?`).run(dueTaskId, workspaceId);
      for (const task of originalDueTasks) database.prepare(`UPDATE tasks SET status='done' WHERE id=? AND workspace_id=?`).run(task.id, workspaceId);
      database.prepare(`INSERT INTO workspace_settings(workspace_id,key,value_json) VALUES (?,'knowledge',?)
        ON CONFLICT(workspace_id,key) DO UPDATE SET value_json=excluded.value_json`).run(workspaceId, JSON.stringify({ whatYouSell: '', productsText: '' }));
    })();
    await page.goto('/home');
    await expect(actionCard.getByRole('heading', { name: 'Add what you sell so emails sound like you.' })).toBeVisible();
    await expect(actionCard.getByRole('link', { name: 'Add work details' })).toHaveAttribute('href', '/settings');
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'What your team sells' })).toBeVisible();

    database.prepare(`UPDATE workspace_settings SET value_json=? WHERE workspace_id=? AND key='knowledge'`)
      .run(JSON.stringify({ whatYouSell: 'Recyclable packaging' }), workspaceId);
    await page.goto('/home');
    await expect(actionCard.getByRole('heading', { name: 'Start with the card you just collected.' })).toBeVisible();
    await expect(actionCard.getByRole('link', { name: 'Open camera' })).toHaveAttribute('href', '/scan');
  } finally {
    database.transaction(() => {
      database.prepare(`DELETE FROM scans WHERE id=? AND workspace_id=?`).run(reviewScanId, workspaceId);
      database.prepare(`DELETE FROM tasks WHERE id=? AND workspace_id=?`).run(dueTaskId, workspaceId);
      for (const task of originalDueTasks) database.prepare(`UPDATE tasks SET status=?,snoozed_until=? WHERE id=? AND workspace_id=?`)
        .run(task.status, task.snoozed_until, task.id, workspaceId);
      if (originalKnowledge) {
        database.prepare(`INSERT INTO workspace_settings(workspace_id,key,value_json,updated_at) VALUES (?,'knowledge',?,?)
          ON CONFLICT(workspace_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
          .run(workspaceId, originalKnowledge.value_json, originalKnowledge.updated_at);
      } else database.prepare(`DELETE FROM workspace_settings WHERE workspace_id=? AND key='knowledge'`).run(workspaceId);
    })();
    database.close();
  }
});
