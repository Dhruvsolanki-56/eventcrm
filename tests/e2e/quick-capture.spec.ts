import { expect, test } from '@playwright/test';

test('conversation and follow-up can be filled with taps instead of typing', async ({ page }) => {
  test.skip(process.env.E2E_BROWSER === 'webkit', 'Not verified in Safari: the voice button only appears when the browser can record, and the Playwright WebKit build may not. Check it on a real iPhone.');
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/people/demo-ns-contact-1?newConversation=1');
  const note = page.getByLabel('What did you discuss?');
  await expect(note).toBeVisible();

  const samples = page.getByRole('button', { name: 'Wants samples', exact: true });
  await samples.click();
  await expect(note).toHaveValue('Asked for samples.');
  await expect(samples).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Wants a quote', exact: true }).click();
  await expect(note).toHaveValue('Asked for samples. Asked for a quote.');
  await samples.click();
  await expect(note).toHaveValue('Asked for a quote.');
  await expect(page.getByRole('button', { name: 'Add & prepare email' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Speak instead of typing' })).toBeVisible();

  await page.getByRole('link', { name: 'Follow-up', exact: true }).click();
  const nextWeek = page.getByRole('button', { name: 'Next week', exact: true });
  await nextWeek.click();
  await expect(nextWeek).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Tomorrow', exact: true }).click();
  await expect(nextWeek).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Share samples', exact: true }).click();
  await expect(page.getByLabel('Note (optional)')).toHaveValue('Share samples');
  await page.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(page.getByLabel('Note (optional)')).toHaveValue('Check in');
});

test('card review shows which details were found and which need a look', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/scan');
  const image = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 840; canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ece8dd'; ctx.fillRect(0, 0, 840, 480); ctx.fillStyle = '#fff'; ctx.fillRect(60, 60, 720, 360);
    ctx.fillStyle = '#202020'; ctx.font = 'bold 42px sans-serif'; ctx.fillText('Quick Tester', 100, 175);
    ctx.font = '28px sans-serif'; ctx.fillText('Acme Packaging', 100, 280); ctx.fillText('quick@sample.invalid', 100, 335);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', .9));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'quick.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(image, 'base64') });
  await expect(page).toHaveURL(/\/review\//, { timeout: 20_000 });
  const glance = page.locator('.review-glance');
  await expect(glance).toBeVisible({ timeout: 30_000 });
  await expect(glance).toContainText(/details were found|Everything was found/);
  await expect(page.locator('.review-form label.field-found, .review-form label.field-look').first()).toBeVisible();
});

test('settings chips fill the profile and the follow-up date is remembered', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/settings');
  await expect(page.locator('.settings-form')).toBeVisible();
  await page.getByRole('button', { name: 'We are their supplier', exact: true }).click();
  await expect(page.getByLabel('Our role in client conversations')).toHaveValue('We are their supplier');
  await page.getByLabel('Never promise').fill('');
  await page.getByRole('button', { name: 'Prices', exact: true }).click();
  await page.getByRole('button', { name: 'Delivery dates', exact: true }).click();
  await page.getByRole('button', { name: 'Prices', exact: true }).click();
  await expect(page.getByLabel('Never promise')).toHaveValue(/Prices, Delivery dates$/);

  await page.goto('/people/demo-ns-contact-1');
  await page.getByRole('link', { name: 'Follow-up', exact: true }).click();
  await page.getByRole('button', { name: 'In 3 days', exact: true }).click();
  await page.reload();
  await page.getByRole('link', { name: 'Follow-up', exact: true }).click();
  await expect(page.getByRole('button', { name: 'In 3 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a company description can be written, saved and kept', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/people/demo-ns-contact-1');
  const box = page.getByLabel(/Short description of/);
  await expect(box).toBeVisible();
  await box.fill('Makes retail packaging for beauty brands.');
  await page.getByRole('button', { name: 'Save description' }).click();
  await expect(page.getByText('Company description saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/Short description of/)).toHaveValue('Makes retail packaging for beauty brands.');
  // With AI off in the test setup, asking for a suggestion explains itself and keeps the text.
  await page.getByRole('button', { name: /Suggest from website|Try from their email/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /not set up|could not|cannot|unreachable|reached/ })).toBeVisible();
  await expect(page.getByLabel(/Short description of/)).toHaveValue('Makes retail packaging for beauty brands.');
});
