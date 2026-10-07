import { expect, test, type Page } from '@playwright/test';

async function headers(page: Page) {
  const { csrfToken } = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  return { 'X-CSRF-Token': csrfToken, 'X-Workspace-Id': 'demo-northstar' };
}
type Deal = { id: string; title: string; stage: string; contact_id: string };
const dealsOf = async (page: Page, contactId: string) => (await (await page.request.get(`/api/deals?contactId=${contactId}&pageSize=50`)).json() as { deals: Deal[] }).deals;

test('pipeline cards are deals: dragging one moves only that deal, and Lost asks for a reason', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  // Leah Kim already has a deal; give her a second one so there are two cards for the same person.
  const title = `Drag test ${Date.now()}`;
  const created = await page.request.post('/api/deals', { headers: await headers(page), data: { contactId: 'demo-ns-contact-26', title, valueMinor: 250000, encounterId: null } });
  expect(created.status(), await created.text()).toBe(201);
  const before = await dealsOf(page, 'demo-ns-contact-26');
  expect(before).toHaveLength(2);
  const other = before.find((deal) => deal.title !== title)!;

  await page.goto('/pipeline');
  await expect(page.getByRole('note').filter({ hasText: 'Each card is one deal' })).toBeVisible();
  const lane = (stage: string) => page.locator('.pipeline-column').filter({ has: page.getByRole('heading', { name: stage, exact: true }) });
  const card = page.locator('.pipeline-person').filter({ hasText: title });
  const stageOf = async () => (await dealsOf(page, 'demo-ns-contact-26')).find((deal) => deal.title === title)?.stage;
  await expect(lane('New').locator('.pipeline-person').filter({ hasText: title })).toBeVisible();

  await card.dragTo(lane('Contacted'));
  await expect(lane('Contacted').locator('.pipeline-person').filter({ hasText: title })).toBeVisible();
  await expect.poll(stageOf).toBe('contacted');
  // The same person's other deal did not move with it.
  expect((await dealsOf(page, 'demo-ns-contact-26')).find((deal) => deal.id === other.id)?.stage).toBe(other.stage);
  await expect(page.locator('.pipeline-column').filter({ has: page.getByRole('heading', { name: other.stage.charAt(0).toUpperCase() + other.stage.slice(1), exact: true }) }).locator('.pipeline-person').filter({ hasText: 'Leah Kim' })).not.toHaveCount(0);

  // Lost needs a reason; cancelling leaves the deal where it was.
  await card.dragTo(lane('Lost'));
  const dialog = page.getByRole('dialog', { name: `Mark ${title} as lost` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save as lost' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(stageOf).toBe('contacted');

  await card.dragTo(lane('Lost'));
  await page.getByRole('dialog', { name: `Mark ${title} as lost` }).getByLabel('Why was this lost?').fill('Budget moved to next year');
  await page.getByRole('dialog', { name: `Mark ${title} as lost` }).getByRole('button', { name: 'Save as lost' }).click();
  await expect.poll(stageOf).toBe('lost');
  expect((await dealsOf(page, 'demo-ns-contact-26')).find((deal) => deal.id === other.id)?.stage).toBe(other.stage);

  await card.dragTo(lane('New'));
  await expect.poll(stageOf).toBe('new');
});
