import { expect, test } from '@playwright/test';

test('pipeline cards move between stages by drag and drop, and Lost asks for a reason', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/pipeline');
  const lane = (stage: string) => page.locator('.pipeline-column').filter({ has: page.getByRole('heading', { name: stage, exact: true }) });
  const card = (stage: string) => lane(stage).locator('.pipeline-person').first();
  await expect(card('New')).toBeVisible();
  const name = (await card('New').locator('strong').textContent())!.trim();
  const personCard = page.locator('.pipeline-person').filter({ hasText: name });
  const stageOf = async () => {
    const people = (await (await page.request.get('/api/contacts')).json() as { people: Array<{ name: string; stage: string }> }).people;
    return people.find((person) => person.name === name)?.stage;
  };

  await personCard.dragTo(lane('Contacted'));
  await expect(lane('Contacted').locator('.pipeline-person').filter({ hasText: name })).toBeVisible();
  await expect.poll(stageOf).toBe('contacted');

  // Lost needs a reason; cancelling leaves the person where they were.
  await personCard.dragTo(lane('Lost'));
  const dialog = page.getByRole('dialog', { name: `Mark ${name} as lost` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save as lost' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(stageOf).toBe('contacted');

  await personCard.dragTo(lane('New'));
  await expect.poll(stageOf).toBe('new');
});
