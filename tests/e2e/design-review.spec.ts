import { expect, test } from '@playwright/test';

test('light workspace renders without horizontal overflow on core routes', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const [name, route] of [
      ['home', '/home'],
      ['capture', '/scan'],
      ['email', '/email'],
      ['people', '/people'],
      ['person', '/people/demo-ns-contact-1'],
      ['companies', '/companies'],
      ['company', '/companies/demo-ns-acme'],
      ['follow-ups', '/follow-ups'],
      ['pipeline', '/pipeline'],
      ['reports', '/reports'],
      ['analytics', '/analytics'],
      ['settings', '/settings'],
      ['setup', '/setup'],
    ] as const) {
      await page.goto(route);
      await expect(page.locator('main h1').first()).toBeVisible();
      await expect(page.getByText('Loading your settings…', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Loading activity…', { exact: true })).toHaveCount(0);
      if (name === 'settings') await expect(page.locator('.settings-form')).toBeVisible();
      await expect(page.locator('main').getByText(/^Loading /)).toHaveCount(0);
      // Let chart animations and asynchronous section layouts settle before the visual record.
      await page.waitForTimeout(1200);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`), fullPage: true });
      if (name === 'person') {
        for (const action of ['Email', 'Voice note', 'Follow-up', 'Meeting', 'Deals', 'More', 'Conversation']) {
          await page.getByRole('navigation', { name: 'Actions for this person' }).getByRole('link', { name: action, exact: true }).click();
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`person-${action.toLowerCase().replaceAll(' ', '-')}-${width}.png`), fullPage: true });
        }
      }
      if (name === 'settings') {
        for (const section of ['Email & reminders', 'Events & team', 'Data & activity', 'Business profile']) {
          await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: new RegExp(section) }).click();
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`settings-${section.split(' ')[0].toLowerCase()}-${width}.png`), fullPage: true });
        }
      }
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

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/home');
  await page.locator('.profile-button').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Good to see you.' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sign-in-1440.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('sign-in-390.png') });
});
