import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

test('QR-only scans obey workspace and service count quotas and discard releases stored rows', async ({ page }) => {
  test.skip(process.env.GATHER_QR_QUOTA_MODE !== '1', 'Run with npm run test:qr-quota to enable deliberately low test limits.');
  expect(process.env.QR_SCAN_WORKSPACE_LIMIT_COUNT).toBe('2');
  expect(process.env.QR_SCAN_TOTAL_LIMIT_COUNT).toBe('3');
  await page.goto('/');

  const database = new Database(resolve(process.env.DATABASE_PATH ?? ''), { readonly: true });
  const counts = (workspaceId?: string) => ((workspaceId
    ? database.prepare(`SELECT COUNT(*) AS total FROM scans WHERE source='qr' AND workspace_id=?`).get(workspaceId)
    : database.prepare(`SELECT COUNT(*) AS total FROM scans WHERE source='qr'`).get()) as { total: number }).total;
  const csrf = async () => (await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string }).csrfToken;
  const submit = (clientScanId: string, workspaceId: string, token: string) => page.request.post('/api/scans/qr', {
    data: { clientScanId, fields: { name: `QR Quota Person ${clientScanId.slice(-4)}`, title: 'Buyer', company: 'Quota Company', email: '', phone: '', website: '', products: [], topics: [], uncertain: [] } },
    headers: { 'X-CSRF-Token': token, 'X-Workspace-Id': workspaceId },
  });

  try {
    await page.getByRole('button', { name: /Maya Chen/ }).click();
    await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
    let token = await csrf();
    const firstId = 'b1000000-0000-4000-8000-000000000001';
    const secondId = 'b1000000-0000-4000-8000-000000000002';
    const thirdId = 'b1000000-0000-4000-8000-000000000003';
    const fourthId = 'b1000000-0000-4000-8000-000000000004';
    const fifthId = 'b1000000-0000-4000-8000-000000000005';

    const first = await submit(firstId, 'demo-northstar', token);
    expect(first.status(), await first.text()).toBe(201);
    const duplicate = await submit(firstId, 'demo-northstar', token);
    expect(duplicate.status()).toBe(200);
    expect((await duplicate.json()).duplicate).toBe(true);
    expect((await submit(secondId, 'demo-northstar', token)).status()).toBe(201);
    const workspaceRejected = await submit(thirdId, 'demo-northstar', token);
    expect(workspaceRejected.status()).toBe(413);
    expect((await workspaceRejected.json()).code).toBe('qr_scan_storage_limit');
    expect(counts('demo-northstar')).toBe(2);

    const firstScan = database.prepare(`SELECT id,event_id,created_by,contact_id,status,source FROM scans WHERE workspace_id=? AND client_scan_id=?`).get('demo-northstar', firstId) as { id: string; event_id: string | null; created_by: string | null; contact_id: string | null; status: string; source: string } | undefined;
    expect(firstScan).toBeDefined();
    const discarded = await page.request.post(`/api/scans/${firstScan?.id}/discard`, {
      headers: { 'X-CSRF-Token': token, 'X-Workspace-Id': 'demo-northstar' },
    });
    expect(discarded.status(), `${JSON.stringify(firstScan)} ${await discarded.text()}`).toBe(200);
    expect(counts('demo-northstar')).toBe(1);
    expect((await submit(thirdId, 'demo-northstar', token)).status()).toBe(201);
    expect(counts('demo-northstar')).toBe(2);

    expect((await page.request.post('/api/auth/logout', { headers: { 'X-CSRF-Token': token } })).status()).toBe(200);
    await page.goto('/');
    await page.getByRole('button', { name: /Alex Rivera/ }).click();
    await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
    token = await csrf();
    expect((await submit(fourthId, 'demo-riverbend', token)).status()).toBe(201);
    expect(counts()).toBe(3);

    expect((await page.request.post('/api/auth/logout', { headers: { 'X-CSRF-Token': token } })).status()).toBe(200);
    await page.goto('/');
    await page.getByRole('button', { name: /Sam Patel/ }).click();
    await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
    token = await csrf();
    const serviceRejected = await submit(fifthId, 'demo-sam-space', token);
    expect(serviceRejected.status()).toBe(413);
    expect((await serviceRejected.json()).code).toBe('qr_scan_storage_limit');
    expect(counts()).toBe(3);
    expect(counts('demo-sam-space')).toBe(0);
  } finally { database.close(); }
});
