import { expect, test } from '@playwright/test';

test('a card that cannot be read explains why and offers read again, retake, or typing it', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: /^Scan/ }).first().click();
  const blank = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 520;
    const context = canvas.getContext('2d')!; context.fillStyle = '#f4f4f0'; context.fillRect(0, 0, 900, 520);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });
  await page.locator('#capture-camera').setInputFiles({ name: 'blank.png', mimeType: 'image/png', buffer: Buffer.from(blank, 'base64') });
  await expect(page).toHaveURL(/\/review\/[^?]+\?dialog=1$/, { timeout: 15_000 });

  const notice = page.locator('.read-failure');
  await expect(notice).toBeVisible({ timeout: 90_000 });
  await expect(notice.getByText('We couldn’t read this card')).toBeVisible();
  await expect(notice.getByText(/Very little text could be found/)).toBeVisible();
  await expect(page.locator('.review-error')).toHaveCount(0); // one calm notice, not a second red strip
  await expect(page.locator('.manual-entry-note')).toHaveCount(0);
  await page.screenshot({ path: process.env.READ_FAILURE_SHOT ?? 'test-results/read-failure.png' });

  await notice.getByRole('button', { name: 'Read again' }).click();
  await expect(notice).toBeVisible({ timeout: 90_000 }); // reads again, and still cannot, so the notice returns

  await notice.getByRole('button', { name: 'Type it myself' }).click();
  await expect(page.getByLabel('Name *')).toBeFocused();

  await notice.getByRole('button', { name: 'Retake photo' }).click();
  await expect(page).toHaveURL(/\/scan$/);
});
