import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('expired local session cookies do not block a fresh sample-account sign-in', async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'gather_session', value: 'stale-session-from-another-local-database', url: baseURL! },
    { name: 'gather_csrf', value: 'stale-csrf-token', url: baseURL! },
  ]);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Good to see you.' })).toBeVisible();
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: /Good morning, Maya/ })).toBeVisible();
});

test('sample company and attendee accounts enter their own spaces', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) => errors.push(`${request.method()} ${request.url()} failed: ${request.failure()?.errorText ?? 'unknown'}`));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Good to see you.' })).toBeVisible();

  for (const account of [
    { name: /Maya Chen/, heading: /Good morning, Maya/, strip: /Company: Northstar Packaging/ },
    { name: /Priya Shah/, heading: /Good morning, Priya/, strip: /Company: Northstar Packaging/ },
    { name: /Jordan Lee/, heading: /Good morning, Jordan/, strip: /Company: Northstar Packaging/ },
    { name: /Alex Rivera/, heading: /Good morning, Alex/, strip: /Company: Riverbend Supply/ },
    { name: /Sam Patel/, heading: /Good morning, Sam/, strip: /Private\. Only you can see this\./ },
    { name: /Riley Morgan/, heading: /Good morning, Riley/, strip: /Private\. Only you can see this\./ },
  ]) {
    await page.getByRole('button', { name: account.name }).click();
    await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
    await page.getByRole('link', { name: 'Home' }).click();
    await expect(page.getByRole('heading', { name: account.heading })).toBeVisible();
    await expect(page.getByText(account.strip).first()).toBeVisible();
    await expect(page.getByText('Sample data').first()).toBeVisible();
    if (account.name.test('Maya Chen')) {
      const seededCompanies = ((await (await page.request.get('/api/companies')).json()).companies) as Array<{ id: string; name: string }>;
      expect(seededCompanies).toHaveLength(12);
      expect(new Set(seededCompanies.map((company) => company.name.toLowerCase())).size).toBe(12);
      const acme = await (await page.request.get('/api/companies/demo-ns-acme')).json() as { people: Array<{ id: string }>; company: { deal_status: string; deal_value_minor: number } };
      expect(acme.people).toHaveLength(3);
      expect(acme.company).toMatchObject({ deal_status: 'won', deal_value_minor: 125000 });
      const seededPeople = ((await (await page.request.get('/api/contacts')).json()).people) as Array<{ id: string }>;
      expect(seededPeople).toHaveLength(30);
      const tessa = await (await page.request.get('/api/contacts/demo-ns-contact-1')).json() as { voiceNotes: Array<{ id: string; transcript: string; duration_seconds: number; audio_mime: string }> };
      const sampleVoice = tessa.voiceNotes.find((note) => note.transcript === 'Interested in a small sample run after the event.');
      expect(sampleVoice).toMatchObject({ id: 'a1000000-0000-4000-8000-000000000001', duration_seconds: 3, audio_mime: 'audio/wav' });
      const sampleAudioResponse = await page.request.get(`/api/notes/${sampleVoice!.id}/audio`);
      expect(sampleAudioResponse.status()).toBe(200);
      expect(sampleAudioResponse.headers()['content-type']).toContain('audio/wav');
      expect((await sampleAudioResponse.body()).length).toBeGreaterThan(100_000);
      const privateAudioResponse = await page.request.get('/api/notes/a1000000-0000-4000-8000-000000000002/audio');
      expect(privateAudioResponse.status()).toBe(404);
    }
    if (account.name.test('Jordan Lee')) {
      await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Pipeline' })).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Reports' })).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Settings' })).toHaveCount(0);
      const denied = await Promise.all(['/api/reports','/api/export/people.csv','/api/settings'].map(async (url) => (await page.request.get(url)).status()));
      expect(denied).toEqual([403, 403, 403]);
      expect((await page.request.get('/api/export/data.json')).status()).toBe(403);
    }
    if (account.name.test('Sam Patel')) {
      const sam = await (await page.request.get('/api/contacts/demo-sam-contact-1')).json() as { voiceNotes: Array<{ id: string; transcript: string; audio_mime: string }> };
      const sampleVoice = sam.voiceNotes.find((note) => note.transcript === 'Supplier minimum order is 250 units. They promised a printed sample by Tuesday.');
      expect(sampleVoice).toMatchObject({ id: 'a1000000-0000-4000-8000-000000000002', audio_mime: 'audio/wav' });
      expect((await page.request.get(`/api/notes/${sampleVoice!.id}/audio`)).status()).toBe(200);
      expect((await page.request.get('/api/notes/a1000000-0000-4000-8000-000000000001/audio')).status()).toBe(404);
    }
    if (account.name.test('Riley Morgan')) {
      const riley = await (await page.request.get('/api/contacts/demo-riley-contact-1')).json() as { voiceNotes: Array<{ id: string; transcript: string; audio_mime: string }> };
      const sampleVoice = riley.voiceNotes.find((note) => note.transcript === 'Met at the partner booth. Follow up about the next supplier introduction.');
      expect(sampleVoice).toMatchObject({ id: 'a1000000-0000-4000-8000-000000000003', audio_mime: 'audio/wav' });
      expect((await page.request.get(`/api/notes/${sampleVoice!.id}/audio`)).status()).toBe(200);
    }
    if (account.name.test('Priya Shah')) {
      await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Pipeline' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Reports' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Settings' })).toHaveCount(0);
      const allowed = await Promise.all(['/api/reports','/api/export/people.csv'].map(async (url) => (await page.request.get(url)).status()));
      expect(allowed).toEqual([200, 200]);
      expect((await page.request.get('/api/settings')).status()).toBe(403);
      expect((await page.request.get('/api/export/data.json')).status()).toBe(403);
    }
    await page.locator('.profile-button').click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Good to see you.' })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('event-scoped members cannot read private encounter notes through drafts or delete shared history', async ({ page }) => {
  const databasePath = resolve(process.env.DATABASE_PATH ?? '');
  const db = new Database(databasePath);
  const eventId = randomUUID();
  const encounterId = randomUUID();
  const noteId = randomUUID();
  const unlinkedNoteId = randomUUID();
  const voiceNoteId = randomUUID();
  const emailDraftId = randomUUID();
  const accessibleSentEmailId = randomUUID();
  const failedEmailId = randomUUID();
  const failedEmailJobId = randomUUID();
  let visibleDraftId = '';
  const hiddenNote = 'Private event-only detail: negotiated confidential unit price 7.43.';
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO events(id,workspace_id,name,starts_at,ends_at,time_zone,is_active) VALUES (?,?,?,?,?,'UTC',0)`)
        .run(eventId, 'demo-northstar', 'Restricted Partner Meeting', new Date().toISOString(), new Date(Date.now() + 3600000).toISOString());
      db.prepare('INSERT INTO event_access(workspace_id,event_id,user_id) VALUES (?,?,?)').run('demo-northstar', eventId, 'demo-owner');
      db.prepare('INSERT INTO encounters(id,workspace_id,contact_id,event_id) VALUES (?,?,?,?)').run(encounterId, 'demo-northstar', 'demo-ns-contact-1', eventId);
      db.prepare(`INSERT INTO notes(id,workspace_id,contact_id,encounter_id,kind,body) VALUES (?,?,?,?,'text',?)`)
        .run(noteId, 'demo-northstar', 'demo-ns-contact-1', encounterId, hiddenNote);
      db.prepare(`INSERT INTO notes(id,workspace_id,contact_id,created_by,kind,body) VALUES (?,?,?,'demo-owner','text',?)`)
        .run(unlinkedNoteId, 'demo-northstar', 'demo-ns-contact-1', 'Private owner note without an encounter.');
      const sampleAudio = db.prepare(`SELECT audio_path,audio_mime FROM notes WHERE id='a1000000-0000-4000-8000-000000000001'`)
        .get() as { audio_path: string; audio_mime: string };
      db.prepare(`INSERT INTO notes(id,workspace_id,contact_id,encounter_id,created_by,kind,transcript,audio_path,audio_mime) VALUES (?,?,?,?,?,'audio',?,?,?)`)
        .run(voiceNoteId, 'demo-northstar', 'demo-ns-contact-1', encounterId, 'demo-owner', 'Private voice note.', sampleAudio.audio_path, sampleAudio.audio_mime);
      const insertEmail = db.prepare(`INSERT INTO emails(id,workspace_id,contact_id,encounter_id,recipient,subject,body,status) VALUES (?,?,?,?,?,?,?,?)`);
      insertEmail.run(emailDraftId, 'demo-northstar', 'demo-ns-contact-1', encounterId, 'contact@example.test', 'Restricted event draft', 'Event A content', 'draft');
      db.prepare(`INSERT INTO emails(id,workspace_id,contact_id,encounter_id,recipient,subject,body,status,sent_to_server_at,created_by)
        VALUES (?,?,?,?,?,?,?,'sent','2000-01-01T00:00:00.000Z','demo-rep')`)
        .run(accessibleSentEmailId, 'demo-northstar', 'demo-ns-contact-1', 'demo-encounter-1', 'contact@example.test', 'Accessible event follow-up', 'Visible event content');
      insertEmail.run(failedEmailId, 'demo-northstar', 'demo-ns-contact-1', encounterId, 'contact@example.test', 'Restricted failed draft', 'Event A content', 'failed');
      db.prepare(`INSERT INTO jobs(id,workspace_id,type,payload_json,run_at,status) VALUES (?,?,'email_send',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'failed')`)
        .run(failedEmailJobId, 'demo-northstar', JSON.stringify({ emailId: failedEmailId }));
    })();
  } finally { db.close(); }

  try {
  await page.goto('/');
  await page.getByRole('button', { name: /Jordan Lee/ }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
  const browserApi = (url: string, method = 'GET', data?: Record<string, string>) => page.evaluate(async ({ url, method, data }) => {
    const headers = new Headers({ 'X-Workspace-Id': 'demo-northstar' });
    if (data) {
      headers.set('Content-Type', 'application/json');
      const csrfResponse = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
      const csrf = await csrfResponse.json() as { csrfToken: string };
      headers.set('X-CSRF-Token', csrf.csrfToken);
    }
    const response = await fetch(url, { method, headers, credentials: 'same-origin', ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, payload: await response.json() as Record<string, unknown> };
  }, { url, method, data });
  const detailResponse = await browserApi('/api/contacts/demo-ns-contact-1');
  expect(detailResponse.status, JSON.stringify(detailResponse.payload)).toBe(200);
  const detail = detailResponse.payload as { timeline: Array<{ detail: string }>; voiceNotes: Array<{ id: string }> };
  expect(detail.timeline.some((item) => item.detail.includes(hiddenNote))).toBe(false);
  expect(detail.timeline.some((item) => item.detail.includes('Private owner note without an encounter.'))).toBe(false);
  expect(detail.timeline.some((item) => item.detail.includes('Private voice note.'))).toBe(false);
  expect(detail.voiceNotes.some((item) => item.id === voiceNoteId)).toBe(false);
  expect((await page.request.get(`/api/notes/${voiceNoteId}/audio`)).status()).toBe(404);
  expect((await browserApi(`/api/notes/${voiceNoteId}/text`, 'PUT', { text: 'Changed outside event' })).status).toBe(404);
  expect((await browserApi(`/api/notes/${voiceNoteId}`, 'DELETE', {})).status).toBe(404);
  const draft = await browserApi('/api/contacts/demo-ns-contact-1/email-draft', 'POST', {});
  expect(draft.status, JSON.stringify(draft.payload)).toBe(201);
  const draftData = draft.payload as { id: string; body: string; sourcesUsed: Array<{ excerpt: string }> };
  visibleDraftId = draftData.id;
  expect(draftData.body).not.toContain(hiddenNote);
  expect(JSON.stringify(draftData.sourcesUsed)).not.toContain(hiddenNote);
  expect((await browserApi(`/api/emails/${emailDraftId}`)).status).toBe(404);
  expect((await browserApi(`/api/emails/${emailDraftId}`, 'PUT', { subject: 'Changed outside event', body: 'Do not send this.' })).status).toBe(409);
  expect((await browserApi(`/api/emails/${emailDraftId}/alternate`, 'POST', {})).status).toBe(409);
  expect((await browserApi(`/api/emails/${emailDraftId}/send`, 'POST', { subject: 'Changed outside event', body: 'Do not send this.' })).status).toBe(409);
  expect((await browserApi(`/api/emails/${failedEmailId}/retry`, 'POST', {})).status).toBe(409);
  expect((await browserApi('/api/emails/demo-email-tessa-sent')).status).toBe(404);
  expect((await browserApi('/api/contacts/demo-ns-contact-1/reply', 'POST', {})).status).toBe(200);
  const deniedDelete = await browserApi('/api/contacts/demo-ns-contact-1', 'DELETE', { confirmation: 'DELETE' });
  expect(deniedDelete.status).toBe(403);
  const verify = new Database(databasePath, { readonly: true });
  try {
    expect(verify.prepare('SELECT body FROM notes WHERE id=?').get(noteId)).toMatchObject({ body: hiddenNote });
    expect(verify.prepare('SELECT status,subject,body FROM emails WHERE id=?').get(emailDraftId)).toMatchObject({ status: 'draft', subject: 'Restricted event draft', body: 'Event A content' });
    expect(verify.prepare('SELECT status FROM emails WHERE id=?').get(failedEmailId)).toMatchObject({ status: 'failed' });
    expect(verify.prepare('SELECT status FROM emails WHERE id=?').get('demo-email-tessa-sent')).toMatchObject({ status: 'sent' });
    expect(verify.prepare('SELECT status FROM emails WHERE id=?').get(accessibleSentEmailId)).toMatchObject({ status: 'replied' });
    expect(verify.prepare('SELECT status FROM jobs WHERE id=?').get(failedEmailJobId)).toMatchObject({ status: 'failed' });
  }
  finally { verify.close(); }
  } finally {
    const cleanup = new Database(databasePath);
    try {
      cleanup.transaction(() => {
        cleanup.prepare('DELETE FROM jobs WHERE id=?').run(failedEmailJobId);
        cleanup.prepare('DELETE FROM emails WHERE id IN (?,?,?)').run(emailDraftId, accessibleSentEmailId, failedEmailId);
        if (visibleDraftId) cleanup.prepare('DELETE FROM emails WHERE id=?').run(visibleDraftId);
        cleanup.prepare('DELETE FROM notes WHERE id IN (?,?,?)').run(noteId, unlinkedNoteId, voiceNoteId);
        cleanup.prepare('DELETE FROM encounters WHERE id=?').run(encounterId);
        cleanup.prepare('DELETE FROM event_access WHERE event_id=?').run(eventId);
        cleanup.prepare('DELETE FROM events WHERE id=?').run(eventId);
      })();
    } finally { cleanup.close(); }
  }
});

test('event-limited members cannot link hidden companies or act on another event task', async ({ page }) => {
  const databasePath = resolve(process.env.DATABASE_PATH ?? '');
  const db = new Database(databasePath);
  const eventId = randomUUID();
  const taskId = randomUUID();
  const starts = new Date().toISOString();
  const ends = new Date(Date.now() + 3_600_000).toISOString();
  const hiddenCompanyId = randomUUID();
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO events(id,workspace_id,name,starts_at,ends_at,time_zone,is_active) VALUES (?,?,?,?,?,'UTC',0)`)
        .run(eventId, 'demo-northstar', 'Restricted Test Event', starts, ends);
      db.prepare(`INSERT INTO companies(id,workspace_id,name,normalized_name,website,normalized_domain) VALUES (?,?,? ,?,'','')`)
        .run(hiddenCompanyId, 'demo-northstar', 'Hidden Partner Holdings', 'hiddenpartnerholdings');
      db.prepare(`INSERT INTO encounters(id,workspace_id,contact_id,event_id) VALUES (?,?,?,?)`)
        .run(randomUUID(), 'demo-northstar', 'demo-ns-contact-1', eventId);
      db.prepare(`INSERT INTO tasks(id,workspace_id,contact_id,event_id,kind,status,due_at,time_zone,title,created_by) VALUES (?,?,?,?,'follow_up','open',?,'UTC','Private event follow-up','demo-owner')`)
        .run(taskId, 'demo-northstar', 'demo-ns-contact-1', eventId, new Date(Date.now() + 86_400_000).toISOString());
    })();
  } finally { db.close(); }

  await page.goto('/');
  await page.getByRole('button', { name: /Jordan Lee/ }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: /Good morning, Jordan/ })).toBeVisible();
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const unauthorizedTaskAction = await page.evaluate(async ({ taskId, csrfToken }) => {
    const response = await fetch(`/api/tasks/${taskId}/action`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': 'demo-northstar', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ action: 'done' }),
    });
    return { status: response.status, body: await response.text() };
  }, { taskId, csrfToken: csrf.csrfToken });
  expect(unauthorizedTaskAction.status, unauthorizedTaskAction.body).toBe(404);
  const taskCheck = new Database(databasePath, { readonly: true });
  try { expect(taskCheck.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toMatchObject({ status: 'open' }); }
  finally { taskCheck.close(); }

  const upload = await page.request.post('/api/scans', {
    data: readFileSync(resolve('public/demo/sample-card.png')),
    headers: { 'Content-Type': 'image/png', 'X-Client-Scan-Id': randomUUID(), 'X-Scan-Source': 'gallery', 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': 'demo-northstar' },
  });
  expect(upload.status()).toBe(201);
  const scanId = String(((await upload.json()) as { scan: { id: string } }).scan.id);
  await expect.poll(async () => ((await (await page.request.get(`/api/scans/${scanId}`)).json()) as { scan: { status: string } }).scan.status).toBe('ready');
  const before = new Database(databasePath, { readonly: true });
  const beforeCounts = {
    companies: (before.prepare('SELECT COUNT(*) AS count FROM companies WHERE workspace_id=?').get('demo-northstar') as { count: number }).count,
    contacts: (before.prepare('SELECT COUNT(*) AS count FROM contacts WHERE workspace_id=?').get('demo-northstar') as { count: number }).count,
  };
  before.close();
  const hiddenCompanyLead = await page.request.post(`/api/scans/${scanId}/save`, {
    data: { name: 'Taylor Sample', title: 'Buyer', company: 'Hidden Partner Holdings', email: 'taylor@new-partner.example', phone: '', website: '', quality: null, note: '', followUpDate: null, productIds: [] },
    headers: { 'X-Workspace-Id': 'demo-northstar', 'X-CSRF-Token': csrf.csrfToken },
  });
  expect(hiddenCompanyLead.status()).toBe(409);
  const failure = await hiddenCompanyLead.json() as { message: string };
  expect(failure.message).not.toContain('Hidden Partner Holdings');
  const after = new Database(databasePath, { readonly: true });
  try {
    expect(after.prepare('SELECT id FROM companies WHERE workspace_id=? AND normalized_name=?').all('demo-northstar', 'hiddenpartnerholdings')).toHaveLength(1);
    expect((after.prepare('SELECT COUNT(*) AS count FROM companies WHERE workspace_id=?').get('demo-northstar') as { count: number }).count).toBe(beforeCounts.companies);
    expect((after.prepare('SELECT COUNT(*) AS count FROM contacts WHERE workspace_id=?').get('demo-northstar') as { count: number }).count).toBe(beforeCounts.contacts);
  } finally { after.close(); }
});

