import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('repeat cards reuse the stored scan; later conversations stay on one person and inform email', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/people/demo-ns-contact-1');
  await expect(page.getByRole('heading', { name: 'Tessa Morgan' })).toBeVisible();
  await expect(page.getByLabel('Where did you meet?')).toHaveValue('event-main-active');
  const database = new Database(resolve(process.env.DATABASE_PATH!));
  const count = (table: 'contacts' | 'encounters') => (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id='demo-northstar'`).get() as { count: number }).count;
  const peopleBefore = count('contacts');
  const encountersBefore = count('encounters');
  const createdScanIds: string[] = [];
  const analyticsUrl = '/api/analytics?days=7&eventId=event-main-active';
  const readEventConversations = async () => {
    const response = await page.request.get(analyticsUrl, { headers: { 'X-Workspace-Id': 'demo-northstar' } });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json() as { metrics: { conversations: number } }).metrics.conversations;
  };
  const eventConversationsBefore = await readEventConversations();
  try {
    await page.getByLabel('What did you discuss?').fill('Asked about carton samples for the autumn expo. Send specifications first.');
    await page.getByRole('button', { name: 'Add conversation' }).click();
    await expect(page.getByText('Asked about carton samples for the autumn expo. Send specifications first.')).toBeVisible();
    expect(count('contacts')).toBe(peopleBefore);
    expect(count('encounters')).toBe(encountersBefore + 1);

    const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
    const headers = { 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': 'demo-northstar' };
    const clientConversationId = randomUUID();
    const body = { body: 'Later at a physical meeting: requested a short comparison before any quote.', eventId: 'event-main-active', clientConversationId };
    const first = await page.request.post('/api/contacts/demo-ns-contact-1/conversations', { headers, data: body });
    expect(first.status(), await first.text()).toBe(201);
    const retry = await page.request.post('/api/contacts/demo-ns-contact-1/conversations', { headers, data: body });
    expect(retry.status(), await retry.text()).toBe(200);
    expect((await retry.json() as { duplicate: boolean }).duplicate).toBe(true);
    expect(count('encounters')).toBe(encountersBefore + 2);
    expect(count('contacts')).toBe(peopleBefore);
    expect(await readEventConversations()).toBe(eventConversationsBefore + 2);
    const denied = await page.request.post('/api/contacts/demo-ns-contact-1/conversations', {
      headers, data: { body: 'Should not save', eventId: randomUUID(), clientConversationId: randomUUID() },
    });
    expect(denied.status()).toBe(403);
    expect(count('encounters')).toBe(encountersBefore + 2);

    const draftResponse = await page.request.post('/api/contacts/demo-ns-contact-1/email-draft', { headers });
    expect(draftResponse.status(), await draftResponse.text()).toBe(201);
    const draft = await draftResponse.json() as { status: string; sourcesUsed: Array<{ label: string; excerpt: string }> };
    expect(draft.status).toBe('draft');
    const conversationSources = draft.sourcesUsed.filter((source) => source.label.includes('conversation'));
    expect(conversationSources[0]?.excerpt).toContain('Later at a physical meeting');
    expect(conversationSources[1]?.excerpt).toContain('Asked about carton samples');

    const photo = await readFile(resolve('tests/fixtures/card-split-columns.png'));
    const hash = createHash('sha256').update(photo).digest('hex');
    const beforePhotos = (database.prepare(`SELECT COUNT(*) AS count FROM scans WHERE workspace_id='demo-northstar' AND content_sha256=?`).get(hash) as { count: number }).count;
    const uploadHeaders = { ...headers, 'Content-Type': 'image/png', 'X-Scan-Source': 'gallery', 'X-Event-Id': 'event-main-active' };
    const uploaded = await page.request.post('/api/scans', { headers: { ...uploadHeaders, 'X-Client-Scan-Id': randomUUID() }, data: photo });
    expect([200, 201]).toContain(uploaded.status());
    const uploadResult = await uploaded.json() as { scan: { id: string } };
    if (uploaded.status() === 201) createdScanIds.push(uploadResult.scan.id);
    const repeat = await page.request.post('/api/scans', { headers: { ...uploadHeaders, 'X-Client-Scan-Id': randomUUID() }, data: photo });
    expect(repeat.status(), await repeat.text()).toBe(200);
    const repeatResult = await repeat.json() as { scan: { id: string }; duplicateImage: boolean };
    expect(repeatResult.duplicateImage).toBe(true);
    expect(repeatResult.scan.id).toBe(uploadResult.scan.id);
    const deniedImage = await page.request.post('/api/scans', { headers: { ...uploadHeaders, 'X-Client-Scan-Id': randomUUID(), 'X-Event-Id': randomUUID() }, data: photo });
    expect(deniedImage.status()).toBe(403);
    const afterPhotos = (database.prepare(`SELECT COUNT(*) AS count FROM scans WHERE workspace_id='demo-northstar' AND content_sha256=?`).get(hash) as { count: number }).count;
    expect(afterPhotos).toBe(Math.max(beforePhotos, 1));
    const qrFields = { name: 'QR Continuity Test', title: '', company: 'Northstar Test', email: 'qr-continuity@example.test', phone: '', website: '', products: [], topics: [], uncertain: [] };
    const qrFirst = await page.request.post('/api/scans/qr', { headers, data: { clientScanId: randomUUID(), eventId: 'event-main-active', fields: qrFields } });
    expect(qrFirst.status(), await qrFirst.text()).toBe(201);
    const qrSecond = await page.request.post('/api/scans/qr', { headers, data: { clientScanId: randomUUID(), eventId: 'event-main-active', fields: qrFields } });
    expect(qrSecond.status(), await qrSecond.text()).toBe(200);
    const qrOriginal = await qrFirst.json() as { scan: { id: string } };
    createdScanIds.push(qrOriginal.scan.id);
    const qrRepeat = await qrSecond.json() as { scan: { id: string }; duplicateQr: boolean };
    expect(qrRepeat.duplicateQr).toBe(true);
    expect(qrRepeat.scan.id).toBe(qrOriginal.scan.id);
    const deniedQr = await page.request.post('/api/scans/qr', { headers, data: { clientScanId: randomUUID(), eventId: randomUUID(), fields: qrFields } });
    expect(deniedQr.status()).toBe(403);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/scan');
    await expect(page.getByLabel('Attach new captures to')).toHaveValue('event-main-active');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto('/people/demo-ns-contact-1');
    await page.getByLabel('What did you discuss?').fill('At the follow-up, requested the short comparison by email.');
    await page.getByRole('button', { name: 'Add & prepare email' }).click();
    await expect(page.getByText('At the follow-up, requested the short comparison by email.', { exact: true })).toBeVisible();
    await expect(page.locator('#person-email').getByText(/Latest conversation/)).toBeVisible();
    await expect(page.locator('#person-email').getByRole('button', { name: 'Send email' })).toBeVisible();
    expect((database.prepare(`SELECT status FROM emails WHERE workspace_id='demo-northstar' AND contact_id='demo-ns-contact-1' ORDER BY created_at DESC LIMIT 1`).get() as { status: string }).status).toBe('draft');
  } finally {
    try {
      const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
      for (const scanId of createdScanIds) await page.request.post(`/api/scans/${scanId}/discard`, { headers: { 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': 'demo-northstar' } });
    } catch { /* Test cleanup should not hide the original assertion. */ }
    database.close();
  }
});
