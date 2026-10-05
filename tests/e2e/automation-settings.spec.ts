import { expect, test } from '@playwright/test';

test('the draft automation switch saves by itself and the panel explains the steps', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/settings?tab=email');
  const panel = page.locator('.draft-automation-settings');
  const saved = async () => ((await (await page.request.get('/api/settings', { headers: { 'X-Workspace-Id': 'demo-northstar' } })).json()) as { draftAutomation?: { autoDraftAfterConversation?: boolean } | null }).draftAutomation?.autoDraftAfterConversation ?? false;

  await expect(panel.getByRole('list', { name: 'How a draft reaches the person' }).getByRole('listitem')).toHaveCount(3);
  await expect(panel.getByRole('link', { name: 'Email Desk' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Save email workflow' })).toHaveCount(0);

  const choice = panel.getByRole('checkbox', { name: /Prepare a draft when a conversation is saved/ });
  const before = await saved();
  try {
    await choice.setChecked(!before);
    await expect.poll(saved).toBe(!before);
    await page.reload();
    await expect(page.locator('.draft-automation-settings').getByRole('checkbox', { name: /Prepare a draft/ })).toBeChecked({ checked: !before });
  } finally {
    const headers = { 'X-CSRF-Token': (await page.context().cookies()).find((cookie) => cookie.name === 'gather_csrf')?.value ?? '', 'X-Workspace-Id': 'demo-northstar' };
    await page.request.put('/api/settings', { headers, data: { key: 'draftAutomation', value: { autoDraftAfterConversation: before } } });
  }
});

test('the reminder time zone offers suggestions and a one-tap device zone', async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: 'Asia/Kolkata' });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/settings?tab=email');
  const zone = page.locator('.reminder-fields label').filter({ hasText: 'Time zone' });
  await expect(zone.locator('input')).toHaveAttribute('list', 'reminder-time-zones');
  expect(await page.locator('#reminder-time-zones option').count()).toBeGreaterThan(100);
  await zone.locator('input').fill('UTC');
  const useDevice = zone.getByRole('button', { name: /Use this device’s zone \(Asia\/(Kolkata|Calcutta)\)/ });
  const device = (await useDevice.textContent())!.match(/\((.+)\)/)![1];
  await useDevice.click();
  await expect(zone.locator('input')).toHaveValue(device);
  await expect(useDevice).toHaveCount(0);
  await context.close();
});
