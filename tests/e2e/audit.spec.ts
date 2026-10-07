import { expect, test } from '@playwright/test';

test('implemented route and accessible-button audit at desktop and phone widths', async ({ page }) => {
  const failedResponses: string[] = [];
  const browserErrors: string[] = [];
  const settingsChunkRequests: string[] = [];
  await page.goto('/');
  page.on('request', (request) => { if (/SettingsPage(?:[-.]|\.tsx)/i.test(request.url())) settingsChunkRequests.push(request.url()); });
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  expect(settingsChunkRequests, 'the capture-first route does not download Settings code').toEqual([]);
  page.on('response', (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'unknown';
    if (failure !== 'net::ERR_ABORTED') browserErrors.push(`${request.method()} ${request.url()} failed: ${failure}`);
  });
  for (const item of [
    { label: 'Home', heading: /Good morning, Maya/ },
    { label: 'Scan', heading: /^Scan cards$/ },
    { label: 'People', heading: /^People$/ },
    { label: 'Companies', heading: /^Companies$/ },
    { label: 'Follow-ups', heading: /^Follow-ups$/ },
    { label: 'Pipeline', heading: /^Pipeline$/ },
    { label: 'Reports', heading: /^Reports$/ },
    { label: 'Analytics', heading: /^Analytics$/ },
    { label: 'Settings', heading: /What your team sells/ },
  ]) {
    await page.getByRole('link', { name: item.label === 'Scan' ? /^Scan/ : item.label, exact: item.label !== 'Scan' }).first().click();
  await expect(page.getByRole('heading', { name: item.heading })).toBeVisible();
    const unlabeled = await page.locator('button:visible:not([disabled])').evaluateAll((buttons) => buttons
      .filter((button) => !(button.getAttribute('aria-label') || button.textContent || button.getAttribute('title') || '').trim())
      .map((button) => button.outerHTML.slice(0, 160)));
    expect(unlabeled, `Unlabeled enabled buttons on ${item.label}`).toEqual([]);
    const brokenAnchors = await page.locator('a:visible').evaluateAll((anchors) => anchors
      .filter((anchor) => !anchor.getAttribute('href'))
      .map((anchor) => anchor.outerHTML.slice(0, 160)));
      expect(brokenAnchors, `Links without destinations on ${item.label}`).toEqual([]);
  }
  expect(settingsChunkRequests.length, 'opening Settings downloads its code on demand').toBeGreaterThan(0);
  await page.getByRole('link', { name: 'People', exact: true }).first().click();
  const unifiedSearch = page.getByRole('textbox', { name: 'Search companies and people' });
  await unifiedSearch.fill('Acme Packaging');
  const companySearchResult = page.locator('.search-company-matches').getByRole('link', { name: 'Company details' });
  await expect(companySearchResult.first()).toBeVisible();
  await expect(page.locator('.records-row.people-row').first()).toBeVisible();
  await companySearchResult.first().click();
  await expect(page.getByRole('heading', { name: 'Acme Packaging' })).toBeVisible();
  const companyExport = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /Data & activity/ }).click();
  await page.getByRole('button', { name: 'Export company data' }).click();
  expect((await companyExport).suggestedFilename()).toBe('gather-company-export.json');
  await page.goto('/people/demo-ns-contact-1');
  await expect(page.getByRole('heading', { name: 'Tessa Morgan' })).toBeVisible();
  const personStage = page.locator('.person-head-actions .stage-pill.contacted');
  await expect(personStage).toContainText('Contacted');
  await expect(personStage.locator('svg[aria-hidden="true"]')).toBeVisible();
  await page.getByRole('link', { name: 'Follow-up', exact: true }).click();
  await expect(page.getByLabel('What would you like to add?')).toHaveValue('follow_up');
  await page.getByRole('link', { name: 'Meeting', exact: true }).click();
  await expect(page.getByLabel('What would you like to add?')).toHaveValue('meeting');
  await page.getByRole('link', { name: 'Email', exact: true }).click();
  await expect(page.locator('#person-email')).toBeInViewport();
  await page.getByRole('link', { name: 'Voice note', exact: true }).click();
  await expect(page.locator('#person-voice-note')).toBeInViewport();
  await page.getByRole('link', { name: 'Deals', exact: true }).click();
  await expect(page.locator('#person-deals')).toBeInViewport();
  await page.getByRole('button', { name: 'Add deal' }).click();
  await page.getByLabel('Deal name').fill('Acme first order');
  await page.getByLabel('Value (₹)').fill('1250');
  await page.getByRole('button', { name: 'Add deal' }).click();
  await expect(page.getByRole('status').getByText('Deal added.')).toBeVisible();
  await page.getByLabel('Stage of Acme first order').selectOption('won');
  await expect(page.getByRole('status').getByText('Deal moved to Won.')).toBeVisible();
  const personDeals = await (await page.request.get('/api/deals?contactId=demo-ns-contact-1&pageSize=50')).json() as { deals: Array<{ title: string; stage: string; value_minor: number }> };
  expect(personDeals.deals.find((deal) => deal.title === 'Acme first order')).toMatchObject({ stage: 'won', value_minor: 125000 });
  await page.getByRole('link', { name: 'Companies', exact: true }).first().click();
  await page.getByRole('link', { name: 'Company details' }).first().click();
  await expect(page.getByRole('heading', { name: 'Acme Packaging' })).toBeVisible();
  await expect(page.locator('.company-deals').getByText('Acme first order')).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /Events & team/ }).click();
  await page.getByRole('button', { name: /Pacific Packaging Expo/ }).first().click();
  await page.getByLabel('Event spend (₹)').fill('10000');
  await page.getByRole('button', { name: 'Save event' }).click();
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
  await expect(page.locator('.metric-card').filter({ hasText: 'Follow-ups done' })).toBeVisible();
  await expect(page.locator('.metric-card').filter({ hasText: 'Won deals' }).locator('.metric-number')).toHaveText('2');
  await expect(page.locator('.metric-card').filter({ hasText: 'Won deal value' }).locator('.metric-number')).toHaveText('₹2,500');
  await expect(page.locator('.metric-card').filter({ hasText: 'Won value ÷ event spend' }).locator('.metric-number')).toHaveText('25%');
  await expect(page.getByText(/not event attribution or net ROI/)).toBeVisible();
  await expect(page.getByText('Event spend: ₹10,000').first()).toBeVisible();
  await expect(page.locator('.report-chart')).toHaveCount(2);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export people CSV' }).click();
  expect((await download).suggestedFilename()).toBe('encore-people.csv');
  const exportAudit = await (await page.request.get('/api/export/data.json')).json() as { data: { auditEvents: Array<{ action: string; details: { format?: string } }> } };
  expect(exportAudit.data.auditEvents.some((item) => item.action === 'data_exported' && item.details?.format === 'people_csv')).toBe(true);
  await page.getByRole('button', { name: 'Help' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('link', { name: /Open Capture/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const item of [
    { label: 'Home', heading: /Good morning, Maya/ },
    { label: 'Scan', heading: /^Scan cards$/ },
    { label: 'People', heading: /^People$/ },
    { label: 'Companies', heading: /^Companies$/ },
    { label: 'Follow-ups', heading: /^Follow-ups$/ },
    { label: 'Pipeline', heading: /^Pipeline$/ },
    { label: 'Reports', heading: /^Reports$/ },
  ]) {
    const phoneLink = page.getByRole('navigation', { name: 'Phone navigation' }).getByRole('link', { name: item.label, exact: true });
    if (await phoneLink.count() && await phoneLink.isVisible()) await phoneLink.click();
    else {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.locator('.sidebar').getByRole('link', { name: item.label, exact: true }).click();
    }
    await expect(page.getByRole('heading', { name: item.heading })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole('navigation', { name: 'Phone navigation' }).getByRole('link', { name: 'People' }).click();
  await page.getByRole('textbox', { name: 'Search companies and people' }).fill('Acme Packaging');
  await expect(page.locator('.search-company-matches').getByRole('link', { name: 'Company details' }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.profile-button').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Good to see you.' })).toBeVisible();
  await page.getByRole('button', { name: /Sam Patel/ }).click();
  for (const item of [
    { label: 'Home', heading: /Good morning, Sam/ },
    { label: 'Scan', heading: /^Scan cards$/ },
    { label: 'People', heading: /^People$/ },
    { label: 'Follow-ups', heading: /^Follow-ups$/ },
    { label: 'Settings', heading: /About me/ },
  ]) {
    await page.getByRole('link', { name: item.label === 'Scan' ? /^Scan/ : item.label, exact: item.label !== 'Scan' }).first().click();
    await expect(page.getByRole('heading', { name: item.heading })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'That page isn’t here.' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Reports' })).toHaveCount(0);
  expect((await page.request.get('/api/reports')).status()).toBe(403);
  await page.goto('/pipeline');
  await expect(page.getByRole('heading', { name: 'That page isn’t here.' })).toBeVisible();
  expect(failedResponses).toEqual([]);
  expect(browserErrors).toEqual([]);
});
