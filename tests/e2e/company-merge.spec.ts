import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

test('an admin combines duplicate companies without losing people or deal accounting', async ({ page }) => {
  const sourceId = randomUUID();
  const targetId = randomUUID();
  const sourcePersonId = randomUUID();
  const targetPersonId = randomUUID();
  const db = new Database(process.env.DATABASE_PATH!);
  try {
    db.transaction(() => {
      const addCompany = db.prepare('INSERT INTO companies(id,workspace_id,name,normalized_name,website,normalized_domain) VALUES (?,\'demo-northstar\',?,?,?,?)');
      addCompany.run(sourceId, 'Fieldnote Duplicate Test', 'fieldnoteduplicatetest', 'fieldnote-merge.example', 'fieldnote-merge.example');
      addCompany.run(targetId, 'Harbor Duplicate Test', 'harborduplicatetest', null, null);
      const addPerson = db.prepare('INSERT INTO contacts(id,workspace_id,company_id,name,email,email_normalized,owner_user_id) VALUES (?,\'demo-northstar\',?,?,?,?,\'demo-owner\')');
      addPerson.run(sourcePersonId, sourceId, 'Source Person', 'source@fieldnote-merge.example', 'source@fieldnote-merge.example');
      addPerson.run(targetPersonId, targetId, 'Target Person', 'target@harbor-merge.example', 'target@harbor-merge.example');
    })();
  } finally { db.close(); }
  try {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
  const headers = { 'X-Workspace-Id': 'demo-northstar' };
  const sourceResponse = await page.request.get(`/api/companies/${sourceId}`, { headers });
  const targetResponse = await page.request.get(`/api/companies/${targetId}`, { headers });
  expect(sourceResponse.status(), await sourceResponse.text()).toBe(200);
  expect(targetResponse.status(), await targetResponse.text()).toBe(200);
  const beforeSource = await sourceResponse.json() as { people: Array<{ id: string }> };
  const beforeTarget = await targetResponse.json() as { people: Array<{ id: string }> };
  expect(beforeSource.people.length).toBeGreaterThan(0);
  await page.goto(`/companies/${sourceId}`);
  await page.getByLabel('Company to keep').selectOption(targetId);
  await page.getByLabel('Type MERGE to confirm').fill('MERGE');
  await page.getByRole('button', { name: 'Combine company records' }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${targetId}$`));
  await expect(page.getByRole('heading', { name: 'Harbor Duplicate Test' })).toBeVisible();
  const after = await (await page.request.get(`/api/companies/${targetId}`, { headers })).json() as { people: Array<{ id: string }>; company: { deal_value_minor: number | null } };
  expect(new Set(after.people.map((person) => person.id))).toEqual(new Set([...beforeSource.people, ...beforeTarget.people].map((person) => person.id)));
  expect(after.company.deal_value_minor).toBeNull();
  expect((await page.request.get(`/api/companies/${sourceId}`, { headers })).status()).toBe(404);
  const byOldName = await (await page.request.get('/api/companies/suggestions?name=Fieldnote%20Duplicate%20Test', { headers })).json() as { companies: Array<{ id: string; reason: string }> };
  expect(byOldName.companies[0]).toMatchObject({ id: targetId, reason: 'same name' });
  const byOldDomain = await (await page.request.get('/api/companies/suggestions?email=lead%40fieldnote-merge.example', { headers })).json() as { companies: Array<{ id: string; reason: string }> };
  expect(byOldDomain.companies[0]).toMatchObject({ id: targetId, reason: 'same domain' });
  } finally {
    const cleanup = new Database(process.env.DATABASE_PATH!);
    try {
      cleanup.prepare("DELETE FROM audit_events WHERE workspace_id='demo-northstar' AND action='company_merged' AND target_id=?").run(targetId);
      cleanup.prepare("DELETE FROM companies WHERE workspace_id='demo-northstar' AND id IN (?,?)").run(sourceId, targetId);
    } finally { cleanup.close(); }
  }
});

test('a team member cannot merge companies and conflicting deal values are protected', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Priya Shah/ }).click();
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const headers = { 'X-Workspace-Id': 'demo-northstar', 'X-CSRF-Token': csrf.csrfToken };
  const denied = await page.request.post('/api/companies/demo-ns-juniper/merge', { headers, data: { targetCompanyId: 'demo-ns-acme', confirmation: 'MERGE' } });
  expect(denied.status()).toBe(409);
  await page.locator('[data-account-trigger]').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  const ownerCsrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const conflict = await page.request.post('/api/companies/demo-ns-juniper/merge', { headers: { ...headers, 'X-CSRF-Token': ownerCsrf.csrfToken }, data: { targetCompanyId: 'demo-ns-acme', confirmation: 'MERGE' } });
  expect(conflict.status()).toBe(409);
  expect((await conflict.json() as { message: string }).message).toContain('Both companies have deal details');
});
