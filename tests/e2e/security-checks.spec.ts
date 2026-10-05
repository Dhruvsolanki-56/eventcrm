import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, request as pwRequest, test } from '@playwright/test';

const api = () => `http://127.0.0.1:${process.env.E2E_API_PORT}`;

// Every write route found in the server source, so a new route cannot quietly skip the check.
function writeRoutes() {
  const source = readFileSync(resolve('server/index.ts'), 'utf8');
  const routes: Array<{ method: string; path: string }> = [];
  for (const match of source.matchAll(/app\.(post|put|patch|delete)\(\s*'(\/api\/[^']+)'/g)) routes.push({ method: match[1]!.toUpperCase(), path: match[2]! });
  return routes;
}
// Routes that are meant to work without a signed-in session or a token.
const openByDesign = new Set(['/api/auth/login', '/api/auth/signup', '/api/auth/password-reset', '/api/auth/password-reset/confirm', '/api/auth/email-verification/resend', '/api/auth/email-verification/confirm', '/api/auth/logout', '/api/dev/login-as', '/api/invites/accept']);

test('every signed-in write route refuses a request with a missing or wrong CSRF token', async () => {
  const ctx = await pwRequest.newContext({ baseURL: api() });
  const first = await (await ctx.get('/api/auth/csrf')).json() as { csrfToken: string };
  await ctx.post('/api/dev/login-as', { headers: { 'X-CSRF-Token': first.csrfToken }, data: { accountId: 'demo-owner', workspaceId: 'demo-northstar' } });
  const routes = writeRoutes().filter((route) => !openByDesign.has(route.path));
  expect(routes.length, 'found the write routes in the source').toBeGreaterThan(40);
  const failures: string[] = [];
  for (const route of routes) {
    const path = route.path.replace(/:[A-Za-z]+/g, 'x');
    for (const token of [undefined, 'wrong-token']) {
      const response = await ctx.fetch(path, { method: route.method, headers: { 'X-Workspace-Id': 'demo-northstar', 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-Token': token } : {}) }, data: '{}' });
      if (response.status() !== 403) failures.push(`${route.method} ${path} ${token ?? 'no token'} -> ${response.status()}`);
    }
  }
  expect(failures).toEqual([]);
});

test('hostile names and notes are shown as plain text and never run', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const headers = { 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': 'demo-northstar' };
  const payloads = ['<img src=x onerror=alert(1)>', '<script>alert(2)</script>', '"><svg onload=alert(3)>', 'javascript:alert(4)'];
  const person = 'demo-ns-contact-10';
  const detail = await (await page.request.get(`/api/contacts/${person}`, { headers })).json() as { person: { name: string; title: string; email: string; phone: string; website: string; company_name: string; version: number } };
  for (const [index, payload] of payloads.entries()) {
    await page.request.post(`/api/contacts/${person}/notes`, { headers, data: { body: `note ${index} ${payload}` } });
  }
  const latest = (await (await page.request.get(`/api/contacts/${person}`, { headers })).json() as typeof detail).person.version;
  const patched = await page.request.patch(`/api/contacts/${person}`, { headers, data: { version: latest, name: `${payloads[0]} Name`, title: payloads[2]!, email: detail.person.email, phone: detail.person.phone, website: '' } });
  expect(patched.status(), await patched.text()).toBeLessThan(300);
  const version = (await patched.json() as { version: number }).version;
  const scheme = await page.request.patch(`/api/contacts/${person}`, { headers, data: { version, name: 'Scheme check', title: '', email: detail.person.email, phone: detail.person.phone, website: payloads[3]! } });
  expect(scheme.status(), 'a javascript: website is refused').toBe(400);
  for (const path of [`/people/${person}`, '/people', '/pipeline', '/follow-ups', '/email', '/analytics']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await page.locator('#root img[src="x"], #root svg[onload], #root script').count(), `${path} has no injected elements`).toBe(0);
    expect(await page.evaluate(() => [...document.querySelectorAll('a[href^="javascript:" i]')].length), `${path} has no javascript: links`).toBe(0);
  }
  expect(dialogs, 'no script ran').toEqual([]);
  // Put the person back the way they were.
  await page.request.patch(`/api/contacts/${person}`, { headers, data: { version, name: detail.person.name, title: detail.person.title, email: detail.person.email, phone: detail.person.phone, website: detail.person.website ?? '' } });
});