test('event-scoped managers cannot change the deal for an inaccessible company', async ({ page }) => {
  const databasePath = resolve(process.env.DATABASE_PATH ?? '');
  const db = new Database(databasePath);
  const hiddenCompanyId = randomUUID();
  try {
    db.transaction(() => {
      db.prepare("UPDATE memberships SET role='manager' WHERE workspace_id='demo-northstar' AND user_id='demo-rep'").run();
      db.prepare('INSERT INTO companies(id,workspace_id,name,normalized_name,website,normalized_domain,deal_value_minor,deal_status) VALUES (?,?,?,? ,\'\',\'\',?,?)')
        .run(hiddenCompanyId, 'demo-northstar', 'Restricted Deal Partner', 'restricteddealpartner', 250000, 'open');
    })();
  } finally { db.close(); }

  await page.goto('/');
  await page.getByRole('button', { name: /Jordan Lee/ }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: /Good morning, Jordan/ })).toBeVisible();
  const csrf = await page.evaluate(async () => await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json() as { csrfToken: string });
  const response = await page.evaluate(async ({ companyId, csrfToken }) => {
    const result = await fetch(`/api/companies/${companyId}/deal`, {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': 'demo-northstar', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ valueMinor: 999999, status: 'won' }),
    });
    return { status: result.status, body: await result.text() };
  }, { companyId: hiddenCompanyId, csrfToken: csrf.csrfToken });
  expect(response.status, response.body).toBe(404);

  const verify = new Database(databasePath, { readonly: true });
  try {
    expect(verify.prepare('SELECT deal_value_minor,deal_status FROM companies WHERE id=?').get(hiddenCompanyId))
      .toMatchObject({ deal_value_minor: 250000, deal_status: 'open' });
  } finally { verify.close(); }
});

