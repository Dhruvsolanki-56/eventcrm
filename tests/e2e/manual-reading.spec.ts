import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('a single uploaded card opens its read-and-check dialog and extracts visible contact details on phone', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  const capabilities = await (await page.request.get('/api/capabilities')).json() as { cardReading: string };
  expect(capabilities.cardReading).toBe('browser');
  await page.getByRole('link', { name: /^Scan/ }).first().click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Take photo', { exact: true })).toBeVisible();
  await expect(page.locator('#capture-camera')).toHaveAttribute('capture', 'environment');
  await expect(page.locator('#capture-camera')).not.toHaveAttribute('multiple', '');
  const upload = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST');
  await page.locator('#capture-camera').setInputFiles({
    name: 'sample-card.png', mimeType: 'image/png', buffer: readFileSync(resolve('public/demo/sample-card.png')),
  });
  expect((await upload).status()).toBe(201);
  await expect(page).toHaveURL(/\/review\/[^?]+\?dialog=1$/, { timeout: 15_000 });
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Reading your card on this device…')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact', { timeout: 90_000 });
  await expect(page.getByLabel('Job title')).toHaveValue('Packaging Buyer');
  await expect(page.getByLabel('Company')).toHaveValue('ACME PACKAGING');
  await expect(page.getByLabel('Email')).toHaveValue('demo.contact@sample.invalid');
  await expect(page.getByLabel('Website')).toHaveValue('acme.co');
  await expect(page.getByText('Check this detail').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByText('Nothing was guessed. Type the details you can see.')).toHaveCount(0);

  await page.getByRole('button', { name: 'Save & scan next' }).click();
  await expect(page).toHaveURL(/\/scan$/);
  await expect(page.getByText('Saved. Ready for the next card.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('bulk photos are OCR-read but remain in the tray for one-by-one review', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: /^Scan/ }).first().click();
  await page.setViewportSize({ width: 1280, height: 900 });
  const photo = { name: 'sample-card.png', mimeType: 'image/png', buffer: readFileSync(resolve('public/demo/sample-card.png')) };
  const upload = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST', { timeout: 30_000 });
  await page.locator('#capture-gallery').setInputFiles([photo, photo]);
  await upload;
  await expect(page.getByRole('button', { name: 'Review' }).first()).toBeVisible({ timeout: 90_000 });
  await expect(page).toHaveURL(/\/scan$/);
  await page.getByRole('button', { name: 'Review' }).first().click();
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Back to cards' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to cards' }).click();
  await expect(page.getByRole('button', { name: 'Review' }).first()).toBeVisible();
});
