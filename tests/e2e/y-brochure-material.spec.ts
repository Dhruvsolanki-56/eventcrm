import { expect, test } from '@playwright/test';

test('an uploaded brochure is kept with its company without creating a person', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: /^Scan/ }).first().click();

  const dataUrl = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 840; canvas.height = 480;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f3f0e8'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#202020'; context.font = 'bold 44px sans-serif'; context.fillText('Acme Packaging', 70, 150);
    context.font = '30px sans-serif'; context.fillText('Recyclable product guide', 70, 220);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', .9));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });
  const image = Buffer.from(dataUrl, 'base64');
  const started = page.waitForRequest((request) => request.url().includes('/api/scans') && request.method() === 'POST');
  await page.locator('#capture-gallery').setInputFiles({ name: 'acme-brochure.jpg', mimeType: 'image/jpeg', buffer: image });
  await started;
  await expect(page.getByRole('button', { name: 'Review' }).first()).toBeVisible();
  await expect(page.getByText('Demo reading')).toBeVisible();
  await page.getByRole('button', { name: 'Review' }).first().click();
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact');
  await page.getByRole('button', { name: 'Company brochure' }).click();
  await expect(page.getByLabel('Company name')).toHaveValue('Acme Packaging');
  const brochureItems = page.getByLabel(/Products or topics shown/);
  await expect(brochureItems).toHaveValue('Sample cartons');
  await brochureItems.fill('Recyclable cartons\nCompostable mailers');
  await page.getByRole('button', { name: 'Save brochure' }).click();
  await expect(page.getByRole('heading', { name: 'Brochure saved to the company.' })).toBeVisible();

  const currentUrl = new URL(page.url());
  const routeScanId = currentUrl.pathname.split('/').at(-1);
  expect(routeScanId).toBeTruthy();
  const workspaceHeaders = { 'X-Workspace-Id': 'demo-northstar' };
  const savedScan = await (await page.request.get(`/api/scans/${routeScanId}`, { headers: workspaceHeaders })).json() as { scan: { materialCompanyId: string; contactId: string | null; status: string; extracted: { products: string[] } } };
  expect(savedScan.scan.materialCompanyId).toBeTruthy();
  expect(savedScan.scan.contactId).toBeNull();
  expect(savedScan.scan.status).toBe('saved');
  expect(savedScan.scan.extracted.products).toEqual(['Recyclable cartons', 'Compostable mailers']);

  await page.goto(`/companies/${savedScan.scan.materialCompanyId}`);
  await expect(page.getByRole('heading', { name: 'Acme Packaging' })).toBeVisible();
  const material = page.locator('.material-card');
  await expect(material).toHaveCount(1);
  await expect(material.getByText('Brochure photo')).toBeVisible();
  await expect(material.getByText('Recyclable cartons · Compostable mailers')).toBeVisible();
  const photoResponse = await page.request.get(await material.locator('img').getAttribute('src') ?? '', { headers: workspaceHeaders });
  expect(photoResponse.status()).toBe(200);
  const duplicateCompanies = (await (await page.request.get('/api/companies', { headers: workspaceHeaders })).json() as { companies: Array<{ name: string }> }).companies.filter((company) => company.name === 'Acme Packaging');
  expect(duplicateCompanies).toHaveLength(1);

  page.once('dialog', (dialog) => dialog.accept());
  await material.getByRole('button', { name: 'Remove material' }).click();
  await expect(material).toHaveCount(0);
  const reusableScan = await (await page.request.get(`/api/scans/${routeScanId}`, { headers: workspaceHeaders })).json() as { scan: { materialCompanyId: string | null; contactId: string | null; status: string } };
  expect(reusableScan.scan).toMatchObject({ materialCompanyId: null, contactId: null, status: 'ready' });

  await page.goto(`/review/${routeScanId}`);
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact');
  const followUp = page.getByLabel('Next follow-up date');
  await expect(followUp).not.toHaveValue('');
  const expectedFollowUpDay = await followUp.inputValue();
  await page.getByRole('button', { name: 'Save person' }).click();
  await expect(page.getByText('This person is saved.')).toBeVisible();
  const savedPerson = await (await page.request.get(`/api/scans/${routeScanId}`, { headers: workspaceHeaders })).json() as { scan: { materialCompanyId: string | null; contactId: string; status: string } };
  expect(savedPerson.scan.contactId).toBeTruthy();
  expect(savedPerson.scan.materialCompanyId).toBeNull();
  expect(savedPerson.scan.status).toBe('saved');
  const allTasks = await (await page.request.get('/api/tasks', { headers: workspaceHeaders })).json() as { tasks: Array<{ contact_id: string; due_at: string; time_zone: string }> };
  const automaticFollowUp = allTasks.tasks.find((task) => task.contact_id === savedPerson.scan.contactId);
  expect(automaticFollowUp?.time_zone).toBe('America/Los_Angeles');
  const localDue = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(automaticFollowUp!.due_at)).map((part) => [part.type, part.value]));
  expect(`${localDue.year}-${localDue.month}-${localDue.day}`).toBe(expectedFollowUpDay);
  expect(localDue.hour).toBe('09');
});
