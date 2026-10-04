import { expect, test } from '@playwright/test';

test('person tools preserve unsaved input when switching focused panels', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/people/demo-ns-contact-1');
  await page.getByLabel('What did you discuss?').fill('Keep this unsaved conversation while checking the record.');
  const tools = page.getByRole('navigation', { name: 'Actions for this person' });
  await tools.getByRole('link', { name: 'Meeting', exact: true }).click();
  await expect(page.getByLabel('Meeting time')).toBeVisible();
  await expect(page.getByLabel('What did you discuss?')).not.toBeVisible();
  await tools.getByRole('link', { name: 'Conversation', exact: true }).click();
  await expect(page.getByLabel('What did you discuss?')).toHaveValue('Keep this unsaved conversation while checking the record.');
  await tools.getByRole('link', { name: 'Manage', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Archive person' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete person' })).toBeDisabled();
});

test('phone email queue focuses one draft and protects unsaved edits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/email');
  const draft = page.locator('button.email-desk-row').first();
  await expect(draft).toBeVisible();
  await expect(page.locator('.email-desk-preview')).not.toBeVisible();
  await draft.click();
  await expect(page.getByLabel('Subject', { exact: true })).toBeVisible();
  await expect(page.locator('.email-desk-list')).not.toBeVisible();
  await page.getByLabel('Subject', { exact: true }).fill('Unsaved mobile edit');
  await page.getByRole('button', { name: /Back to queue/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('Unsaved mobile edit');
  await page.getByRole('button', { name: /Back to queue/ }).click();
  await page.locator('[data-confirm-accept]').click();
  await expect(draft).toBeVisible();
  await expect(page.locator('.email-desk-preview')).not.toBeVisible();
});
