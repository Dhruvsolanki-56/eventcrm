import { expect, test } from '@playwright/test';

test('on a phone the pipeline shows one stage at a time and Move to saves the new stage of that one deal', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const title = `Phone deal ${Date.now()}`;
  const created = await page.request.post('/api/deals', { headers: { 'X-CSRF-Token': csrfToken, 'X-Workspace-Id': 'demo-northstar' }, data: { contactId: 'demo-ns-contact-5', title, valueMinor: null, encounterId: null } });
  expect(created.status(), await created.text()).toBe(201);
  const dealsOfAri = async () => (await (await page.request.get('/api/deals?contactId=demo-ns-contact-5&pageSize=50')).json() as { deals: Array<{ title: string; stage: string }> }).deals;
  const stageOf = async () => (await dealsOfAri()).find((deal) => deal.title === title)?.stage;
  const othersBefore = (await dealsOfAri()).filter((deal) => deal.title !== title).map((deal) => `${deal.title}:${deal.stage}`).sort();

  await page.goto('/pipeline');
  const switcher = page.getByRole('group', { name: 'Show one stage' });
  await expect(switcher.getByRole('button', { name: /^New/ })).toHaveAttribute('aria-pressed', 'true');
  const visible = page.locator('.pipeline-column.is-shown');
  await expect(visible).toHaveCount(1);
  await expect(page.locator('.pipeline-column:not(.is-shown)').first()).toBeHidden();

  const item = (stage: string) => page.locator(`.pipeline-column.is-shown .pipeline-item`).filter({ hasText: title }).filter({ has: page.getByLabel(`Move ${title} to`) }).first();
  await expect(item('new')).toBeVisible();
  await item('new').getByLabel(`Move ${title} to`).selectOption('replied');
  await expect.poll(stageOf).toBe('replied');
  await switcher.getByRole('button', { name: /^Replied/ }).click();
  await expect(page.locator('.pipeline-column.is-shown .pipeline-person').filter({ hasText: title })).toBeVisible();

  // Lost still asks why; cancelling keeps the stage.
  await item('replied').getByLabel(`Move ${title} to`).selectOption('lost');
  await page.getByRole('dialog', { name: `Mark ${title} as lost` }).getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(stageOf).toBe('replied');

  await item('replied').getByLabel(`Move ${title} to`).selectOption('new');
  await expect.poll(stageOf).toBe('new');
  // The person's other deals stayed where they were.
  expect((await dealsOfAri()).filter((deal) => deal.title !== title).map((deal) => `${deal.title}:${deal.stage}`).sort()).toEqual(othersBefore);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
