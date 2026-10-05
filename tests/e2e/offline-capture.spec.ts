import { expect, test } from '@playwright/test';

test('a photo taken offline is kept on the phone and uploads once when the connection returns', async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/scan');
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  // Count from the server, not the screen: the tray fills in a moment after the heading appears.
  const before = ((await (await page.request.get('/api/scans')).json()) as { scans: unknown[] }).scans.length;
  await expect(page.locator('.tray-item')).toHaveCount(before);

  const image = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 840; canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ece8dd'; ctx.fillRect(0, 0, 840, 480); ctx.fillStyle = '#fff'; ctx.fillRect(60, 60, 720, 360);
    ctx.fillStyle = '#202020'; ctx.font = 'bold 42px sans-serif'; ctx.fillText('Offline Tester', 100, 175);
    ctx.font = '28px sans-serif'; ctx.fillText('Acme Packaging', 100, 280); ctx.fillText('offline@sample.invalid', 100, 335);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', .9));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });

  await context.setOffline(true);
  await expect(page.getByText('You are offline')).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'offline.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(image, 'base64') });
  const waiting = page.locator('.tray-item.is-offline');
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toContainText('Saved on this phone');
  await expect(page).toHaveURL(/\/scan$/);
  const queued = await page.evaluate(() => new Promise<number>((resolve) => {
    const open = indexedDB.open('gather-offline', 1);
    open.onsuccess = () => { const count = open.result.transaction('photos').objectStore('photos').count(); count.onsuccess = () => { resolve(count.result); open.result.close(); }; };
    open.onerror = () => resolve(-1);
  }));
  expect(queued).toBe(1);

  await context.setOffline(false);
  await expect(page.locator('.tray-item.is-offline')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(1, { timeout: 45_000 });
  await expect(page.locator('.tray-item')).toHaveCount(before + 1);
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve) => {
    const open = indexedDB.open('gather-offline', 1);
    open.onsuccess = () => { const count = open.result.transaction('photos').objectStore('photos').count(); count.onsuccess = () => { resolve(count.result); open.result.close(); }; };
  }))).toBe(0);
  await expect(page.getByText('You are offline')).toHaveCount(0);
});
