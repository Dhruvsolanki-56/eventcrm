import { expect, test, type Page } from '@playwright/test';

// The server saves the request but the answer never reaches the browser (a dropped connection). The person sees an error and tries again.
// Trying again must not leave two copies.
async function signInAsMaya(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
}
async function loseTheAnswerOnce(page: Page, pattern: RegExp, method: string) {
  let lost = false;
  await page.route(pattern, async (route) => {
    if (!lost && route.request().method() === method) { lost = true; await route.fetch(); await route.abort('connectionreset'); return; }
    await route.continue();
  });
}

test('a conversation whose answer was lost is saved once when retried', async ({ page }) => {
  await signInAsMaya(page);
  await page.goto('/people/demo-ns-contact-6');
  const text = `Lost answer conversation ${Date.now()}`;
  await loseTheAnswerOnce(page, /\/api\/contacts\/demo-ns-contact-6\/(notes|conversations)$/, 'POST');
  await page.getByLabel('What did you discuss?').fill(text);
  await page.getByRole('button', { name: 'Add conversation' }).click();
  await expect(page.getByRole('button', { name: 'Add conversation' })).toBeEnabled();
  await page.getByRole('button', { name: 'Add conversation' }).click();
  await expect(page.getByText(text).first()).toBeVisible();
  const detail = await (await page.request.get('/api/contacts/demo-ns-contact-6', { headers: { 'X-Workspace-Id': 'demo-northstar' } })).text();
  expect(detail.split(text).length - 1, 'one saved copy of the conversation').toBe(1);
});

test('an event whose answer was lost is created once when retried', async ({ page }) => {
  await signInAsMaya(page);
  const name = `Lost Answer Expo ${Date.now()}`;
  await loseTheAnswerOnce(page, /\/api\/events$/, 'POST');
  await page.getByRole('button', { name: 'New event' }).click();
  await page.getByLabel('Event name').fill(name);
  await page.getByRole('button', { name: 'Create and use' }).click();
  await expect(page.getByRole('button', { name: 'Create and use' })).toBeEnabled();
  await page.getByRole('button', { name: 'Create and use' }).click();
  await expect(page.getByText(`${name} is ready`)).toBeVisible();
  const events = await (await page.request.get('/api/events/accessible', { headers: { 'X-Workspace-Id': 'demo-northstar' } })).json() as { events: Array<{ name: string }> };
  expect(events.events.filter((event) => event.name === name)).toHaveLength(1);
});