test('keyboard users can open the camera, take a photo, and reach the review tray', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();

  async function tabToAccessibleName(name: string) {
    for (let step = 0; step < 60; step += 1) {
      await page.keyboard.press('Tab');
      const active = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element) return null;
        return {
          name: element.getAttribute('aria-label') || element.innerText?.trim().replace(/\s+/g, ' ') || '',
          outlineWidth: getComputedStyle(element).outlineWidth,
        };
      });
      if (active?.name === name) return active;
    }
    throw new Error(`Could not reach ${name} using Tab.`);
  }

  const cameraFocus = await tabToAccessibleName('Open camera');
  expect(parseFloat(cameraFocus.outlineWidth)).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Close camera' })).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await tabToAccessibleName('Take photo');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Review' }).first()).toBeVisible({ timeout: 15_000 });
});

test('concurrent captures add two people under one new company', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: /Good morning, Maya/ })).toBeVisible();
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const basePhoto = readFileSync(resolve('public/demo/sample-card.png'));
  const photos = [0, 1].map(() => Buffer.concat([basePhoto, Buffer.from(randomUUID())]));
  const workspaceId = 'demo-northstar';
  const companyName = `Concurrent Capture ${randomUUID().slice(0, 8)}`;
  const uploads = await Promise.all([randomUUID(), randomUUID()].map((clientScanId, index) => page.request.post('/api/scans', {
    data: photos[index],
    headers: { 'Content-Type': 'image/png', 'X-Client-Scan-Id': clientScanId, 'X-Scan-Source': 'gallery', 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': workspaceId },
  })));
  expect(uploads.map((response) => response.status())).toEqual([201, 201]);
  const scanIds = await Promise.all(uploads.map(async (response) => String(((await response.json()) as { scan: { id: string } }).scan.id)));
  await Promise.all(scanIds.map(async (scanId) => {
    await expect.poll(async () => ((await (await page.request.get(`/api/scans/${scanId}`)).json()) as { scan: { status: string } }).scan.status).toBe('ready');
  }));

  const saves = await Promise.all(scanIds.map((scanId, index) => page.request.post(`/api/scans/${scanId}/save`, {
    data: {
      name: `Concurrent Person ${index + 1}`, title: 'Buyer', company: companyName,
      email: `concurrent-${index + 1}-${companyName.slice(-8)}@example.test`,
      phone: `+1415555080${index}`, website: `https://${companyName.toLowerCase().replaceAll(' ', '-')}.example`,
      quality: null, note: '', followUpDate: null, productIds: [],
    },
    headers: { 'X-Workspace-Id': workspaceId, 'X-CSRF-Token': csrf.csrfToken },
  })));
  expect(saves.map((response) => response.status())).toEqual([200, 200]);
  expect(await Promise.all(saves.map((response) => response.json()))).toEqual([
    expect.objectContaining({ saved: true, duplicate: false }),
    expect.objectContaining({ saved: true, duplicate: false }),
  ]);

  const databasePath = resolve(process.env.DATABASE_PATH ?? '');
  const db = new Database(databasePath, { readonly: true });
  try {
    const companies = db.prepare('SELECT id FROM companies WHERE workspace_id=? AND name=?').all(workspaceId, companyName) as Array<{ id: string }>;
    expect(companies).toHaveLength(1);
    const contacts = db.prepare('SELECT id,company_id FROM contacts WHERE workspace_id=? AND email_normalized LIKE ?').all(workspaceId, `concurrent-%-${companyName.slice(-8)}@example.test`) as Array<{ id: string; company_id: string }>;
    expect(contacts).toHaveLength(2);
    expect(new Set(contacts.map((contact) => contact.company_id))).toEqual(new Set([companies[0].id]));
  } finally { db.close(); }
});

