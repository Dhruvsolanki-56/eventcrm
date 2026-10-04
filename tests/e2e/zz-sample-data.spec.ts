import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

test('sample data can be cleared from Settings without removing accounts or other workspaces', async ({ page }) => {
  const databasePath = resolve(process.env.DATABASE_PATH ?? '');
  const counts = (workspaceId: string) => {
    const db = new Database(databasePath, { readonly: true });
    try {
      return {
        companies: Number((db.prepare('SELECT COUNT(*) AS total FROM companies WHERE workspace_id=?').get(workspaceId) as { total: number }).total),
        contacts: Number((db.prepare('SELECT COUNT(*) AS total FROM contacts WHERE workspace_id=?').get(workspaceId) as { total: number }).total),
        events: Number((db.prepare('SELECT COUNT(*) AS total FROM events WHERE workspace_id=?').get(workspaceId) as { total: number }).total),
      };
    } finally { db.close(); }
  };
  const clearAuditCount = (workspaceId: string) => {
    const db = new Database(databasePath, { readonly: true });
    try { return Number((db.prepare(`SELECT COUNT(*) AS total FROM audit_events WHERE workspace_id=? AND action='sample_data_cleared'`).get(workspaceId) as { total: number }).total); }
    finally { db.close(); }
  };

  expect(counts('demo-northstar').companies).toBeGreaterThan(0);
  expect(counts('demo-sam-space').contacts).toBeGreaterThan(0);
  const otherCompanyCounts = counts('demo-riverbend');
  expect(otherCompanyCounts.contacts).toBeGreaterThan(0);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Data & activity/ }).click();
  const clearPanel = page.locator('.sample-clear-panel');
  await expect(clearPanel.getByRole('heading', { name: 'Clear sample data.' })).toBeVisible();
  await clearPanel.getByLabel('Type CLEAR to confirm').fill('CLEAR');
  await clearPanel.getByRole('button', { name: 'Clear sample data' }).click();
  await expect(page.getByRole('heading', { name: /Good morning, Maya/ })).toBeVisible();
  expect(counts('demo-northstar')).toEqual({ companies: 0, contacts: 0, events: 0 });
  expect(counts('demo-riverbend')).toEqual(otherCompanyCounts);
  expect(counts('demo-sam-space').contacts).toBeGreaterThan(0);
  expect(clearAuditCount('demo-northstar')).toBe(1);
  const db = new Database(databasePath, { readonly: true });
  try {
    expect(Number((db.prepare(`SELECT COUNT(*) AS total FROM memberships WHERE workspace_id='demo-northstar' AND status='active'`).get() as { total: number }).total)).toBeGreaterThan(0);
  } finally { db.close(); }
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Data & activity/ }).click();
  await expect(page.locator('.sample-clear-panel')).toHaveCount(0);

  await page.locator('.profile-button').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Good to see you.' })).toBeVisible();
  await page.getByRole('button', { name: /Sam Patel Attendee/ }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Data & activity/ }).click();
  await expect(page.locator('.sample-clear-panel')).toBeVisible();
  const mediaPathsDb = new Database(databasePath, { readonly: true });
  let audioPaths: string[];
  try {
    audioPaths = (mediaPathsDb.prepare(`SELECT audio_path FROM notes WHERE workspace_id='demo-sam-space' AND kind='audio' AND audio_path IS NOT NULL`).all() as Array<{ audio_path: string }>).map(({ audio_path }) => resolve(audio_path));
  } finally { mediaPathsDb.close(); }
  await page.locator('.sample-clear-panel').getByLabel('Type CLEAR to confirm').fill('CLEAR');
  await page.locator('.sample-clear-panel').getByRole('button', { name: 'Clear sample data' }).click();
  await expect(page.getByRole('heading', { name: /Good morning, Sam/ })).toBeVisible();
  expect(counts('demo-sam-space')).toEqual({ companies: 0, contacts: 0, events: 0 });
  expect(counts('demo-riverbend')).toEqual(otherCompanyCounts);
  expect(clearAuditCount('demo-sam-space')).toBe(1);
  expect(audioPaths.every((path) => !existsSync(path))).toBe(true);
});
