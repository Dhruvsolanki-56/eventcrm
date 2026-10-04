import { expect, test } from '@playwright/test';

test('an admin can create an event from the capture screen in a few taps', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/scan');
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
  await page.getByRole('button', { name: 'New event' }).click();
  await page.getByRole('button', { name: 'Expo', exact: true }).click();
  await expect(page.getByLabel('Event name')).toHaveValue(/^Expo /);
  await page.getByLabel('Event name').fill('Harbor Trade Expo');
  await page.getByRole('button', { name: '3 days', exact: true }).click();
  await page.getByRole('button', { name: 'Create and use' }).click();
  await expect(page.getByText('Harbor Trade Expo is ready')).toBeVisible();
  // The new event is selected for the next capture and is saved as the active one.
  await expect(page.locator('#capture-event option:checked')).toContainText('Harbor Trade Expo');
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const events = await (await page.request.get('/api/events/accessible', { headers: { 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': 'demo-northstar' } })).json() as { events: Array<{ name: string; is_active: number }> };
  expect(events.events.find((item) => item.name === 'Harbor Trade Expo')?.is_active).toBe(1);
});

test('a name is required, and people who are not admins do not see the button', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/scan');
  await page.getByRole('button', { name: 'New event' }).click();
  await page.getByRole('button', { name: 'Create and use' }).click();
  await expect(page.getByRole('alert')).toContainText('Give the event a name');
  await page.request.post('/api/auth/logout', { headers: { 'X-CSRF-Token': (await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string }).csrfToken } });
  await page.goto('/');
  await page.getByRole('button', { name: /Jordan Lee/ }).click();
  await page.goto('/scan');
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New event' })).toHaveCount(0);
});

test('setup asks for the company website and keeps it, and a failed read leaves the form alone', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/setup');
  const website = page.getByLabel(/Your company website/);
  await expect(website).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read my website' })).toBeDisabled();
  await website.fill('northstarpackaging.example');
  await page.getByLabel('What does your team sell?').fill('Recyclable packaging.');
  await page.getByRole('button', { name: 'Read my website' }).click();
  // AI is off in the automated setup, so the page explains and nothing is overwritten.
  await expect(page.getByRole('alert')).toContainText(/not set up|could not/);
  await expect(page.getByLabel('What does your team sell?')).toHaveValue('Recyclable packaging.');
  // The address is kept from Settings too, where it can be changed at any time.
  await page.goto('/settings');
  await page.getByLabel(/Company website/).fill('northstarpackaging.example');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  const settings = await (await page.request.get('/api/settings')).json() as { knowledge: { website: string } };
  expect(settings.knowledge.website).toBe('northstarpackaging.example');
});
