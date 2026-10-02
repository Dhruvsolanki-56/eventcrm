import { expect, test } from '@playwright/test';

test('an attendee privately scans a card, keeps the conversation, and follows up', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Sam Patel/ }).click();
  await expect(page.getByText('Private. Only you can see this.').first()).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Pipeline' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Reports' })).toHaveCount(0);
  expect((await page.request.get('/api/reports')).status()).toBe(403);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open account menu' }).click();
  await expect(page.getByRole('button', { name: 'Ask every time' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Never ask' }).click();
  await expect(page.getByRole('button', { name: 'Never ask' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Close navigation' }).click();

  const image = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 840; canvas.height = 480;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f4f1e8'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#202020'; context.font = 'bold 44px sans-serif'; context.fillText('Supplier Contact', 65, 145);
    context.font = '30px sans-serif'; context.fillText('Private supply conversation', 65, 220);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', .9));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });
  const uploadRequest = page.waitForRequest((request) => request.url().includes('/api/scans') && request.method() === 'POST');
  await page.locator('#capture-gallery').setInputFiles({ name: 'supplier-card.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(image, 'base64') });
  await uploadRequest;
  await expect(page).toHaveURL(/\/review\/[^/]+$/);
  await page.getByLabel('Conversation note').fill('Supplier said the minimum order is 500 pieces and will send a sample.');
  await page.getByRole('button', { name: 'Save & scan next' }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();

  const privateExport = await (await page.request.get('/api/export/data.json')).json() as { data: { workspace: { kind: string }; notes: Array<{ body: string }>; contacts: Array<{ name: string }> } };
  expect(privateExport.data.workspace.kind).toBe('personal');
  expect(privateExport.data.contacts.some((person) => person.name === 'Demo Contact')).toBe(true);
  expect(privateExport.data.notes.some((note) => note.body.includes('minimum order is 500 pieces'))).toBe(true);
  await expect(page.getByRole('navigation', { name: 'Phone navigation' }).getByRole('link', { name: 'People' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Phone navigation' }).getByRole('link', { name: 'People' }).click();
  await page.getByRole('link', { name: /Demo Contact/ }).click();
  await expect(page.getByText('Supplier said the minimum order is 500 pieces and will send a sample.')).toBeVisible();
  await page.getByRole('button', { name: 'Draft an email' }).click();
  await expect(page.getByLabel('Subject')).toHaveValue(/Following up/);
  await page.getByRole('button', { name: 'Send email' }).click();
  await expect(page.locator('.email-state')).toContainText('No mail server');
  await expect(page.locator('.email-state')).not.toContainText('delivered');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors).toEqual([]);
});
