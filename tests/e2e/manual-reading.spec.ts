import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('without an AI key an uploaded card is honestly marked unread and can be entered manually on phone', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  const capabilities = await (await page.request.get('/api/capabilities')).json() as { cardReading: string };
  expect(capabilities.cardReading).toBe('manual');
  await page.getByRole('link', { name: /^Scan/ }).first().click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Take photo', { exact: true })).toBeVisible();
  await expect(page.locator('#capture-camera')).toHaveAttribute('capture', 'environment');
  await expect(page.locator('#capture-camera')).not.toHaveAttribute('multiple', '');
  const upload = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST');
  await page.locator('#capture-camera').setInputFiles({
    name: 'sample-card.png', mimeType: 'image/png', buffer: readFileSync(resolve('public/demo/sample-card.png')),
  });
  const response = await upload;
  expect(response.status()).toBe(201);
  expect((await response.json() as { scan: { status: string } }).scan.status).toBe('queued');
  await expect(page.getByRole('button', { name: 'Review' }).first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Review' }).first().click();

  await expect(page.getByText('We couldn’t read this photo.')).toBeVisible();
  await expect(page.getByText('Nothing was guessed. Type the details you can see.')).toBeVisible();
  await expect(page.getByLabel('Name *')).toHaveValue('');
  await expect(page.getByLabel('Company')).toHaveValue('');
  await expect(page.getByLabel('Email')).toHaveValue('');
  await expect(page.getByText('Demo reading')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByLabel('Name *').fill('Manual Sample Lead');
  await page.getByLabel('Company').fill('Manual Sample Company');
  await page.getByLabel('Email').fill(`manual-${Date.now()}@example.test`);
  await page.getByRole('button', { name: 'Save & scan next' }).click();
  await expect(page).toHaveURL(/\/scan$/);
  await expect(page.getByText('Saved. Ready for the next card.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
