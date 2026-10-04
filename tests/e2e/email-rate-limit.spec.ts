import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

test('email approval and retry enforce durable actor and workspace hourly quotas', async ({ page }) => {
  test.skip(!process.env.SMTP_CAPTURE_PATH, 'Run with npm run test:mail; this journey needs the local SMTP test fixture.');
  const rejectPath = process.env.SMTP_REJECT_PATH;
  const dbPath = process.env.DATABASE_PATH;
  expect(rejectPath).toBeTruthy();
  expect(dbPath).toMatch(/gather-e2e-[0-9]+-[a-f0-9]+\.sqlite$/i);

  writeFileSync(rejectPath!, 'Reject SMTP sends during the quota regression.');
  const database = new Database(dbPath!);
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Maya Chen/ }).click();
    await page.goto('/people/demo-ns-contact-1');
    await page.getByRole('navigation', { name: 'Actions for this person' }).getByRole('link', { name: 'Email', exact: true }).click();
    const composer = page.locator('.email-compose');
    await composer.getByRole('button', { name: 'Draft an email' }).click();
    await composer.getByLabel('Subject').waitFor();
    await composer.getByRole('button', { name: 'Approve email' }).click();
    await expect(composer.locator('.email-state')).toContainText('The mail server did not accept it. You can retry.', { timeout: 12_000 });

    const actor = database.prepare(`SELECT id FROM users WHERE email='maya@gather.test'`).get() as { id: string };
    const addLimit = database.prepare(`INSERT INTO email_send_limits(id,workspace_id,actor_user_id) VALUES (?, 'demo-northstar', ?)`);
    for (let index = 0; index < 19; index += 1) addLimit.run(randomUUID(), actor.id);

    await composer.getByRole('button', { name: 'Retry send' }).click();
    await expect(composer.getByRole('alert')).toContainText('Too many emails were queued. Wait an hour before sending or retrying more.');
    await expect(composer.locator('.email-state')).toContainText('did not accept');

    if (existsSync(rejectPath!)) unlinkSync(rejectPath!);
    await page.goto('/people/demo-ns-contact-1');
    await page.getByRole('navigation', { name: 'Actions for this person' }).getByRole('link', { name: 'Email', exact: true }).click();
    await composer.getByRole('button', { name: 'Draft an email' }).click();
    await composer.getByLabel('Subject').waitFor();
    await composer.getByRole('button', { name: 'Approve email' }).click();
    await expect(composer.getByRole('alert')).toContainText('Too many emails were queued. Wait an hour before sending or retrying more.');

    const pending = database.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE workspace_id='demo-northstar' AND type='email_send' AND status='queued'`).get() as { count: number };
    expect(pending.count).toBe(0);
  } finally {
    const actor = database.prepare(`SELECT id FROM users WHERE email='maya@gather.test'`).get() as { id: string } | undefined;
    if (actor) database.prepare(`DELETE FROM email_send_limits WHERE workspace_id='demo-northstar' AND actor_user_id=?`).run(actor.id);
    database.close();
    if (existsSync(rejectPath!)) unlinkSync(rejectPath!);
  }
});
