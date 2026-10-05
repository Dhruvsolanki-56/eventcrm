/* Encore service worker.
   It only keeps the app itself (page shell, scripts, styles, fonts, icons, OCR files) so Encore can open without a signal.
   It never stores or answers any /api request, so people always see their real data when online. */
const SHELL = 'gather-shell-v1';
const ASSETS = 'gather-assets';
const MAX_ASSETS = 260;
const OFFLINE_PAGE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.add(new Request('/', { cache: 'reload' }));
    // The plain "you are offline" page is a safety net for a first visit that never finished. It must not block installing.
    await cache.add(new Request(OFFLINE_PAGE, { cache: 'reload' })).catch(() => undefined);
    // Save every screen's code so any page opens offline, not only the ones already visited. Best effort: a miss is fetched later.
    try {
      const list = await (await fetch('/precache.json', { cache: 'reload' })).json();
      const assets = await caches.open(ASSETS);
      await Promise.all((list.files || []).map((file) => assets.match(file).then((hit) => hit || assets.add(new Request(file, { cache: 'reload' }))).catch(() => undefined)));
    } catch { /* No list (older build) or no signal: assets are saved as they are used. */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Hashed asset files are kept across releases so an open older tab can still load its lazy chunks.
    for (const key of await caches.keys()) if (key.startsWith('gather-shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function trimAssets() {
  const cache = await caches.open(ASSETS);
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/unsubscribe')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh.ok && (fresh.headers.get('content-type') || '').includes('text/html')) {
          const cache = await caches.open(SHELL);
          await cache.put('/', fresh.clone());
        }
        return fresh;
      } catch {
        const cached = await caches.match('/', { cacheName: SHELL });
        if (cached) return cached;
        const page = await caches.match(OFFLINE_PAGE, { cacheName: SHELL });
        return page || new Response('Encore is offline and has not been saved on this device yet. Connect once, then open it again.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  if (/^\/(assets|ocr|icons)\//.test(url.pathname) || url.pathname === '/favicon.svg' || url.pathname === '/manifest.webmanifest') {
    event.respondWith((async () => {
      const cache = await caches.open(ASSETS);
      const hit = await cache.match(request);
      if (hit) return hit;
      try {
        const fresh = await fetch(request);
        if (fresh.ok && fresh.status === 200) { await cache.put(request, fresh.clone()); event.waitUntil(trimAssets()); }
        return fresh;
      } catch {
        // Not saved yet and no signal: answer quietly instead of throwing, so the page decides what to show.
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })());
  }
});
