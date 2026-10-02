import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('packaged sample card and brochure upload immediately and the brochure QR is decoded on-device', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByText('Sample data').first()).toBeVisible();
  await page.getByRole('link', { name: /^Scan/ }).first().click();

  const cardResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST');
  await page.locator('#capture-gallery').setInputFiles({
    name: 'sample-card.png', mimeType: 'image/png', buffer: readFileSync(resolve('public/demo/sample-card.png')),
  });
  const cardResponse = await cardResponsePromise;
  expect(cardResponse.status()).toBe(201);
  const cardScan = (await cardResponse.json() as { scan: { id: string; clientScanId: string; status: string } }).scan;
  expect(cardScan.status).toBe('queued');
  await expect(page).toHaveURL(new RegExp(`/review/${cardScan.id}(?:\\?dialog=1)?$`));
  await expect(page.locator('.review-status svg[aria-hidden="true"]')).toBeVisible();
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact');
  await expect(page.getByLabel('Job title')).toHaveValue('Packaging Buyer');
  await expect(page.getByLabel('Company')).toHaveValue(/acme packaging/i);
  await expect(page.getByLabel('Email')).toHaveValue('demo.contact@sample.invalid');
  await expect(page.getByRole('dialog').getByRole('textbox', { name: /^Phone/ })).toHaveValue(/\+1\s?415\s?555\s?0199/);
  await expect(page.getByLabel('Website')).toHaveValue(/(?:https?:\/\/)?acme\.co/);

  await page.getByRole('dialog').getByRole('link', { name: 'Close' }).click();
  await page.getByRole('link', { name: /^Scan/ }).first().click();
  const cardRow = page.locator(`.tray-item[data-client-scan-id="${cardScan.clientScanId}"]`);
  await cardRow.getByRole('button', { name: 'Discard Demo Contact' }).click();
  await expect(cardRow).toHaveCount(0);
  const brochureResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST');
  await page.locator('#capture-gallery').setInputFiles({
    name: 'sample-brochure-qr.png', mimeType: 'image/png', buffer: readFileSync(resolve('public/demo/sample-brochure-qr.png')),
  });
  const brochureResponse = await brochureResponsePromise;
  expect(brochureResponse.status()).toBe(201);
  const brochureScan = (await brochureResponse.json() as { scan: { id: string; clientScanId: string; status: string } }).scan;
  expect(brochureScan.status).toBe('queued');
  await expect.poll(async () => {
    const detail = await (await page.request.get(`/api/scans/${brochureScan.id}`)).json() as { scan: { extracted: { website?: string } | null } };
    return detail.scan.extracted?.website ?? '';
  }, { timeout: 10_000 }).toBe('https://acme.co/');
  await expect(page).toHaveURL(new RegExp(`/review/${brochureScan.id}(?:\\?dialog=1)?$`));
  await expect(page.getByRole('button', { name: 'Company brochure' })).toBeVisible();
  await page.getByRole('button', { name: 'Company brochure' }).click();
  await page.getByLabel('Company name').fill('Acme Packaging');
  await page.getByLabel(/Products or topics shown/).fill('Sample cartons');
  await expect(page.getByLabel('Company name')).toHaveValue('Acme Packaging');
  await page.getByRole('dialog').getByRole('link', { name: 'Close' }).click();
  await page.getByRole('link', { name: /^Scan/ }).first().click();
  const brochureRow = page.locator(`.tray-item[data-client-scan-id="${brochureScan.clientScanId}"]`);
  await brochureRow.getByRole('button', { name: 'Discard Demo Contact' }).click();
  await expect(brochureRow).toHaveCount(0);
});

