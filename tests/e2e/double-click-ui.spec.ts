import { expect, test, type Page } from '@playwright/test';

// Real double clicks on the real buttons. The server also protects against repeats (see double-submit.spec.ts);
// this checks what a person actually experiences.
async function signInAsMaya(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
}
async function eventsNamed(page: Page, name: string) {
  const events = await (await page.request.get('/api/events/accessible', { headers: { 'X-Workspace-Id': 'demo-northstar' } })).json() as { events: Array<{ name: string }> };
  return events.events.filter((event) => event.name === name).length;
}

test('double-clicking Create and use on the capture screen makes one event', async ({ page }) => {
  await signInAsMaya(page);
  const name = `Quick Double ${Date.now()}`;
  await page.getByRole('button', { name: 'New event' }).click();
  await page.getByLabel('Event name').fill(name);
  await page.getByRole('button', { name: 'Create and use' }).dblclick();
  await expect(page.getByText(`${name} is ready`)).toBeVisible();
  expect(await eventsNamed(page, name)).toBe(1);
});

test('double-clicking Add event on the Events page makes one event', async ({ page }) => {
  await signInAsMaya(page);
  await page.goto('/events');
  await page.getByRole('button', { name: 'Add event' }).first().click();
  const name = `Events Page Double ${Date.now()}`;
  await page.getByLabel('Event name').fill(name);
  await page.getByLabel('Starts').fill('2027-06-10');
  await page.getByLabel('Ends').fill('2027-06-12');
  await page.getByRole('button', { name: 'Add event' }).last().dblclick();
  await expect(page.getByText(name).first()).toBeVisible();
  expect(await eventsNamed(page, name)).toBe(1);
});

test('double-clicking Add conversation saves the conversation once', async ({ page }) => {
  await signInAsMaya(page);
  await page.goto('/people/demo-ns-contact-4');
  const text = `Double click conversation ${Date.now()}`;
  await page.getByLabel('What did you discuss?').fill(text);
  await page.getByRole('button', { name: 'Add conversation' }).dblclick();
  await expect(page.getByText(text).first()).toBeVisible();
  const detail = await (await page.request.get('/api/contacts/demo-ns-contact-4', { headers: { 'X-Workspace-Id': 'demo-northstar' } })).json() as { timeline: Array<{ body?: string; text?: string; note?: string }> };
  expect(JSON.stringify(detail.timeline).split(text).length - 1).toBe(1);
});

test('double-clicking Prepare draft in Email Desk leaves one draft for that person', async ({ page }) => {
  await signInAsMaya(page);
  await page.goto('/email');
  await page.getByRole('button', { name: /^(People|Prepare next)/ }).first().click();
  const row = page.locator('.email-desk-row').filter({ has: page.getByRole('button', { name: 'Prepare draft' }) }).first();
  const person = (await row.locator('strong').first().textContent())!.trim();
  await row.getByRole('button', { name: 'Prepare draft' }).dblclick();
  await expect(page.getByLabel('Subject')).toBeVisible();
  const desk = await (await page.request.get('/api/email-desk', { headers: { 'X-Workspace-Id': 'demo-northstar' } })).json() as { drafts: Array<{ person_name: string; status: string }> };
  expect(desk.drafts.filter((draft) => draft.person_name === person && draft.status === 'draft')).toHaveLength(1);
});