test('voice storage quota rejects a bounded upload before it is kept', async ({ page }) => {
  const databasePath = resolve(process.env.DATABASE_PATH ?? '');
  const quotaNoteIds = Array.from({ length: 21 }, () => randomUUID());
  const db = new Database(databasePath);
  try {
    const insert = db.prepare(`INSERT INTO notes(id,workspace_id,contact_id,kind,transcript_status,audio_bytes) VALUES (?,?,?,'audio','manual',?)`);
    db.transaction(() => {
      for (const noteId of quotaNoteIds) insert.run(noteId, 'demo-northstar', 'demo-ns-contact-1', 12 * 1024 * 1024);
    })();
  } finally { db.close(); }
  try {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const audio = Buffer.alloc(12 * 1024 * 1024);
  audio.set([0x1a, 0x45, 0xdf, 0xa3]);
  const response = await page.request.post('/api/contacts/demo-ns-contact-1/voice', {
    headers: { 'Content-Type': 'audio/webm', 'X-Recording-Seconds': '1', 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': 'demo-northstar' },
    data: audio,
  });
  expect(response.status()).toBe(413);
  expect((await response.json() as { code: string }).code).toBe('voice_storage_limit');
  } finally {
    const cleanup = new Database(databasePath);
    try { cleanup.prepare(`DELETE FROM notes WHERE id IN (${quotaNoteIds.map(() => '?').join(',')})`).run(...quotaNoteIds); }
    finally { cleanup.close(); }
  }
});

test('voice storage quota is shared across workspaces', async ({ page }) => {
  const databasePath = resolve(process.env.DATABASE_PATH ?? '');
  const quotaNoteId = randomUUID();
  const db = new Database(databasePath);
  try {
    db.prepare(`INSERT INTO notes(id,workspace_id,contact_id,kind,transcript_status,audio_bytes) VALUES (?,?,?,'audio','manual',?)`)
      .run(quotaNoteId, 'demo-sam-space', 'demo-sam-contact-1', 5 * 1024 * 1024 * 1024 - 1);
  } finally { db.close(); }
  try {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const audio = Buffer.alloc(128);
  audio.set([0x1a, 0x45, 0xdf, 0xa3]);
  const response = await page.request.post('/api/contacts/demo-ns-contact-1/voice', {
    headers: { 'Content-Type': 'audio/webm', 'X-Recording-Seconds': '1', 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': 'demo-northstar' },
    data: audio,
  });
  expect(response.status()).toBe(413);
  expect((await response.json() as { code: string }).code).toBe('voice_storage_limit');
  const verify = new Database(databasePath, { readonly: true });
  try {
    expect(verify.prepare(`SELECT COUNT(*) AS total FROM notes WHERE workspace_id='demo-northstar' AND kind='audio' AND audio_mime='audio/webm'`).get()).toMatchObject({ total: 0 });
  } finally { verify.close(); }
  } finally {
    const cleanup = new Database(databasePath);
    try { cleanup.prepare('DELETE FROM notes WHERE id=?').run(quotaNoteId); }
    finally { cleanup.close(); }
  }
});

test('knowledge settings save and the shell fits desktop and phone widths', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: /Good morning/ })).toBeVisible();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('What do you sell?').fill('Small-batch recyclable packaging.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').getByText('Your changes are saved.')).toBeVisible();
  await expect(page.getByText('Nothing needs your attention right now.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: 'Scan a card' }).last()).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Phone navigation' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'Scan', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('company invite links create scoped team access and removal takes effect immediately', async ({ page, browser, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Team access' })).toBeVisible();
  const openInvites = page.locator('.team-list').filter({ has: page.getByRole('heading', { name: 'Open invite links' }) });
  await expect(page.getByRole('button', { name: 'Create invite link' })).toBeVisible();
  const existingInviteCount = await openInvites.locator('.team-row').count();
  await page.getByLabel('Role').selectOption('representative');
  const eventChoice = page.locator('.team-event-choice').filter({ hasText: 'Pacific Packaging Expo' }).getByRole('checkbox');
  await eventChoice.check();
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const inviteLink = await page.getByLabel(/Share this link/).inputValue();
  expect(inviteLink).toContain('?invite=');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(inviteLink);
  await page.getByRole('button', { name: 'Create invite link' }).click();
  await expect(openInvites.locator('.team-row')).toHaveCount(existingInviteCount + 2);
  await openInvites.getByRole('button', { name: 'Cancel' }).first().click();
  await expect(openInvites.locator('.team-row')).toHaveCount(existingInviteCount + 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.profile-button').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Good to see you.' })).toBeVisible();

  const email = `invited-${Date.now()}@example.test`;
  await page.goto(inviteLink);
  await expect(page.getByText('You’re joining a company team.')).toBeVisible();
  await page.getByLabel('Your name').fill('Invited Representative');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('Gather-Invite-Test-2026!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Make Gather yours.' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip setup and go to Scan' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Reports' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Settings' })).toHaveCount(0);
  expect((await page.request.get('/api/workspace')).status()).toBe(200);
  expect((await page.request.get('/api/reports')).status()).toBe(403);

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await adminPage.goto('/');
  await adminPage.getByRole('button', { name: /Maya Chen/ }).click();
  await adminPage.getByRole('link', { name: 'Settings' }).click();
  const memberRow = adminPage.locator('.team-row').filter({ hasText: email });
  await expect(memberRow).toBeVisible();
  await memberRow.getByRole('button', { name: 'Edit access' }).click();
  await memberRow.locator('.member-access-editor').getByRole('button', { name: 'Cancel' }).click();
  await expect(memberRow.locator('.member-access-editor')).toHaveCount(0);
  await memberRow.getByRole('button', { name: 'Edit access' }).click();
  const accessEditor = memberRow.locator('.member-access-editor');
  await accessEditor.getByLabel('Role').selectOption('manager');
  await accessEditor.locator('.team-event-choice').filter({ hasText: 'Pacific Packaging Expo' }).getByRole('checkbox').uncheck();
  await accessEditor.locator('.team-event-choice').filter({ hasText: 'West Coast Retail Show' }).getByRole('checkbox').check();
  await adminPage.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => adminPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await adminPage.setViewportSize({ width: 1440, height: 1000 });
  await accessEditor.getByRole('button', { name: 'Save access' }).click();
  await expect(adminPage.getByRole('status').getByText('Team access updated.')).toBeVisible();
  await expect(memberRow).toContainText('manager');
  await expect(memberRow).toContainText('West Coast Retail Show');
  await expect(memberRow).not.toContainText('Pacific Packaging Expo');
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Reports' })).toBeVisible();
  expect((await page.request.get('/api/reports', { headers: { 'X-Workspace-Id': 'demo-northstar' } })).status()).toBe(200);
  const scopedContacts = ((await (await page.request.get('/api/contacts', { headers: { 'X-Workspace-Id': 'demo-northstar' } })).json()).people) as Array<{ id: string; name: string }>;
  expect(scopedContacts.map((person) => person.id)).toEqual(['demo-ns-contact-1']);
  adminPage.on('dialog', (dialog) => dialog.accept());
  await memberRow.getByRole('button', { name: 'Remove' }).click();
  await expect(memberRow).toHaveCount(0);
  await expect.poll(async () => (await page.request.get('/api/contacts', { headers: { 'X-Workspace-Id': 'demo-northstar' } })).status()).toBe(403);

  await adminContext.close();
});

test('company admins can create events, set dates and spend, and switch the active event', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Events', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add event' }).first().click();
  const eventName = `New Event ${Date.now()}`;
  await page.getByLabel('Event name').fill(eventName);
  await page.getByRole('textbox', { name: /Use a time zone name/ }).fill('America/Los_Angeles');
  await page.getByLabel('Starts').fill('2026-10-20');
  await page.getByLabel('Ends').fill('2026-10-22');
  await page.getByLabel('Event spend (USD)').fill('12345');
  await page.getByLabel('Make this the active event').check();
  await page.getByRole('button', { name: 'Add event' }).last().click();
  await expect(page.getByText(eventName).first()).toBeVisible();
  await expect(page.locator('.topbar-event')).toHaveText(eventName);
  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByText('Event spend: $12,345').first()).toBeVisible();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Pacific Packaging Expo/ }).first().click();
  await page.getByLabel('Make this the active event').check();
  await page.getByRole('button', { name: 'Save event' }).click();
  await expect(page.locator('.topbar-event')).toHaveText('Pacific Packaging Expo');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test('person detail edits detect stale changes and offer a reload', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/people/demo-ns-contact-1');
  await expect(page.getByRole('heading', { name: 'Tessa Morgan' })).toBeVisible();

  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  await secondPage.goto('/');
  await secondPage.getByRole('button', { name: /Maya Chen/ }).click();
  await secondPage.goto('/people/demo-ns-contact-1');
  await expect(secondPage.getByRole('heading', { name: 'Tessa Morgan' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit details' }).click();
  await page.getByLabel('Job title').fill('Version test title');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.locator('.person-view .page-lede')).toContainText('Version test title');

  await secondPage.getByRole('button', { name: 'Edit details' }).click();
  await secondPage.getByLabel('Job title').fill('Stale window title');
  await secondPage.getByRole('button', { name: 'Save details' }).click();
  await expect(secondPage.getByRole('alert')).toContainText('Someone else changed this. Reload to see the latest.');
  await secondPage.getByRole('button', { name: 'Reload person' }).click();
  await expect(secondPage.locator('.person-view .page-lede')).toContainText('Version test title');
  await secondPage.getByRole('button', { name: 'Edit details' }).click();
  await secondPage.getByLabel('Job title').fill('Procurement Director');
  await secondPage.getByRole('button', { name: 'Save details' }).click();
  await expect(secondPage.locator('.person-view .page-lede')).toContainText('Procurement Director');
  await secondPage.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => secondPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await secondContext.close();
});

test('photo upload starts reading immediately, reviews one lead, links repeat people, and saves next', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Create an account/ }).click();
  const suffix = `${Date.now()}`;
  await page.getByLabel('Your name').fill('Capture Tester');
  await page.getByLabel('Email', { exact: true }).fill(`capture-${suffix}@example.test`);
  await page.getByLabel('Password').fill('Gather-Capture-Test-2026!');
  await page.getByLabel('Company name').fill(`Capture Workspace ${suffix}`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Make Gather yours.' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip setup and go to Scan' }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();

  const image = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 840; canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ece8dd'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff'; ctx.fillRect(60, 60, 720, 360);
    ctx.fillStyle = '#202020'; ctx.font = 'bold 42px sans-serif'; ctx.fillText('Demo Contact', 100, 175);
    ctx.font = '28px sans-serif'; ctx.fillText('Packaging Buyer', 100, 225); ctx.fillText('Acme Packaging', 100, 280);
    ctx.fillText('demo.contact@sample.invalid', 100, 335);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', .9));
    const data = await blob.arrayBuffer();
    return btoa(String.fromCharCode(...new Uint8Array(data)));
  });
  const buffer = Buffer.from(image, 'base64');
  const imageVariant = async (marker: number) => Buffer.from(await page.evaluate(async ({ image, marker }) => {
    const photo = new Image(); photo.src = `data:image/jpeg;base64,${image}`; await photo.decode();
    const canvas = document.createElement('canvas'); canvas.width = photo.width; canvas.height = photo.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(photo, 0, 0);
    ctx.fillStyle = `rgb(${marker * 23 % 255},${marker * 47 % 255},${marker * 71 % 255})`;
    ctx.fillRect(canvas.width - 12, canvas.height - 12, 7, 7);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', .9));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  }, { image, marker }), 'base64');
  const input = page.locator('#capture-gallery');
  const started = Date.now();
  const uploadResponse = page.waitForResponse((response) => response.url().includes('/api/scans') && response.request().method() === 'POST');
  await input.setInputFiles({ name: 'business-card.jpg', mimeType: 'image/jpeg', buffer });
  const uploaded = await uploadResponse;
  expect(uploaded.status()).toBe(201);
  expect((await uploaded.json() as { scan: { status: string } }).scan.status).toBe('queued');
  await expect(page).toHaveURL(/\/review\//);
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact', { timeout: 15000 });
  const readyMs = Date.now() - started;
  await expect(page.getByRole('button', { name: 'Save & scan next' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save & prepare email' })).toBeVisible();
  const reviewSurface = await page.locator('.review-dialog-page').evaluate((dialog) => {
    const background = getComputedStyle(dialog).backgroundColor;
    const footer = dialog.querySelector('.review-footer');
    return { background, footerPosition: footer ? getComputedStyle(footer).position : '' };
  });
  expect(reviewSurface.background).toBe('rgb(245, 244, 240)');
  expect(reviewSurface.footerPosition).toBe('static');
  const reviewActionsStayTogether = async () => {
    const layout = await page.locator('.review-save-actions').evaluate((group) => {
      const groupBox = group.getBoundingClientRect();
      const buttons = [...group.querySelectorAll('button')].map((button) => ({ box: button.getBoundingClientRect(), background: getComputedStyle(button).backgroundColor }));
      return { groupWidth: groupBox.width, groupRight: groupBox.right, buttons: buttons.map(({ box, background }) => ({ x: box.x, y: box.y, width: box.width, right: box.right, background })) };
    });
    expect(layout.buttons).toHaveLength(3);
    const [first, , next] = layout.buttons;
    expect(next.right).toBeLessThanOrEqual(layout.groupRight + 1);
    expect(next.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(next.y === first.y || next.width >= layout.groupWidth - 1).toBe(true);
  };
  await reviewActionsStayTogether();
  await page.locator('.review-footer--choice').screenshot({ path: testInfo.outputPath('review-actions-desktop.png') });
  await page.setViewportSize({ width: 1024, height: 800 });
  await reviewActionsStayTogether();
  await page.locator('.review-footer--choice').screenshot({ path: testInfo.outputPath('review-actions-compact.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.review-footer')).toBeVisible();
  await expect(page.locator('.mobile-review-actions')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save & scan next' })).toHaveCount(1);
  await page.locator('.review-dialog-page').evaluate((dialog) => { dialog.scrollTop = 0; });
  expect(await page.locator('.review-footer').evaluate((footer) => footer.getBoundingClientRect().top)).toBeGreaterThan(844);
  await page.locator('.review-footer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('review-phone-actions-inline.png') });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact');
  await page.getByLabel('Company').fill('Acme Packaging');
  await page.getByLabel('Email').fill('demo.contact@sample.invalid');
  await page.getByLabel('Conversation note').fill('Met at the booth; asked for a short-run sample.');
  await page.getByLabel('Lead temperature').selectOption('warm');
  const followUpInput = page.getByLabel('Next follow-up date');
  await expect(followUpInput).not.toHaveValue('');
  await page.getByRole('button', { name: 'In 2 days' }).click();
  const chosenFollowUpDate = await followUpInput.inputValue();
  await page.getByRole('button', { name: 'Save person' }).click();
  await expect(page.getByText('Saved to your space')).toBeVisible();
  expect(await (await page.request.get('/api/onboarding')).json()).toMatchObject({ state: { completed: ['capture'], skipped: ['knowledge', 'email'] } });
  await expect(page.getByLabel('Subject')).toHaveValue(/Following up/);
  await expect(page.locator('.email-sources')).toContainText('Latest conversation');
  await expect(page.locator('.email-compose textarea')).toHaveValue(/short-run sample/);
  await page.getByRole('button', { name: 'Try another version' }).click();
  await expect(page.getByLabel('Subject')).toHaveValue(/A quick note about Acme Packaging/);
  await expect(page.locator('.email-sources')).toContainText('short-run sample');
  const savedTasks = await (await page.request.get('/api/tasks')).json() as { tasks: Array<{ title: string; due_at: string; time_zone: string; contact_name: string }> };
  const leadFollowUp = savedTasks.tasks.find((task) => task.contact_name === 'Demo Contact');
  expect(leadFollowUp).toMatchObject({ time_zone: 'UTC', contact_name: 'Demo Contact' });
  expect(leadFollowUp?.due_at).toBe(`${chosenFollowUpDate}T09:00:00.000Z`);
  const exportResponse = await page.request.get('/api/export/data.json');
  expect(exportResponse.status()).toBe(200);
  const exported = await exportResponse.json() as { format: string; data: { workspace: { name: string }; contacts: Array<{ name: string }>; scans: Array<{ status: string }> }; media: Array<{ kind: string; available: boolean; contentBase64?: string }> };
  expect(exported.format).toBe('gather-data-export');
  expect(exported.data.workspace.name).toContain('Capture Workspace');
  expect(exported.data.contacts.some((contact) => contact.name === 'Demo Contact')).toBe(true);
  expect(exported.media.some((media) => media.kind === 'scan_photo' && media.available && Boolean(media.contentBase64))).toBe(true);
  await page.getByRole('textbox', { name: 'Message' }).fill('Thanks for meeting. This revised draft is not sent without a configured mail server.');
  await page.getByRole('button', { name: 'Send email' }).click();
  await expect(page.locator('.email-state')).toContainText('No mail server');
  await page.getByRole('button', { name: 'Next item' }).click();

  await page.locator('.profile-button').click();
  await page.getByRole('button', { name: 'Never ask' }).click();
  await expect(page.getByRole('button', { name: 'Never ask' })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.profile-button').click();

  await input.setInputFiles({ name: 'repeat-business-card.jpg', mimeType: 'image/jpeg', buffer });
  await expect(page).toHaveURL(/\/people\//, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Demo Contact' })).toBeVisible();
  await expect(page.getByLabel('What did you discuss?')).toBeFocused();
  await page.getByLabel('What did you discuss?').fill('Spoke again later and asked for updated sample timing.');
  await page.getByRole('button', { name: 'Add conversation' }).click();
  await expect(page.locator('.timeline-item').getByText('Spoke again later and asked for updated sample timing.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'Scan a card' }).first().click();
  const thirdUpload = page.waitForRequest((request) => request.url().includes('/api/scans') && request.method() === 'POST');
  await input.setInputFiles({ name: 'similar-company-card.jpg', mimeType: 'image/jpeg', buffer: await imageVariant(1) });
  await thirdUpload;
  await expect(page).toHaveURL(/\/review\//);
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact', { timeout: 15000 });
  await page.getByLabel('Name *').fill('Rae Sample');
  await page.getByLabel('Company').fill('Acme Packagng');
  await page.getByLabel('Email').fill(`rae-${suffix}@newvendor.example`);
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('');
  await page.getByLabel('Website').fill('');
  await page.getByRole('button', { name: 'Save person' }).click();
  await expect(page.getByRole('group', { name: 'Possible existing company' })).toBeVisible();
  await page.getByRole('button', { name: 'Choose', exact: false }).filter({ hasText: 'Acme Packaging' }).click();
  await page.getByRole('button', { name: 'Use selected company' }).click();
  await page.getByRole('button', { name: 'Save & scan next' }).click();
  await expect(page.getByRole('heading', { name: /Keep the next conversation/ })).toBeVisible();
  await page.getByRole('button', { name: 'Email now' }).click();
  const emailNowDialog = page.getByRole('dialog', { name: 'Email this person' });
  await expect(emailNowDialog).toBeVisible();
  await expect(emailNowDialog.getByLabel('Subject')).toHaveValue(/Following up/);
  await emailNowDialog.getByRole('button', { name: 'Skip' }).click();
  await expect(emailNowDialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Keep the next conversation/ })).toBeVisible();
  const batchFiles = await Promise.all(Array.from({ length: 5 }, async (_, index) => ({ name: `batch-card-${index + 1}.jpg`, mimeType: 'image/jpeg', buffer: await imageVariant(index + 2) })));
  await page.evaluate(() => {
    const ids: string[] = [];
    const original = window.crypto.randomUUID.bind(window.crypto);
    Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: () => { const id = original(); ids.push(id); return id; } });
    (window as unknown as { gatherTestScanOrder: string[] }).gatherTestScanOrder = ids;
  });
  const batchStarted = Date.now();
  const batchResponses = Array.from({ length: batchFiles.length }, () => page.waitForResponse((response) => response.url().includes('/api/scans') && response.request().method() === 'POST' && response.status() === 201));
  await input.setInputFiles(batchFiles);
  const expectedBatchOrder = await page.evaluate(() => (window as unknown as { gatherTestScanOrder: string[] }).gatherTestScanOrder);
  expect(expectedBatchOrder).toHaveLength(5);
  const uploadedBatch = await Promise.all(batchResponses);
  expect(uploadedBatch.map((response) => response.status())).toEqual(Array(5).fill(201));
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(5, { timeout: 15_000 });
  const trayOrder = await page.locator('.tray-item').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-client-scan-id')));
  expect(trayOrder.filter((id): id is string => Boolean(id && expectedBatchOrder.includes(id)))).toEqual(expectedBatchOrder);
  const batchReadyMs = Date.now() - batchStarted;
  await page.getByRole('button', { name: 'Review', exact: true }).first().click();
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact');
  await page.getByRole('link', { name: 'Back to cards' }).click();
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(5);
  const reopenedTrayOrder = await page.locator('.tray-item').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-client-scan-id')));
  expect(reopenedTrayOrder.filter((id): id is string => Boolean(id && expectedBatchOrder.includes(id)))).toEqual(expectedBatchOrder);
  console.info(`Five-photo batch upload-to-review-ready: ${batchReadyMs} ms (local test reader, not live AI).`);
  console.info(`Capture image upload-to-review-ready: ${readyMs} ms (local test reader, not live AI).`);
});

test('review can save product interests and a manual-text voice note', async ({ page, context }) => {
  await context.grantPermissions(['microphone']);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  const canvasImage = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 840; canvas.height = 480;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#202020'; context.font = 'bold 40px sans-serif'; context.fillText('Kai Rivera', 70, 150);
    context.font = '27px sans-serif'; context.fillText('Purchasing Manager', 70, 205); context.fillText('Acme Packaging', 70, 260);
    context.fillText('kai-interest@example.test', 70, 315);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', .9));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });
  const uploadPromise = page.waitForResponse((response) => response.url().includes('/api/scans') && response.request().method() === 'POST');
  await page.locator('#capture-gallery').setInputFiles({ name: 'kai-card.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(canvasImage, 'base64') });
  const uploaded = await uploadPromise;
  const uploadData = await uploaded.json() as { scan: { status: string } };
  expect(uploadData.scan.status).toBe('queued');
  await expect(page).toHaveURL(/\/review\//);
  await expect(page.getByLabel('Name *')).toBeVisible({ timeout: 15000 });
  const cartons = page.getByRole('button', { name: 'Flexible cartons' });
  await expect(cartons).toBeVisible();
  await cartons.click();
  await expect(cartons).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Record voice note' }).click();
  await expect(page.getByText(/Recording ·/)).toBeVisible();
  await page.waitForTimeout(1300);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByText('Keep this card open, then save the person to attach this note.')).toBeVisible();
  await page.getByLabel('Text you typed (optional)').fill('Kai asked me to send the sample details.');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Name *').fill('Kai Rivera');
  await page.getByLabel('Company').fill('Acme Packaging');
  await page.getByLabel('Email').fill('kai-interest@example.test');
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('');
  await page.getByRole('button', { name: 'Save person' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Voice note and your text are saved' })).toBeVisible();
  await expect(page.locator('.email-sources')).toContainText('Products of interest');
  await expect(page.locator('.email-sources')).toContainText('Flexible cartons');
  await expect(page.locator('.email-sources')).toContainText('Kai asked me to send the sample details.');
  await expect(page.getByRole('status').filter({ hasText: 'Template draft' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();
  const searchResponse = await page.request.get(`/api/contacts?q=${encodeURIComponent('kai-interest@example.test')}`);
  expect(searchResponse.status()).toBe(200);
  const search = await searchResponse.json() as { people: Array<{ id: string; email: string; products: string }> };
  const savedLead = search.people.find((person) => person.email === 'kai-interest@example.test');
  expect(savedLead?.products).toContain('Flexible cartons');
  expect(savedLead).toBeDefined();
  const detailResponse = await page.request.get(`/api/contacts/${savedLead!.id}`);
  expect(detailResponse.status()).toBe(200);
  const person = await detailResponse.json() as { products: Array<{ id: string; name: string }>; voiceNotes: Array<{ transcript: string }> };
  expect(person.products).toContainEqual(expect.objectContaining({ id: 'demo-product-carton', name: 'Flexible cartons' }));
  expect(person.voiceNotes).toContainEqual(expect.objectContaining({ transcript: 'Kai asked me to send the sample details.' }));
});

test('people, company hierarchy, contact notes, stage updates, Help, and tour controls work', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Show me around' }).click();
  const tour = page.getByRole('dialog', { name: /Capture one card at a time/ });
  await expect(tour).toBeVisible();
  for (const title of ['Check every detail.', 'Keep the useful context.', 'Choose what happens next.', 'Make a clear next step.', 'Keep each space separate.']) {
    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.getByRole('dialog', { name: title })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByRole('dialog', { name: 'Make a clear next step.' })).toBeVisible();
  await page.getByRole('button', { name: 'Next step' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Help' }).click();
  await expect(page.getByRole('dialog', { name: /Keep the next conversation/ })).toBeVisible();
  await expect(page.getByText('Reading starts when it uploads.')).toBeVisible();
  await expect(page.getByText('A reminder date you choose.')).toBeVisible();
  await page.getByRole('button', { name: 'Close help' }).click();
  await page.getByRole('link', { name: 'People', exact: true }).first().click();
  await page.getByLabel('Search companies and people').fill('Tessa Morgan');
  await page.getByRole('link', { name: /Tessa Morgan/ }).click();
  await expect(page.getByRole('heading', { name: 'Tessa Morgan' })).toBeVisible();
  await expect(page.locator('.suggestion-message')).toContainText('AI suggestions are not set up');
  await page.getByLabel('Change stage').selectOption('meeting');
  await page.getByLabel('What did you discuss?').fill('Confirmed a follow-up after the show.');
  await page.getByRole('button', { name: 'Add conversation' }).click();
  await expect(page.locator('.timeline-item').getByText('Confirmed a follow-up after the show.').first()).toBeVisible();
  await page.getByLabel('Change stage').selectOption('lost');
  await expect(page.getByLabel('Why was this marked lost?')).toBeVisible();
  await page.getByLabel('Why was this marked lost?').fill('Budget timing changed.');
  await page.getByRole('button', { name: 'Save as lost' }).click();
  await expect(page.locator('.lost-reason-display')).toContainText('Budget timing changed.');
  await page.getByLabel('Change stage').selectOption('contacted');
  await page.getByRole('button', { name: 'They replied' }).click();
  await expect(page.locator('.person-card .stage-pill')).toHaveText('Replied');
  await expect(page.locator('.timeline-item').getByText('You marked that they replied').first()).toBeVisible();
  await page.getByRole('link', { name: 'Companies' }).click();
  await expect(page.getByRole('heading', { name: 'One company, many people.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Acme Packaging' }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Follow-ups' }).first().click();
  await expect(page.getByRole('heading', { name: /Keep the next step/ })).toBeVisible();
  const followUp = page.locator('.task-row').filter({ hasText: 'Send sample options' });
  await expect(followUp).toBeVisible();
  await followUp.getByRole('button', { name: '1 day' }).click();
  await expect(followUp).toContainText('moved');
  await followUp.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.task-group').filter({ has: page.getByRole('heading', { name: 'Done' }) }).getByText('Send sample options')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('archiving keeps a person history and is distinct from permanent deletion', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'People', exact: true }).first().click();
  const original = await (await page.request.get('/api/contacts/demo-ns-contact-1')).json() as { person: { id: string }; timeline: Array<{ id: string }>; voiceNotes: Array<{ id: string }> };
  expect(original.voiceNotes.length).toBeGreaterThan(0);
  const dashboardBefore = await (await page.request.get('/api/dashboard')).json() as { counts: { captured_today: number; follow_ups_due: number } };

  await page.goto('/people/demo-ns-contact-1');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Archive person' }).click();
  await expect(page).toHaveURL(/\/people\?archived=1$/);
  const hidden = await page.request.get('/api/contacts/demo-ns-contact-1');
  expect(hidden.status()).toBe(404);
  const active = await (await page.request.get('/api/contacts')).json() as { people: Array<{ id: string }> };
  expect(active.people.some((person) => person.id === 'demo-ns-contact-1')).toBe(false);
  const dashboardArchived = await (await page.request.get('/api/dashboard')).json() as { counts: { captured_today: number; follow_ups_due: number } };
  expect(dashboardArchived.counts.captured_today).toBe(dashboardBefore.counts.captured_today - 1);
  expect(dashboardArchived.counts.follow_ups_due).toBe(dashboardBefore.counts.follow_ups_due - 1);
  const archived = await (await page.request.get('/api/contacts?archived=true')).json() as { people: Array<{ id: string; name: string }> };
  expect(archived.people).toContainEqual(expect.objectContaining({ id: 'demo-ns-contact-1', name: 'Tessa Morgan' }));
  await expect(page.getByText('Tessa Morgan', { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('No archived people.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Show active people' }).click();
  await expect(page.getByRole('link', { name: /Tessa Morgan/ })).toBeVisible();
  const restored = await (await page.request.get('/api/contacts/demo-ns-contact-1')).json() as { timeline: Array<{ id: string }>; voiceNotes: Array<{ id: string }> };
  const dashboardRestored = await (await page.request.get('/api/dashboard')).json() as { counts: { captured_today: number; follow_ups_due: number } };
  expect(dashboardRestored.counts).toEqual(dashboardBefore.counts);
  expect(restored.timeline.map((item) => item.id)).toEqual(original.timeline.map((item) => item.id));
  expect(restored.voiceNotes.map((item) => item.id)).toEqual(original.voiceNotes.map((item) => item.id));
  expect((await page.request.get(`/api/notes/${original.voiceNotes[0]!.id}/audio`)).status()).toBe(200);
  const exported = await (await page.request.get('/api/export/data.json')).json() as { data: { auditEvents: Array<{ action: string; target_id: string }> } };
  expect(exported.data.auditEvents.some((event) => event.action === 'contact_archived' && event.target_id === 'demo-ns-contact-1')).toBe(true);
  expect(exported.data.auditEvents.some((event) => event.action === 'contact_restored' && event.target_id === 'demo-ns-contact-1')).toBe(true);
});

test('attendee spaces only show their own people and cannot select a company workspace', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Sam Patel/ }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Companies' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Reports' })).toHaveCount(0);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await expect(page.getByRole('link', { name: /Morgan Ellis/ })).toBeVisible();
  await expect(page.getByText('Tessa Morgan')).toHaveCount(0);
  const forbiddenWorkspaceStatus = await page.evaluate(async () => (await fetch('/api/contacts', { headers: { 'X-Workspace-Id': 'demo-northstar' } })).status);
  expect(forbiddenWorkspaceStatus).toBe(403);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('button', { name: 'Export my data' })).toBeVisible();
  const exportRequest = page.waitForRequest((request) => request.url().endsWith('/api/export/data.json'));
  const exportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export my data' }).click();
  const requestForExport = await exportRequest;
  expect(requestForExport.headers()['x-workspace-id']).toBe('demo-sam-space');
  expect((await exportDownload).suggestedFilename()).toBe('gather-personal-export.json');
  const privateExportResponse = await page.request.get('/api/export/data.json', { headers: { 'X-Workspace-Id': 'demo-sam-space' } });
  expect(privateExportResponse.status()).toBe(200);
  const privateExport = await privateExportResponse.json() as { data: { workspace: { kind: string }; contacts: Array<{ name: string }>; companies: Array<{ name: string }> } };
  expect(privateExport.data.workspace.kind).toBe('personal');
  expect(privateExport.data.contacts.some((person) => person.name === 'Morgan Ellis')).toBe(true);
  expect(privateExport.data.contacts.some((person) => person.name === 'Tessa Morgan')).toBe(false);
  expect(privateExport.data.companies.some((company) => company.name === 'Northstar Packaging')).toBe(false);
});

test('voice notes save, play back, accept manual text only, and can be deleted', async ({ page, context }) => {
  await context.grantPermissions(['microphone']);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'People' }).click();
  await page.getByRole('link', { name: /Tessa Morgan/ }).click();
  const initialPersonDetail = await (await page.request.get('/api/contacts/demo-ns-contact-1')).json() as { voiceNotes: Array<{ id: string }> };
  const originalVoiceCount = initialPersonDetail.voiceNotes.length;
  await page.getByRole('button', { name: 'Record voice note' }).click();
  await expect(page.getByText(/Recording ·/)).toBeVisible();
  await page.waitForTimeout(1300);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByRole('button', { name: 'Save voice note' })).toBeVisible();
  await page.getByRole('button', { name: 'Save voice note' }).click();
  await expect(page.getByText(/No automatic transcript was made/)).toBeVisible();
  await expect(page.locator('.saved-voice')).toHaveCount(originalVoiceCount + 1);
  const newRecording = page.locator('.saved-voice').first();
  await expect(newRecording.locator('audio')).toBeVisible();
  const exportData = await (await page.request.get('/api/export/data.json')).json() as { media: Array<{ kind: string; available: boolean; contentBase64?: string }> };
  expect(exportData.media.some((media) => media.kind === 'voice_note' && media.available && Boolean(media.contentBase64))).toBe(true);
  const playbackStatus = await newRecording.locator('audio').evaluate(async (audio) => {
    const response = await fetch((audio as HTMLAudioElement).src, { credentials: 'same-origin' }); return response.status;
  });
  expect(playbackStatus).toBe(200);
  await newRecording.getByLabel('Text you typed').fill('Typed manually after the event.');
  await newRecording.getByLabel('Text you typed').press('Tab');
  await expect(page.locator('.timeline-item').getByText('Typed manually after the event.')).toBeVisible();
  await page.getByRole('button', { name: 'Draft an email' }).click();
  await expect(page.locator('.email-sources')).toContainText('Typed manually after the event.');
  await expect(page.locator('.email-compose textarea')).toHaveValue(/Typed manually after the event/);
  page.on('dialog', (dialog) => dialog.accept());
  await newRecording.getByRole('button', { name: 'Delete recording' }).click();
  await expect(page.locator('.saved-voice')).toHaveCount(originalVoiceCount);
});

test('follow-ups snooze, complete, and meetings warn on overlap and can be confirmed or marked no-show', async ({ page, context }) => {
  const testToken = `${Date.now()}`;
  await context.grantPermissions(['microphone']);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'People', exact: true }).first().click();
  await page.getByLabel('Search companies and people').fill('Tessa Morgan');
  await page.getByRole('link', { name: /Tessa Morgan/ }).click();

  const day = await page.evaluate(() => {
    const date = new Date(Date.now() + (14 + Math.floor(Math.random() * 180)) * 86400000);
    date.setHours(8 + Math.floor(Math.random() * 10), Math.floor(Math.random() * 60), 0, 0);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  });
  await page.getByLabel('What would you like to add?').selectOption('meeting');
  await page.getByLabel('Meeting time').fill(day);
  await page.getByLabel('Note (optional)').fill(`Overlap check ${testToken}`);
  await page.getByRole('button', { name: 'Add meeting' }).click();
  await expect(page.getByRole('status').getByText('Meeting added to this person.')).toBeVisible();
  await page.getByRole('link', { name: 'Follow-ups' }).first().click();
  const proposedMeeting = page.locator('.task-row').filter({ hasText: `Overlap check ${testToken}` });
  await proposedMeeting.getByRole('button', { name: 'Confirm' }).click();
  await expect(proposedMeeting).toContainText('Confirmed');

  await page.getByRole('link', { name: 'People', exact: true }).first().click();
  await page.getByLabel('Search companies and people').fill('Noah Price');
  await page.getByRole('link', { name: /Noah Price/ }).click();
  await page.getByLabel('What would you like to add?').selectOption('meeting');
  await page.getByLabel('Meeting time').fill(day);
  await page.getByLabel('Note (optional)').fill(`Second meeting ${testToken}`);
  await page.getByRole('button', { name: 'Add meeting' }).click();
  await expect(page.getByRole('alert')).toContainText('overlaps with a confirmed meeting for Tessa Morgan');
  await page.getByRole('button', { name: 'Save meeting anyway' }).click();
  await expect(page.getByRole('status').getByText('Meeting added to this person.')).toBeVisible();

  await page.getByLabel('What would you like to add?').selectOption('follow_up');
  const later = await page.evaluate(() => {
    const date = new Date(Date.now() + 8 * 86400000);
    date.setHours(10, 0, 0, 0);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  });
  await page.getByLabel('Follow-up time').fill(later);
  await page.getByLabel('Note (optional)').fill(`Follow-up test ${testToken}`);
  await page.getByRole('button', { name: 'Add follow-up' }).click();
  await expect(page.getByRole('status').getByText('Follow-up added to this person.')).toBeVisible();
  await page.getByRole('button', { name: 'Draft an email' }).click();
  await expect(page.getByLabel('Subject')).toBeVisible();
  await page.getByRole('button', { name: 'Send email' }).click();
  await expect(page.locator('.email-state')).toContainText('nothing was sent');
  await expect(page.getByRole('link', { name: 'Open in my email app' })).toHaveAttribute('href', /^mailto:/);
  await expect(page.getByRole('button', { name: 'Copy email' })).toBeVisible();

  await page.getByRole('link', { name: 'Follow-ups' }).click();
  const followUpRow = page.locator('.task-row').filter({ hasText: `Follow-up test ${testToken}` });
  await expect(followUpRow).toBeVisible();
  await followUpRow.getByRole('button', { name: 'Record voice note' }).click();
  await expect(followUpRow.getByText(/Recording ·/)).toBeVisible();
  await page.waitForTimeout(1300);
  await followUpRow.getByRole('button', { name: 'Stop recording' }).click();
  await followUpRow.getByRole('button', { name: 'Save voice note' }).click();
  await expect(followUpRow.getByRole('status')).toContainText('No automatic transcript was made');
  await followUpRow.getByRole('button', { name: '3 days' }).click();
  await expect(followUpRow).toContainText('moved');
  await followUpRow.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.task-group').filter({ has: page.getByRole('heading', { name: 'Done' }) }).getByText(`Follow-up test ${testToken}`)).toBeVisible();

  const meetingRow = page.locator('.task-row').filter({ hasText: `Overlap check ${testToken}` }).filter({ hasText: 'Confirmed' });
  await expect(meetingRow).toBeVisible();
  await meetingRow.getByRole('button', { name: 'No-show' }).click();
  await expect(page.locator('.task-row').filter({ hasText: `Overlap check ${testToken}` }).filter({ hasText: 'No-show' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('private-space data deletion requires confirmation and removes its searchable records and media', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Riley Morgan/ }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Clear this private space.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete private-space data' })).toBeDisabled();

  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const fakeAudio = Buffer.alloc(128);
  fakeAudio.set([0x1a, 0x45, 0xdf, 0xa3]);
  const savedAudio = await page.request.post('/api/contacts/demo-riley-contact-1/voice', {
    data: fakeAudio,
    headers: { 'Content-Type': 'audio/webm', 'X-Recording-Seconds': '1', 'X-CSRF-Token': csrf.csrfToken },
  });
  expect(savedAudio.status()).toBe(201);
  const audio = await savedAudio.json() as { id: string };
  const refusedDeletion = await page.request.post('/api/settings/delete-my-data', {
    data: { confirmation: 'delete' }, headers: { 'X-CSRF-Token': csrf.csrfToken },
  });
  expect(refusedDeletion.status()).toBe(400);
  expect((await (await page.request.get('/api/contacts')).json() as { people: unknown[] }).people).toHaveLength(1);

  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await page.getByRole('button', { name: 'Delete private-space data' }).click();
  await expect(page.getByRole('heading', { name: 'Good morning, Riley.' })).toBeVisible();
  const [people, companies, scans, tasks, settings, exportResponse, playback] = await Promise.all([
    page.request.get('/api/contacts'), page.request.get('/api/companies'), page.request.get('/api/scans'),
    page.request.get('/api/tasks'), page.request.get('/api/settings'), page.request.get('/api/export/data.json'),
    page.request.get(`/api/notes/${audio.id}/audio`),
  ]);
  const exported = await exportResponse.json() as { data: { auditEvents: Array<{ action: string }> }; media: unknown[] };
  expect((await people.json() as { people: unknown[] }).people).toHaveLength(0);
  expect((await companies.json() as { companies: unknown[] }).companies).toHaveLength(0);
  expect((await scans.json() as { scans: unknown[] }).scans).toHaveLength(0);
  expect((await tasks.json() as { tasks: unknown[] }).tasks).toHaveLength(0);
  expect(await settings.json()).toEqual({ knowledge: null, aboutMe: null, email: null, capture: null, reminders: null, onboarding: null, draftAutomation: null });
  expect(exported.data.auditEvents.map((entry) => entry.action)).toEqual(['data_deleted']);
  expect(exported.media).toHaveLength(0);
  expect(playback.status()).toBe(404);
});

test('deleting one person removes their history and media but keeps their shared company and coworkers', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const imageBase64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 48;
    const context = canvas.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, 80, 48);
    context.fillStyle = '#222'; context.font = '10px sans-serif'; context.fillText('Tessa Morgan', 4, 22);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg'));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });
  const clientScanId = crypto.randomUUID();
  const uploaded = await page.request.post('/api/scans', {
    data: Buffer.from(imageBase64, 'base64'),
    headers: { 'Content-Type': 'image/jpeg', 'X-Client-Scan-Id': clientScanId, 'X-Scan-Source': 'gallery', 'X-CSRF-Token': csrf.csrfToken },
  });
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const scanId = String(((await uploaded.json()) as { scan: { id: string } }).scan.id);
  await expect.poll(async () => ((await page.request.get(`/api/scans/${scanId}`)).json() as Promise<{ scan: { status: string } }>).then((result) => result.scan.status)).toBe('ready');
  const qrUpdate = await page.request.post(`/api/scans/${scanId}/qr`, {
    data: { name: 'Tessa Morgan', title: 'Procurement Director', company: 'Acme Packaging', email: 'tessa@acmepackaging.example', phone: '+1 415 555 0121', website: '', products: [], topics: [], uncertain: [] },
    headers: { 'X-CSRF-Token': csrf.csrfToken },
  });
  expect(qrUpdate.status()).toBe(200);
  const saved = await page.request.post(`/api/scans/${scanId}/save`, {
    data: { name: 'Tessa Morgan', title: 'Procurement Director', company: 'Acme Packaging', email: 'tessa@acmepackaging.example', phone: '+1 415 555 0121', website: '', quality: null, note: 'Private note for removal test.', followUpDate: null, samePersonContactId: 'demo-ns-contact-1' },
    headers: { 'X-CSRF-Token': csrf.csrfToken },
  });
  expect(saved.status()).toBe(200);
  expect((await saved.json() as { saved: boolean; duplicate: boolean }).saved).toBe(true);
  const audio = Buffer.alloc(128); audio.set([0x1a, 0x45, 0xdf, 0xa3]);
  const voice = await page.request.post('/api/contacts/demo-ns-contact-1/voice', {
    data: audio, headers: { 'Content-Type': 'audio/webm', 'X-Recording-Seconds': '1', 'X-CSRF-Token': csrf.csrfToken },
  });
  expect(voice.status()).toBe(201);
  const voiceId = String((await voice.json() as { id: string }).id);
  const before = await (await page.request.get('/api/export/data.json')).json() as { media: Array<{ kind: string; recordId: string; available: boolean }> };
  expect(before.media.some((item) => item.kind === 'scan_photo' && item.recordId === scanId && item.available)).toBe(true);
  expect(before.media.some((item) => item.kind === 'voice_note' && item.recordId === voiceId && item.available)).toBe(true);

  await page.goto('/people/demo-ns-contact-1');
  await expect(page.getByRole('heading', { name: 'Tessa Morgan' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete person' })).toBeDisabled();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await page.getByRole('button', { name: 'Delete person' }).click();
  await expect(page.getByRole('heading', { name: 'Keep the person close to the conversation.' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Tessa Morgan/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Noah Price/ })).toBeVisible();
  await expect(page.getByText('Acme Packaging', { exact: true }).first()).toBeVisible();
  const [search, exportResponse, deletedImage, deletedAudio] = await Promise.all([
    page.request.get('/api/contacts?q=Tessa'), page.request.get('/api/export/data.json'),
    page.request.get(`/api/scans/${scanId}/image`), page.request.get(`/api/notes/${voiceId}/audio`),
  ]);
  expect((await search.json() as { people: unknown[] }).people).toHaveLength(0);
  expect(deletedImage.status()).toBe(404);
  expect(deletedAudio.status()).toBe(404);
  const after = await exportResponse.json() as { data: { contacts: Array<{ name: string }>; companies: Array<{ name: string }>; notes: Array<{ body: string }>; auditEvents: Array<{ action: string }> }; media: Array<{ recordId: string }> };
  expect(after.data.contacts.some((person) => person.name === 'Tessa Morgan')).toBe(false);
  expect(after.data.contacts.some((person) => person.name === 'Noah Price')).toBe(true);
  expect(after.data.companies.some((company) => company.name === 'Acme Packaging')).toBe(true);
  expect(after.data.notes.some((entry) => entry.body === 'Private note for removal test.')).toBe(false);
  expect(after.media.some((item) => item.recordId === scanId || item.recordId === voiceId)).toBe(false);
  expect(after.data.auditEvents.some((item) => item.action === 'contact_deleted')).toBe(true);
});

test('due follow-ups create an in-app reminder and an honest daily digest status', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'People', exact: true }).first().click();
  await page.getByLabel('Search companies and people').fill('June Kim');
  await page.getByRole('link', { name: /June Kim/ }).click();
  const pastLocalTime = await page.evaluate(() => {
    const date = new Date(Date.now() - 86400000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T00:00`;
  });
  const followUpTime = page.getByLabel('Follow-up time');
  await expect(followUpTime).toHaveValue(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  await followUpTime.fill(pastLocalTime);
  await page.getByRole('button', { name: 'Add follow-up' }).click();
  await expect(page.getByRole('status').getByText('Follow-up added to this person.')).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.locator('.reminder-choice').nth(0).locator('input').check();
  await page.locator('.reminder-choice').nth(1).locator('input').check();
  await page.locator('.reminder-fields input[type=time]').fill('00:00');
  await page.locator('.reminder-fields label').filter({ hasText: 'Time zone' }).locator('input').fill('UTC');
  await page.getByRole('button', { name: 'Save reminders' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();

  await expect.poll(async () => {
    const value = await (await page.request.get('/api/notifications')).json() as { notifications: Array<{ contact_id: string; read_at: string | null }> };
    return value.notifications.some((item) => item.contact_id === 'demo-ns-contact-6' && item.read_at === null);
  }).toBe(true);
  const today = new Date().toISOString().slice(0, 10);
  await expect.poll(async () => {
    const value = await (await page.request.get('/api/reminders')).json() as { recentDigests: Array<{ local_date: string; status: string }> };
    return value.recentDigests.find((run) => run.local_date === today)?.status ?? '';
  }).toBe('not_sent');

  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'No email was sent.' })).toBeVisible();
  await page.getByRole('button', { name: /Open reminders/ }).click();
  const reminder = page.getByRole('button', { name: /Follow up with June Kim at Bluebird Labs/ });
  await expect(reminder).toBeVisible();
  await reminder.click();
  await expect(page.getByRole('heading', { name: 'June Kim' })).toBeVisible();
  const afterRead = await (await page.request.get('/api/notifications')).json() as { unread: number };
  expect(afterRead.unread).toBe(0);
});

test('a failed card-reading job appears in Problems and Retry completes it', async ({ page }) => {
  const databasePath = resolve(process.env.DATABASE_PATH ?? '');
  const uploadsPath = resolve(process.env.UPLOADS_PATH ?? '');
  expect(databasePath.split(/[\\/]/).at(-1)).toMatch(/^gather-e2e-[0-9]+-[a-f0-9]+\.sqlite$/);
  expect(uploadsPath.split(/[\\/]/).at(-1)).toMatch(/^uploads-e2e-[0-9]+-[a-f0-9]+$/);

  const scanId = randomUUID();
  const clientScanId = randomUUID();
  const jobId = randomUUID();
  const imagePath = resolve(uploadsPath, 'demo-northstar', 'scans', `${scanId}.jpg`);
  mkdirSync(resolve(imagePath, '..'), { recursive: true });
  writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO scans(id,workspace_id,event_id,client_scan_id,source,image_path,image_mime,status,error_message,created_by)
        VALUES (?,?,?,?,?,?,?,'failed','The simulated read needs another try.','demo-owner')`)
        .run(scanId, 'demo-northstar', 'event-main-active', clientScanId, 'gallery', imagePath, 'image/jpeg');
      db.prepare(`INSERT INTO jobs(id,workspace_id,type,payload_json,run_at,attempts,max_attempts,status,last_error,finished_at)
        VALUES (?,?,?,?,?,5,5,'failed','Simulated transient reader failure.',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(jobId, 'demo-northstar', 'card_read', JSON.stringify({ scanId }), new Date().toISOString());
    })();
  } finally { db.close(); }

  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  const problem = page.locator('.problem-row').filter({ hasText: 'This card could not be read.' });
  await expect(problem).toBeVisible();
  await problem.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Retry started.' })).toBeVisible();
  await expect.poll(async () => {
    const response = await page.request.get('/api/scans');
    const result = await response.json() as { scans: Array<{ id: string; status: string }> };
    return result.scans.find((item) => item.id === scanId)?.status ?? '';
  }, { timeout: 10_000 }).toBe('ready');
  await expect(problem).toHaveCount(0);
});
