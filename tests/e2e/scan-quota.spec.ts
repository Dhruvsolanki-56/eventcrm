import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('card-photo workspace quota rejects the upload before a scan row is kept', async ({ page }) => {
  expect(process.env.SCAN_STORAGE_WORKSPACE_LIMIT_BYTES).toBe('70000');
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const invalidClientScanId = crypto.randomUUID();
  const invalidPhoto = await page.request.post('/api/scans', {
    data: Buffer.alloc(256, 65),
    headers: { 'Content-Type': 'image/png', 'X-Client-Scan-Id': invalidClientScanId, 'X-Scan-Source': 'gallery', 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': 'demo-northstar' },
  });
  expect(invalidPhoto.status()).toBe(415);
  expect(await invalidPhoto.json()).toMatchObject({ code: 'invalid_photo', message: 'Use a JPEG, PNG or WebP photo.' });
  const photo = readFileSync(resolve('public/demo/sample-card.png'));
  expect(photo.byteLength).toBeGreaterThan(35_000);
  expect(photo.byteLength * 2).toBeGreaterThan(70_000);
  const firstResponse = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST');
  await page.locator('#capture-gallery').setInputFiles({ name: 'quota-card.png', mimeType: 'image/png', buffer: photo });
  const first = await firstResponse;
  expect(first.status(), await first.text()).toBe(201);
  const firstScanId = String(((await first.json()) as { scan: { id: string } }).scan.id);
  const secondResponse = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST');
  await page.locator('#capture-gallery').setInputFiles({ name: 'quota-card-second.png', mimeType: 'image/png', buffer: photo });
  const rejected = await secondResponse;
  expect(rejected.status()).toBe(413);
  expect(await rejected.json()).toMatchObject({ code: 'scan_storage_limit' });

  const discard = await page.evaluate(async ({ scanId, csrfToken }) => {
    const response = await fetch(`/api/scans/${scanId}/discard`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'X-Workspace-Id': 'demo-northstar', 'X-CSRF-Token': csrfToken },
    });
    return { status: response.status, body: await response.text() };
  }, { scanId: firstScanId, csrfToken: csrf.csrfToken });
  expect(discard.status, discard.body).toBe(200);
  const afterDiscard = await page.request.post('/api/scans', {
    data: photo,
    headers: { 'Content-Type': 'image/png', 'X-Client-Scan-Id': crypto.randomUUID(), 'X-Scan-Source': 'gallery', 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': 'demo-northstar' },
  });
  expect(afterDiscard.status(), await afterDiscard.text()).toBe(201);

  const databasePath = resolve(process.env.DATABASE_PATH ?? '');
  const db = new Database(databasePath, { readonly: true });
  try {
    expect(db.prepare('SELECT id FROM scans WHERE client_scan_id=?').get(invalidClientScanId)).toBeUndefined();
    const discarded = db.prepare('SELECT status,image_path,image_bytes FROM scans WHERE id=?').get(firstScanId) as { status: string; image_path: string | null; image_bytes: number };
    expect(discarded).toMatchObject({ status: 'discarded', image_path: null, image_bytes: 0 });
    const stored = db.prepare('SELECT COUNT(*) AS count FROM scans WHERE workspace_id=? AND image_bytes>0').get('demo-northstar') as { count: number };
    expect(stored.count).toBe(1);
  } finally { db.close(); }
});