test('a contact-card QR payload fills only the supported lead fields for one-at-a-time review', async ({ page }) => {
  const payload = [
    'BEGIN:VCARD', 'VERSION:3.0', 'N:Morgan;Tessa;;;', 'FN:Tessa Morgan', 'ORG:Acme Packaging',
    'TITLE:Procurement Director', 'EMAIL;TYPE=INTERNET:TESSA.QR@ACMEPACKAGING.EXAMPLE',
    'TEL;TYPE=WORK,VOICE:+1 415 555 0191', 'URL:https://acme.co', 'END:VCARD',
  ].join(String.fromCharCode(10));
  await page.addInitScript((rawValue) => {
    Object.defineProperty(window, 'BarcodeDetector', {
      configurable: true,
      value: class { async detect() { return [{ rawValue }]; } },
    });
  }, payload);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: /^Scan/ }).first().click();
  const uploadPromise = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST');
  await page.locator('#capture-gallery').setInputFiles({
    name: 'contact-qr-card.png', mimeType: 'image/png', buffer: readFileSync(resolve('public/demo/sample-card.png')),
  });
  const uploaded = await uploadPromise;
  expect(uploaded.status()).toBe(201);
  const uploadedScan = (await uploaded.json()) as { scan: { id: string; clientScanId: string } };
  const scanId = uploadedScan.scan.id;
  await expect.poll(async () => {
    const detail = await (await page.request.get(`/api/scans/${scanId}`)).json() as { scan: { extracted: Record<string, string> | null } };
    return detail.scan.extracted;
  }, { timeout: 10_000 }).toMatchObject({
    name: 'Tessa Morgan', title: 'Procurement Director', company: 'Acme Packaging',
    email: 'tessa.qr@acmepackaging.example', phone: '+1 415 555 0191', website: 'https://acme.co',
  });
  await expect(page).toHaveURL(new RegExp(`/review/${scanId}(?:\\?dialog=1)?$`));
  await expect(page.getByLabel('Name *')).toHaveValue('Tessa Morgan');
  await expect(page.getByLabel('Company')).toHaveValue('Acme Packaging');
  await expect(page.getByLabel('Email')).toHaveValue('tessa.qr@acmepackaging.example');
  await expect(page.getByRole('dialog').getByRole('textbox', { name: /^Phone/ })).toHaveValue('+1 415 555 0191');
  await expect(page.getByLabel('Job title')).toHaveValue('Procurement Director');
  await expect(page.getByLabel('Website')).toHaveValue('https://acme.co');
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const unsafeQr = await page.request.post(`/api/scans/${scanId}/qr`, {
    data: { name: 'Tessa Morgan', title: 'Procurement Director', company: 'Acme Packaging', email: 'tessa.qr@acmepackaging.example', phone: '+1 415 555 0191', website: 'javascript:alert(1)', products: [], topics: [], uncertain: [] },
    headers: { 'X-CSRF-Token': csrf.csrfToken },
  });
  expect(unsafeQr.status()).toBe(400);
  const session = await (await page.request.get('/api/auth/me')).json() as { workspace: { id: string } };
  const personDetail = await (await page.request.get('/api/contacts/demo-ns-contact-1', { headers: { 'X-Workspace-Id': session.workspace.id } })).json() as {
    person: { version: number; name: string; title: string; email: string; phone: string };
  };
  const unsafePersonEdit = await page.request.patch('/api/contacts/demo-ns-contact-1', {
    data: { version: personDetail.person.version, name: personDetail.person.name, title: personDetail.person.title, email: personDetail.person.email, phone: personDetail.person.phone, website: 'javascript:alert(1)' },
    headers: { 'X-Workspace-Id': session.workspace.id, 'X-CSRF-Token': csrf.csrfToken },
  });
  expect(unsafePersonEdit.status()).toBe(400);
  await page.getByRole('dialog').getByRole('link', { name: 'Close' }).click();
  await page.getByRole('link', { name: /^Scan/ }).first().click();
  const contactQrRow = page.locator(`.tray-item[data-client-scan-id="${uploadedScan.scan.clientScanId}"]`);
  await contactQrRow.getByRole('button', { name: 'Discard Tessa Morgan' }).click();
  await expect(contactQrRow).toHaveCount(0);
});
