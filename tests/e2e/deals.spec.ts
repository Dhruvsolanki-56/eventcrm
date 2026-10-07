import { expect, request as pwRequest, test } from '@playwright/test';

// These talk to the API directly, so nothing the screen would normally prevent is prevented here.
const api = () => `http://127.0.0.1:${process.env.E2E_API_PORT}`;
async function signIn(accountId: string, workspaceId: string) {
  const ctx = await pwRequest.newContext({ baseURL: api() });
  const first = await (await ctx.get('/api/auth/csrf')).json() as { csrfToken: string };
  const login = await ctx.post('/api/dev/login-as', { headers: { 'X-CSRF-Token': first.csrfToken }, data: { accountId, workspaceId } });
  expect(login.status(), await login.text()).toBe(200);
  const { csrfToken } = await login.json() as { csrfToken: string };
  const send = (method: string, path: string, data?: unknown) => ctx.fetch(path, { method, headers: { 'X-CSRF-Token': csrfToken, 'X-Workspace-Id': workspaceId, ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { data } : {}) });
  return { ctx, send };
}
type Deal = { id: string; title: string; value_minor: number | null; stage: string; version: number; encounter_id: string | null; contact_id: string; event_name: string | null };
const list = async (who: Awaited<ReturnType<typeof signIn>>, query: string) => (await (await who.send('GET', `/api/deals?${query}`)).json() as { deals: Deal[]; stages: Record<string, { count: number; value: number }>; total: number });

test('one person can have several deals, each with its own value, stage and optional conversation', async () => {
  const maya = await signIn('demo-owner', 'demo-northstar');
  const person = 'demo-ns-contact-2';
  const conversations = await (await maya.send('GET', `/api/contacts/${person}/conversations`)).json() as { conversations: Array<{ id: string }> };
  expect(conversations.conversations.length).toBeGreaterThan(0);
  const linked = conversations.conversations[0]!.id;
  const stamp = Date.now();

  const one = await maya.send('POST', '/api/deals', { contactId: person, title: `Mailers ${stamp}`, valueMinor: 150000, encounterId: linked });
  const two = await maya.send('POST', '/api/deals', { contactId: person, title: `Cartons ${stamp}`, valueMinor: 90000, encounterId: null });
  expect(one.status(), await one.text()).toBe(201);
  expect(two.status(), await two.text()).toBe(201);
  const oneId = (await one.json() as { id: string }).id;
  const twoId = (await two.json() as { id: string }).id;

  const deals = (await list(maya, `contactId=${person}&pageSize=50`)).deals;
  const first = deals.find((deal) => deal.id === oneId)!, second = deals.find((deal) => deal.id === twoId)!;
  expect(first).toMatchObject({ value_minor: 150000, encounter_id: linked, stage: 'new' });
  expect(second).toMatchObject({ value_minor: 90000, encounter_id: null, stage: 'new' });

  // Moving one deal leaves the other, and everything else about the person, alone.
  const moved = await maya.send('PATCH', `/api/deals/${oneId}/stage`, { stage: 'meeting', version: first.version });
  expect(moved.status(), await moved.text()).toBe(200);
  const after = (await list(maya, `contactId=${person}&pageSize=50`)).deals;
  expect(after.find((deal) => deal.id === oneId)?.stage).toBe('meeting');
  expect(after.find((deal) => deal.id === twoId)).toMatchObject({ stage: 'new', value_minor: 90000 });

  // Winning one deal does not close the person while another is open.
  const won = await maya.send('PATCH', `/api/deals/${oneId}/stage`, { stage: 'won', version: first.version + 1 });
  expect(won.status()).toBe(200);
  const personNow = await (await maya.send('GET', `/api/contacts/${person}`)).json() as { person: { stage: string }; deals: Deal[] };
  expect(['new', 'contacted', 'replied', 'meeting']).toContain(personNow.person.stage);
  expect(personNow.deals.map((deal) => deal.id)).toEqual(expect.arrayContaining([oneId, twoId]));

  // The value and the link can be changed later; the link can be removed.
  const edit = await maya.send('PATCH', `/api/deals/${twoId}`, { version: second.version, valueMinor: 120000, encounterId: linked });
  expect(edit.status(), await edit.text()).toBe(200);
  expect((await list(maya, `contactId=${person}&pageSize=50`)).deals.find((deal) => deal.id === twoId)).toMatchObject({ value_minor: 120000, encounter_id: linked });
  const unlink = await maya.send('PATCH', `/api/deals/${twoId}`, { version: second.version + 1, encounterId: null });
  expect(unlink.status()).toBe(200);
  expect((await list(maya, `contactId=${person}&pageSize=50`)).deals.find((deal) => deal.id === twoId)?.encounter_id).toBeNull();

  // Stage totals add up what the deals add up to.
  const summary = await list(maya, 'pageSize=1');
  expect(summary.stages.won.value).toBeGreaterThanOrEqual(150000);
  await maya.ctx.dispose();
});

