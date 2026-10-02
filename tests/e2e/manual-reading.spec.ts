import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function cardVariant(page: Page, marker: number) {
  const image = readFileSync(resolve('public/demo/sample-card.png')).toString('base64');
  const encoded = await page.evaluate(async ({ image, marker }) => {
    const source = new Image(); source.src = `data:image/png;base64,${image}`; await source.decode();
    const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext('2d')!; context.drawImage(source, 0, 0);
    context.fillStyle = `rgb(${marker * 29},${marker * 47},${marker * 61})`;
    context.fillRect(canvas.width - 12, canvas.height - 12, 7, 7);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  }, { image, marker });
  return Buffer.from(encoded, 'base64');
}

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
  const photos = await Promise.all([1, 2].map(async (marker) => ({ name: `sample-card-${marker}.png`, mimeType: 'image/png', buffer: await cardVariant(page, marker) })));
  const upload = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST', { timeout: 30_000 });
  await page.locator('#capture-gallery').setInputFiles(photos);
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

test('a failed saved photo retries the on-device reader when opened from Review', async ({ page }) => {
  test.setTimeout(120_000);
  let failuresRemaining = 2;
  let attempts = 0;
  await page.route('**/api/scans/*/ocr', async (route) => {
    attempts += 1;
    if (failuresRemaining > 0) {
      failuresRemaining -= 1;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Temporary test interruption.' }) });
      return;
    }
    await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: /^Scan/ }).first().click();
  const photos = await Promise.all([3, 4].map(async (marker) => ({ name: `sample-card-${marker}.png`, mimeType: 'image/png', buffer: await cardVariant(page, marker) })));
  await page.locator('#capture-gallery').setInputFiles(photos);
  await expect.poll(() => attempts, { timeout: 90_000 }).toBe(2);
  await expect(page.getByRole('button', { name: 'Review' }).first()).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Review' }).first().click();
  await expect(page).toHaveURL(/\/review\/[^?]+\?dialog=1$/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact', { timeout: 90_000 });
  await expect(page.getByLabel('Company')).toHaveValue('ACME PACKAGING');
  await expect(page.getByText('Nothing was guessed. Type the details you can see.')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Name *')).toBeVisible();
  await expect(page.locator('.mobile-review-actions')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a split-column card uses a second on-device layout read when the name is missed', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: /^Scan/ }).first().click();
  await page.setViewportSize({ width: 1280, height: 900 });
  const upload = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST');
  await page.locator('#capture-camera').setInputFiles({
    name: 'split-columns-card.png', mimeType: 'image/png', buffer: readFileSync(resolve('tests/fixtures/card-split-columns.png')),
  });
  expect((await upload).status()).toBe(201);
  await expect(page).toHaveURL(/\/review\/[^?]+\?dialog=1$/, { timeout: 15_000 });
  await expect(page.getByLabel('Name *')).toHaveValue('Chen Alvarez', { timeout: 90_000 });
  await expect(page.getByLabel('Company')).toHaveValue('Pioneer Dynamics LLC', { timeout: 90_000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a missing footer company is read from a focused crop and remains reviewable on phone', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: /^Scan/ }).first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  const upload = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST');
  await page.locator('#capture-camera').setInputFiles({
    name: 'footer-card.png', mimeType: 'image/png', buffer: readFileSync(resolve('tests/fixtures/card-company-footer.png')),
  });
  expect((await upload).status()).toBe(201);
  await expect(page).toHaveURL(/\/review\/[^?]+\?dialog=1$/, { timeout: 15_000 });
  await expect(page.getByLabel('Name *')).toHaveValue('Chen Reed', { timeout: 90_000 });
  await expect(page.getByLabel('Company')).toHaveValue('Silverline Products LLC', { timeout: 90_000 });
  await expect(page.getByText('Check this detail').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
