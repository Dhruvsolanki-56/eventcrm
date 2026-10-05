import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const dist = resolve('dist');
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.gz': 'application/gzip' };

function serveDist(): Promise<{ server: Server; base: string }> {
  return new Promise((resolveStart) => {
    const server = createServer((req, res) => {
      const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
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

test('the installed app opens offline on the capture screen and refreshes its session when the signal returns', async ({ page, context }) => {
  test.skip(Boolean(process.env.E2E_BROWSER) && process.env.E2E_BROWSER !== 'chromium', "This test uses Chromium's offline emulation; Firefox's blocks service-worker page loads.");
  test.skip(!existsSync(join(dist, 'index.html')), 'Run npm run build first: this test uses the production build.');
  test.setTimeout(90_000);
  const { server, base } = await serveDist();
  let sessionChecks = 0;
  const fakeApi = async (route: import('@playwright/test').Route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ json: body });
    if (url.pathname === '/api/auth/csrf') return json({ csrfToken: 'test-token' });
    if (url.pathname === '/api/auth/me') { sessionChecks += 1; return json(session); }
    if (url.pathname === '/api/capabilities') return json({ cardReading: 'browser', aiCardProvider: null, followUpSuggestions: false });
    if (url.pathname === '/api/events/accessible') return json({ events: [] });
    if (url.pathname === '/api/scans') return json({ scans: [] });
    return json({});
  };
  try {
    await page.route('**/api/**', fakeApi);
    await page.goto(`${base}/scan`);
    await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();

    // The installable parts exist and the service worker takes over.
    const manifest = await (await page.request.get(`${base}/manifest.webmanifest`)).json() as { display: string; icons: Array<{ src: string }>; start_url: string };
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/scan');
    for (const icon of manifest.icons) expect((await page.request.get(`${base}${icon.src}`)).status()).toBe(200);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload();
    await expect.poll(() => page.evaluate(async () => ({ shell: Boolean(await caches.match('/', { cacheName: 'gather-shell-v1' })), assets: (await (await caches.open('gather-assets')).keys()).length > 3, controlled: Boolean(navigator.serviceWorker.controller) }))).toEqual({ shell: true, assets: true, controlled: true });
    // The card-reading files are saved in the background so scanning works offline from the first day.
    await expect.poll(() => page.evaluate(() => localStorage.getItem('gather-ocr-warm-v1')), { timeout: 60_000 }).toBe('1');
    expect(await page.evaluate(async () => ({ lang: Boolean(await caches.match('/ocr/eng.traineddata.gz')), worker: Boolean(await caches.match('/ocr/worker.min.js')), core: Boolean(await caches.match('/ocr/tesseract-core-simd-lstm.wasm.js') || await caches.match('/ocr/tesseract-core-lstm.wasm.js')) }))).toEqual({ lang: true, worker: true, core: true });
    // No API answer is ever stored.
    expect(await page.evaluate(async () => (await (await caches.open('gather-assets')).keys()).some((request) => request.url.includes('/api/')))).toBe(false);
    // The saved session copy holds no security token.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gather-session-cache') ?? '{}').csrfToken)).toBe('');

    // Lose the signal and reload: the app still opens, on the capture screen.
    await page.unroute('**/api/**');
    await context.setOffline(true);
    await page.goto(`${base}/home`);
    await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/scan$/);
    await expect(page.getByText('You are offline')).toBeVisible();

    // The signal returns: the session is checked again and the page leaves offline mode.
    const checksBefore = sessionChecks;
    await page.route('**/api/**', fakeApi);
    await context.setOffline(false);
    await expect.poll(() => sessionChecks).toBeGreaterThan(checksBefore);
    await expect(page.getByText('You are offline')).toHaveCount(0);
    await page.goto(`${base}/home`);
    await expect(page).toHaveURL(/\/home$/);
  } finally { server.close(); }
});
