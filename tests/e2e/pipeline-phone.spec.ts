import { expect, test } from '@playwright/test';

test('on a phone the pipeline shows one stage at a time and Move to saves the new stage', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/pipeline');
  const switcher = page.getByRole('group', { name: 'Show one stage' });
  await expect(switcher.getByRole('button', { name: /^New/ })).toHaveAttribute('aria-pressed', 'true');
  const visible = page.locator('.pipeline-column.is-shown');
  await expect(visible).toHaveCount(1);
  await expect(page.locator('.pipeline-column:not(.is-shown)').first()).toBeHidden();

  const first = visible.locator('.pipeline-item').first();
  const name = (await first.locator('strong').textContent())!.trim();
  const stageOf = async () => ((await (await page.request.get('/api/contacts')).json()) as { people: Array<{ name: string; stage: string }> }).people.find((person) => person.name === name)?.stage;

  await first.getByLabel(`Move ${name} to`).selectOption('replied');
  await expect.poll(stageOf).toBe('replied');
  await switcher.getByRole('button', { name: /^Replied/ }).click();
  await expect(page.locator('.pipeline-column.is-shown .pipeline-person').filter({ hasText: name })).toBeVisible();

  // Lost still asks why; cancelling keeps the stage.
  await page.locator('.pipeline-column.is-shown .pipeline-item').filter({ hasText: name }).getByLabel(`Move ${name} to`).selectOption('lost');
  await page.getByRole('dialog', { name: `Mark ${name} as lost` }).getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(stageOf).toBe('replied');

  await page.locator('.pipeline-column.is-shown .pipeline-item').filter({ hasText: name }).getByLabel(`Move ${name} to`).selectOption('new');
  await expect.poll(stageOf).toBe('new');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