test('a deal request sent twice makes one deal, and a stale edit is refused', async () => {
  const maya = await signIn('demo-owner', 'demo-northstar');
  const clientDealId = crypto.randomUUID();
  const body = { contactId: 'demo-ns-contact-4', title: `Twice ${Date.now()}`, valueMinor: 1000, encounterId: null, clientDealId };
  const [a, b] = await Promise.all([maya.send('POST', '/api/deals', body), maya.send('POST', '/api/deals', body)]);
  expect([a.status(), b.status()].sort()).toEqual([200, 201]);
  const matching = (await list(maya, `contactId=demo-ns-contact-4&pageSize=50`)).deals.filter((deal) => deal.id === clientDealId);
  expect(matching).toHaveLength(1);
  const again = await maya.send('POST', '/api/deals', { ...body, contactId: 'demo-ns-contact-1' });
  expect(again.status()).toBe(409);

  const stale = await maya.send('PATCH', `/api/deals/${clientDealId}/stage`, { stage: 'contacted', version: 999 });
  expect(stale.status()).toBe(409);
  expect((await stale.json() as { code: string }).code).toBe('record_changed');
  await maya.ctx.dispose();
});

test('bad deal values and names are refused with a clear answer', async () => {
  const maya = await signIn('demo-owner', 'demo-northstar');
  for (const valueMinor of [-1, 1.5, 9e15, '100']) {
    const res = await maya.send('POST', '/api/deals', { contactId: 'demo-ns-contact-4', title: 'bad value', valueMinor, encounterId: null });
    expect(res.status(), `value ${String(valueMinor)}`).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('invalid_deal');
  }
  const tooLong = await maya.send('POST', '/api/deals', { contactId: 'demo-ns-contact-4', title: 'x'.repeat(121), valueMinor: null, encounterId: null });
  expect(tooLong.status()).toBe(400);
  const extra = await maya.send('POST', '/api/deals', { contactId: 'demo-ns-contact-4', title: 'ok', valueMinor: null, encounterId: null, stage: 'won' });
  expect(extra.status()).toBe(400);
  const lostNoReason = await maya.send('PATCH', '/api/deals/deal-demo-ns-contact-4/stage', { stage: 'lost', version: 1 });
  expect(lostNoReason.status()).toBe(400);
  const someoneElses = await maya.send('POST', '/api/deals', { contactId: 'demo-ns-contact-4', title: 'wrong conversation', valueMinor: null, encounterId: 'demo-encounter-1' });
  expect(someoneElses.status()).toBe(409);
  await maya.ctx.dispose();
});

test('a representative can name, link and move deals of their people but cannot put a value on one', async () => {
  const jordan = await signIn('demo-rep', 'demo-northstar');
  const own = (await list(jordan, 'pageSize=50')).deals.find((deal) => deal.contact_id === 'demo-ns-contact-3')!;
  expect(own, 'Jordan sees the deals of people they own').toBeTruthy();
  const noValue = await jordan.send('POST', '/api/deals', { contactId: 'demo-ns-contact-3', title: `Rep deal ${Date.now()}`, valueMinor: null, encounterId: null });
  expect(noValue.status(), await noValue.text()).toBe(201);
  const withValue = await jordan.send('POST', '/api/deals', { contactId: 'demo-ns-contact-3', title: 'Rep deal with value', valueMinor: 5000, encounterId: null });
  expect(withValue.status()).toBe(403);
  const changeValue = await jordan.send('PATCH', `/api/deals/${own.id}`, { version: own.version, valueMinor: 1 });
  expect(changeValue.status()).toBe(403);
  const retitle = await jordan.send('PATCH', `/api/deals/${own.id}`, { version: own.version, title: 'Renamed by rep' });
  expect(retitle.status(), await retitle.text()).toBe(200);
  // A person owned by someone else, at an event Jordan is not on, is out of reach.
  const outside = await jordan.send('POST', '/api/deals', { contactId: 'demo-rb-contact-1', title: 'cross-workspace', valueMinor: null, encounterId: null });
  expect([403, 404, 409]).toContain(outside.status());
  await jordan.ctx.dispose();
});

