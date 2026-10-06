import { expect, test } from '@playwright/test';

test('several drafts can be prepared at once and reviewed with the keyboard', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/email');
  const draftsTab = page.getByRole('button', { name: /^Drafts/ });
  await expect(draftsTab).toBeVisible();
  // Count from the server: the tab shows its number only after the page has loaded, and a slow machine can read it too early.
  const draftCount = async () => ((await (await page.request.get('/api/email-desk', { headers: { 'X-Workspace-Id': 'demo-northstar' } })).json()) as { drafts: Array<{ status: string }> }).drafts.filter((draft) => draft.status === 'draft').length;
  const before = await draftCount();

  await page.getByRole('button', { name: /^Prepare next/ }).click();
  const bar = page.locator('.bulk-bar');
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Prepare selected' })).toBeDisabled();
  const checks = page.locator('.bulk-check');
  await expect(checks.first()).toBeVisible();
  await checks.nth(0).check();
  await checks.nth(1).check();
  await expect(bar).toContainText('2 selected');
  await bar.getByRole('button', { name: 'Prepare 2 selected' }).click();

  await expect(page.getByText('2 drafts ready to review. Nothing has been sent.')).toBeVisible({ timeout: 30_000 });
  expect(await draftCount()).toBe(before + 2);
  await expect(page.getByRole('button', { name: /^Drafts/ })).toContainText(String(before + 2));
  await expect(page.locator('.email-desk-row.is-selected')).toHaveCount(1);

  // Move through the queue with J and K.
  await expect(page.locator('.kbd-hint')).toBeVisible();
  const selectedId = () => page.locator('.email-desk-row.is-selected').getAttribute('data-draft-id');
  await page.locator('.email-desk-row').first().click();
  const first = await selectedId();
  await page.keyboard.press('j');
  await expect.poll(selectedId).not.toBe(first);
  await page.keyboard.press('k');
  await expect.poll(selectedId).toBe(first);
  // Typing J in the message box must not change the draft.
  await page.locator('.email-desk-editor textarea').click();
  await page.keyboard.type('jk');
  await expect.poll(selectedId).toBe(first);
});
