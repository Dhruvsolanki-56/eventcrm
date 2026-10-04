import { expect, test } from '@playwright/test';

test('an existing attendee accepts a company invite and keeps both workspaces', async ({ page }) => {
  const duplicateKeyWarnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /same key/i.test(message.text())) duplicateKeyWarnings.push(message.text());
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Events & team/ }).click();
  await page.locator('.team-event-choice input').first().check();
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const inviteInput = page.getByLabel(/Share this link/);
  await expect(inviteInput).toBeVisible();
  const inviteUrl = await inviteInput.inputValue();

  await page.locator('.profile-button').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.goto(inviteUrl);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill('sam@gather.test');
  await page.getByLabel('Password').fill(process.env.DEMO_PASSWORD ?? 'Gather-Demo-2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();

  await page.locator('.profile-button').click();
  const privateSpace = page.getByRole('menuitem', { name: /Sam's private space/ });
  const companySpace = page.getByRole('menuitem', { name: /Northstar Packaging.*representative/ });
  await expect(privateSpace).toBeVisible();
  await expect(companySpace).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Reports' })).toHaveCount(0);
  expect((await page.request.get('/api/reports', { headers: { 'X-Workspace-Id': 'demo-northstar' } })).status()).toBe(403);

  await privateSpace.click();
  await expect(page.locator('.topbar-mode')).toContainText("Sam's private space");
  await expect(page.locator('.mode-strip')).toContainText('Only you can see this');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Good morning, Sam.' })).toBeVisible();
  await page.locator('.profile-button').click();
  await page.getByRole('menuitem', { name: /Northstar Packaging.*representative/ }).click();
  await expect(page.locator('.topbar-mode')).toContainText('Northstar Packaging');
  await expect(page.locator('.mode-strip')).toContainText('Company: Northstar Packaging');
  expect(duplicateKeyWarnings).toEqual([]);
});