test('another company cannot read or change these deals', async () => {
  const alex = await signIn('demo-other-company', 'demo-riverbend');
  const mine = await list(alex, 'pageSize=200');
  expect(mine.deals.some((deal) => deal.contact_id === 'demo-ns-contact-1')).toBe(false);
  const probe = await alex.send('PATCH', '/api/deals/deal-demo-ns-contact-1/stage', { stage: 'won', version: 1 });
  expect([403, 409]).toContain(probe.status());
  const remove = await alex.send('DELETE', '/api/deals/deal-demo-ns-contact-1');
  expect([403, 404]).toContain(remove.status());
  await alex.ctx.dispose();
});

test('the person page lists deals, adds one with a linked conversation, and moves only that deal', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  await page.goto('/people/demo-ns-contact-1');
  await page.getByRole('link', { name: 'Deals', exact: true }).click();
  const panel = page.locator('#person-deals');
  await expect(panel).toBeInViewport();
  await expect(panel.locator('.deal-row-main strong', { hasText: 'Flexible cartons pilot' })).toBeVisible();
  await expect(panel.locator('.deal-row-main strong', { hasText: 'Recycled mailers rollout' })).toBeVisible();

  const title = `UI deal ${Date.now()}`;
  await panel.getByRole('button', { name: 'Add deal' }).click();
  await panel.getByLabel('Deal name').fill(title);
  await panel.getByLabel('Value (₹)').fill('3500');
  const options = await panel.getByLabel(/Linked conversation/).locator('option').allTextContents();
  expect(options.length).toBeGreaterThan(1);
  await panel.getByLabel(/Linked conversation/).selectOption({ index: 1 });
  await panel.getByRole('button', { name: 'Add deal' }).click();
  await expect(panel.locator('.deal-row-main strong', { hasText: title })).toBeVisible();
  const row = panel.locator('.deal-row').filter({ hasText: title });
  await expect(row).toContainText('₹3,500');
  await expect(row).toContainText('From ');

  const before = await (await page.request.get('/api/deals?contactId=demo-ns-contact-1&pageSize=50')).json() as { deals: Array<{ id: string; title: string; stage: string }> };
  await row.getByLabel(`Stage of ${title}`).selectOption('replied');
  await expect(page.getByRole('status').getByText('Deal moved to Replied.')).toBeVisible();
  const after = await (await page.request.get('/api/deals?contactId=demo-ns-contact-1&pageSize=50')).json() as { deals: Array<{ id: string; title: string; stage: string }> };
  for (const deal of before.deals.filter((item) => item.title !== title)) expect(after.deals.find((item) => item.id === deal.id)?.stage, `${deal.title} did not move`).toBe(deal.stage);
  expect(after.deals.find((item) => item.title === title)?.stage).toBe('replied');
});

test('the pipeline can start a deal for any person and shows its value and conversation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  await page.goto('/pipeline');
  await page.getByRole('button', { name: 'New deal' }).click();
  const dialog = page.getByRole('dialog', { name: 'New deal' });
  await dialog.getByLabel('Who is it with?').fill('Noah');
  await dialog.getByRole('button', { name: /Noah Price/ }).click();
  const title = `Board deal ${Date.now()}`;
  await dialog.getByLabel('Deal name').fill(title);
  await dialog.getByLabel('Value (₹)').fill('900');
  await dialog.getByRole('button', { name: 'Add deal' }).click();
  const card = page.locator('.pipeline-person').filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Noah Price');
  await expect(card).toContainText('₹900');
  await expect(card).toContainText('No conversation linked');
});

test('deal titles are shown as text, never as markup', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const hostile = '<img src=x onerror="window.__dealXss=1">';
  const made = await page.request.post('/api/deals', { headers: { 'X-CSRF-Token': csrfToken, 'X-Workspace-Id': 'demo-northstar' }, data: { contactId: 'demo-ns-contact-6', title: hostile, valueMinor: null, encounterId: null } });
  expect(made.status()).toBe(201);
  await page.goto('/pipeline');
  await expect(page.locator('.pipeline-person').filter({ hasText: hostile })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __dealXss?: number }).__dealXss)).toBeUndefined();
  expect(await page.locator('.pipeline-person img[src="x"]').count()).toBe(0);
});
