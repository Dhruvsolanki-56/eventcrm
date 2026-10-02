import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test.skip(process.env.GATHER_TEST_CARD_AI_CHOICE !== '1', 'Run this mocked-provider flow with --manual-reading so the demo fixture worker cannot race it.');

test('a new photo uses Gemini automatically at upload and still needs review', async ({ page }) => {
  let aiReads = 0;
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    const capabilities = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...capabilities, aiCardAssist: true, aiCardProvider: 'gemini' } });
  });
  await page.route('**/api/scans/*/ai-read', async (route) => {
    aiReads++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ fields: {
      name: 'Avery Chen', title: 'Buyer', company: 'Northstar Packaging', email: 'avery@example.com', phone: '', website: '', products: [], topics: [], uncertain: [],
    }, source: 'ai_suggestion', needsReview: true }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByText('Gemini reads first, automatically')).toBeVisible();
  await expect(page.getByText(/photo is sent to Google/)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Gemini/ })).toHaveCount(0);
  const source = readFileSync(resolve('public/demo/sample-card.png'));
  const variant = await page.evaluate(async (base64) => {
    const photo = new Image(); photo.src = `data:image/png;base64,${base64}`; await photo.decode();
    const canvas = document.createElement('canvas'); canvas.width = photo.width; canvas.height = photo.height;
    const context = canvas.getContext('2d')!; context.drawImage(photo, 0, 0);
    context.fillStyle = '#4a7d76'; context.fillRect(canvas.width - 8, canvas.height - 8, 5, 5);
    const blob = await new Promise<Blob>((done) => canvas.toBlob((file) => done(file!), 'image/png'));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  }, source.toString('base64'));
  await page.locator('#capture-gallery').setInputFiles({ name: 'sample-card-variant.png', mimeType: 'image/png', buffer: Buffer.from(variant, 'base64') });
  await expect(page).toHaveURL(/\/review\//);
  await expect(page.getByLabel('Name *')).toHaveValue('Avery Chen', { timeout: 15000 });
  await expect(page.getByLabel('Company')).toHaveValue('Northstar Packaging');
  await expect(page.locator('.uncertain-field')).toHaveCount(4);
  await expect(page.locator('.review-status')).toContainText('Ready to review');
  expect(aiReads).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto('/scan');
  await page.getByRole('button', { name: 'Discard Avery Chen' }).click();
});

test('on-device reading takes over when Gemini is unavailable', async ({ page }) => {
  test.setTimeout(120_000);
  let aiReads = 0;
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    const capabilities = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...capabilities, aiCardAssist: true, aiCardProvider: 'gemini' } });
  });
  await page.route('**/api/scans/*/ai-read', async (route) => {
    aiReads++;
    await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Free-tier limit reached.' }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByText('Gemini reads first, automatically')).toBeVisible();
  await page.locator('#capture-gallery').setInputFiles({
    name: 'sample-card.png', mimeType: 'image/png', buffer: readFileSync(resolve('public/demo/sample-card.png')),
  });
  await expect(page).toHaveURL(/\/review\//);
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact', { timeout: 90_000 });
  expect(aiReads).toBe(1);
});
