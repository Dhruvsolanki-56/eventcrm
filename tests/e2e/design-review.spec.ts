import { expect, test } from '@playwright/test';

test('light workspace renders without horizontal overflow on core routes', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const [name, route] of [
      ['home', '/home'],
      ['capture', '/scan'],
      ['people', '/people'],
      ['person', '/people/demo-ns-contact-1'],
      ['companies', '/companies'],
      ['company', '/companies/demo-ns-acme'],
      ['follow-ups', '/follow-ups'],
      ['analytics', '/analytics'],
      ['settings', '/settings'],
    ] as const) {
      await page.goto(route);
      await expect(page.locator('.page-heading-row h1').first()).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`), fullPage: true });
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/scan');
  const image = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 800; canvas.height = 450;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#eee9df'; context.fillRect(0, 0, 800, 450);
    context.fillStyle = '#20362b'; context.font = 'bold 42px sans-serif'; context.fillText('Demo Contact', 50, 150);
    context.font = '28px sans-serif'; context.fillText('Packaging Buyer', 50, 205);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', .9));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });
  await page.locator('#capture-gallery').setInputFiles({ name: 'design-review-card.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(image, 'base64') });
  await expect(page).toHaveURL(/\/review\//);
  await expect(page.locator('.review-form')).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`review-${width}.png`), fullPage: true });
    await page.locator('.review-dialog-page').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: testInfo.outputPath(`review-actions-${width}.png`) });
    await page.locator('.review-dialog-page').evaluate((element) => { element.scrollTop = 0; });
  }
});
