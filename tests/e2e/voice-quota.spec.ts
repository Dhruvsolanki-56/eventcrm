import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

test('voice recording and transcript quotas bound persistent workspace/service growth', async ({ page }) => {
  test.skip(process.env.GATHER_VOICE_QUOTA_MODE !== '1', 'Run with npm run test:voice-quota to enable deliberately low limits.');
  expect(process.env.VOICE_NOTE_COUNT_WORKSPACE_LIMIT).toBe('2');
  expect(process.env.VOICE_NOTE_COUNT_TOTAL_LIMIT).toBe('4');
  expect(process.env.VOICE_TRANSCRIPT_WORKSPACE_LIMIT_BYTES).toBe('50');
  await page.goto('/');

  const database = new Database(resolve(process.env.DATABASE_PATH ?? ''), { readonly: true });
  const counts = () => ({
    northstarRows: (database.prepare(`SELECT COUNT(*) AS total FROM notes WHERE workspace_id='demo-northstar' AND kind='audio'`).get() as { total: number }).total,
    totalRows: (database.prepare(`SELECT COUNT(*) AS total FROM notes WHERE kind='audio'`).get() as { total: number }).total,
    northstarCreated: (database.prepare(`SELECT created_count AS total FROM voice_note_usage WHERE scope_id='demo-northstar'`).get() as { total: number }).total,
    serviceCreated: (database.prepare(`SELECT created_count AS total FROM voice_note_usage WHERE scope_id='__service__'`).get() as { total: number }).total,
    voiceAudit: (database.prepare(`SELECT COUNT(*) AS total FROM audit_events WHERE action='voice_note_added'`).get() as { total: number }).total,
  });
  const csrf = async () => page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json() as { csrfToken: string };
    const cookie = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('gather_csrf='))?.slice('gather_csrf='.length);
    return { csrfToken, cookieMatches: decodeURIComponent(cookie ?? '') === csrfToken };
  });
  const upload = async (workspaceId: string, contactId: string, token: string) => page.evaluate(async ({ workspaceId, contactId, token }) => {
    const audio = new Uint8Array(128);
    audio.set([0x1a, 0x45, 0xdf, 0xa3]);
    const response = await fetch(`/api/contacts/${contactId}/voice`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'audio/webm', 'X-Recording-Seconds': '1', 'X-CSRF-Token': token, 'X-Workspace-Id': workspaceId },
      body: audio,
    });
    return { status: response.status, body: await response.json() as { id?: string; code?: string } };
  }, { workspaceId, contactId, token });

  try {
    const initial = counts();
    expect(initial).toMatchObject({ northstarRows: 1, totalRows: 3, northstarCreated: 1, serviceCreated: 3 });
    await page.getByRole('button', { name: /Maya Chen/ }).click();
    await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
    let csrfState = await csrf();
    expect(csrfState.cookieMatches).toBe(true);
    let token = csrfState.csrfToken;
    const added = await upload('demo-northstar', 'demo-ns-contact-1', token);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const created = added.body as { id: string };
    expect(counts()).toMatchObject({ northstarRows: 2, totalRows: 4, northstarCreated: 2, serviceCreated: 4, voiceAudit: initial.voiceAudit + 1 });

    const originalTranscript = (database.prepare(`SELECT transcript FROM notes WHERE id='a1000000-0000-4000-8000-000000000001'`).get() as { transcript: string }).transcript;
    const currentTranscriptBytes = Buffer.byteLength(originalTranscript, 'utf8');
    expect(currentTranscriptBytes).toBeLessThanOrEqual(50);
    const transcriptRejected = await page.evaluate(async ({ token }) => {
      const response = await fetch('/api/notes/a1000000-0000-4000-8000-000000000001/text', {
        method: 'PUT', credentials: 'same-origin', body: JSON.stringify({ text: 'A transcript that exceeds the small test-only workspace cap.' }),
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, 'X-Workspace-Id': 'demo-northstar' },
      });
      return { status: response.status, body: await response.json() as { code?: string } };
    }, { token });
    expect(transcriptRejected.status).toBe(413);
    expect(transcriptRejected.body.code).toBe('voice_storage_limit');
    expect((database.prepare(`SELECT transcript FROM notes WHERE id='a1000000-0000-4000-8000-000000000001'`).get() as { transcript: string }).transcript).toBe(originalTranscript);

    expect(await page.evaluate(async ({ id, token }) => (await fetch(`/api/notes/${id}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': token, 'X-Workspace-Id': 'demo-northstar' } })).status, { id: created.id, token })).toBe(200);
    const afterDelete = counts();
    expect(afterDelete).toMatchObject({ northstarRows: 1, totalRows: 3, northstarCreated: 2, serviceCreated: 4 });
    const workspaceRejected = await upload('demo-northstar', 'demo-ns-contact-1', token);
    expect(workspaceRejected.status).toBe(413);
    expect(workspaceRejected.body.code).toBe('voice_storage_limit');
    expect(counts()).toEqual(afterDelete);

    expect(await page.evaluate(async (token) => (await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': token } })).status, token)).toBe(200);
    await page.goto('/');
    await page.getByRole('button', { name: /Sam Patel/ }).click();
    await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
    csrfState = await csrf();
    expect(csrfState.cookieMatches).toBe(true);
    token = csrfState.csrfToken;
    const serviceRejected = await upload('demo-sam-space', 'demo-sam-contact-1', token);
    expect(serviceRejected.status).toBe(413);
    expect(serviceRejected.body.code).toBe('voice_storage_limit');
    expect(counts()).toEqual(afterDelete);
  } finally { database.close(); }
});
