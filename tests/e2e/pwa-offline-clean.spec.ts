import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { expect, test, type Route } from '@playwright/test';

// Uses the production build. Fails on ANY console error, uncaught exception or failed request, online or offline.
const dist = resolve('dist');
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.gz': 'application/gzip', '.wasm': 'application/wasm' };

function serveDist(): Promise<{ server: Server; base: string }> {
  return new Promise((resolveStart) => {
    const server = createServer((req, res) => {
      const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]!);
      let file = normalize(join(dist, pathname));
      if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) file = join(dist, 'index.html');
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolveStart({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  });
}

const workspace = { id: 'w1', name: 'Offline Co', kind: 'company', role: 'admin' };
const session = { user: { id: 'u1', name: 'Pat Offline', email: 'pat@example.test' }, workspace, availableWorkspaces: [workspace], csrfToken: 'test-token', demoMode: false };

const fakeApi = async (route: Route) => {
  const url = new URL(route.request().url());
  const json = (body: unknown) => route.fulfill({ json: body });
  switch (url.pathname) {
    case '/api/auth/csrf': return json({ csrfToken: 'test-token' });
    case '/api/auth/me': return json(session);
    case '/api/capabilities': return json({ cardReading: 'browser', aiCardProvider: null, followUpSuggestions: false });
    case '/api/events/accessible': return json({ events: [] });
    case '/api/scans': return json({ scans: [] });
    case '/api/contacts': return json({ people: [] });
    case '/api/companies': return json({ companies: [] });
    case '/api/workspace': return json({ event: null, sampleData: false });
    case '/api/notifications': return json({ notifications: [], unread: 0 });
    default: return json({});
  }
};

test('the offline app produces no errors at all: cold start, mid-session drop, offline photo, never-installed device, signal back', async ({ page, context }) => {
  test.skip(Boolean(process.env.E2E_BROWSER) && process.env.E2E_BROWSER !== 'chromium', "This test uses Chromium's offline emulation; Firefox's blocks service-worker page loads.");
  test.skip(!existsSync(join(dist, 'index.html')), 'Run npm run build first: this test uses the production build.');
  test.setTimeout(150_000);
  const problems: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()} ${message.location().url}`); });
  page.on('pageerror', (error) => problems.push(`exception: ${error.message}`));
  page.on('requestfailed', (request) => problems.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
  const { server, base } = await serveDist();
  try {
    await page.route('**/api/**', fakeApi);
    await page.goto(`${base}/scan`);
    await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload();

    // Everything needed to open any screen offline is saved: the page, the plain offline page, and every screen's code.
    await expect.poll(() => page.evaluate(async () => {
      const shell = await caches.open('gather-shell-v1');
      const assets = await (await caches.open('gather-assets')).keys();
      const names = assets.map((request) => new URL(request.url).pathname);
      return {
        shell: Boolean(await shell.match('/')), offlinePage: Boolean(await shell.match('/offline.html')),
        settings: names.some((name) => /SettingsPage/.test(name)), analytics: names.some((name) => /AnalyticsPage/.test(name)), emailDesk: names.some((name) => /EmailDeskPage/.test(name)),
        fonts: names.some((name) => name.endsWith('.woff2')),
      };
    }), { timeout: 30_000 }).toEqual({ shell: true, offlinePage: true, settings: true, analytics: true, emailDesk: true, fonts: true });

    // 1. The signal drops while someone is using another screen: one calm notice, no errors, nothing is sent.
    await page.goto(`${base}/people`);
    await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
    await context.setOffline(true);
    const notice = page.locator('.offline-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('You are offline');
    await expect(page.locator('.offline-chip')).toContainText('Offline');
    await page.getByLabel('Search companies and people').fill('anything');
    await page.waitForTimeout(600);
    await expect(page.getByRole('status').filter({ hasText: 'You are offline. This will work' })).toHaveCount(0); // no duplicate toast
    await notice.getByRole('link', { name: 'Open Scan' }).click();
    await expect(page).toHaveURL(/\/scan$/);

    // 2. A cold start with no signal opens on the capture screen.
    await page.goto(`${base}/home`);
    await expect(page).toHaveURL(/\/scan$/);
    await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.offline-banner')).toContainText('You are offline');
    await expect(page.locator('.offline-notice')).toHaveCount(0); // Scan explains offline use itself

    // 3. A photo taken offline is kept on the device, and the top bar counts it on every screen.
    const image = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 420; canvas.height = 240;
      const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 420, 240); ctx.fillStyle = '#222'; ctx.font = '28px sans-serif'; ctx.fillText('Offline Tester', 30, 120);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', .9));
      return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
    });
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'offline.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(image, 'base64') });
    await expect(page.locator('.tray-item.is-offline')).toHaveCount(1);
    await expect(page.locator('.offline-chip')).toContainText('Offline · 1 waiting');

    // 4. A device that never finished installing gets a plain, friendly page instead of the browser's error.
    await page.evaluate(() => caches.open('gather-shell-v1').then((cache) => cache.delete('/')));
    await page.goto(`${base}/scan`);
    await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try again' })).toBeVisible();
    expect(await page.title()).toContain('Offline');

    // 5. The signal returns: the app reopens normally, and the photo is still waiting to upload.
    await context.setOffline(false);
    await page.goto(`${base}/scan`);
    await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
    await page.waitForTimeout(500);
  } finally { server.close(); }

  expect(problems, `unexpected errors:\n${problems.join('\n')}`).toEqual([]);
});
