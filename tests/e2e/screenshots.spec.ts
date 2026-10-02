import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('refresh documented desktop and phone capture screenshots', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: /Good morning, Maya/ })).toBeVisible();
  await expect(page.locator('.overview-insights')).toBeVisible();
  await expect(page.locator('.overview-activity .recharts-surface')).toBeVisible();
  await page.screenshot({ path: resolve('docs/screenshots/home-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve('docs/screenshots/home-phone.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 960 });

  await page.getByRole('link', { name: /^Scan/ }).first().click();
  await expect(page.getByRole('heading', { name: /Keep the next conversation/ })).toBeVisible();
  await page.screenshot({ path: resolve('docs/screenshots/capture-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.phone-scan')).toBeHidden();
  await expect(page.locator('.phone-tabs').getByRole('link', { name: 'Scan' })).toBeVisible();
  await expect(page.getByText('Choose photos')).toBeVisible();
  await page.screenshot({ path: resolve('docs/screenshots/capture-phone.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 960 });

  const image = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 840; canvas.height = 480;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f4f1e8'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#202020'; context.font = 'bold 44px sans-serif'; context.fillText('Demo Contact', 65, 145);
    context.font = '30px sans-serif'; context.fillText('Packaging Buyer', 65, 220);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', .9));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });
  await page.locator('#capture-gallery').setInputFiles({ name: 'screenshot-card.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(image, 'base64') });
  await expect(page).toHaveURL(/\/review\/[^/]+$/);
  await page.getByLabel('Name *').fill('Demo Contact');
  await page.screenshot({ path: resolve('docs/screenshots/review-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.phone-scan')).toBeHidden();
  await page.screenshot({ path: resolve('docs/screenshots/review-phone.png'), animations: 'disabled' });
});
