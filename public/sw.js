/* Encore service worker.
   It only keeps the app itself (page shell, scripts, styles, icons, OCR files) so Encore can open without a signal.
   It never stores or answers any /api request, so people always see their real data when online. */
const SHELL = 'gather-shell-v1';
const ASSETS = 'gather-assets';
const MAX_ASSETS = 220;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.add(new Request('/', { cache: 'reload' }))).then(() => self.skipWaiting()));
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
        throw new Error('Encore is offline and the app is not saved on this device yet.');
      }
    })());
    return;
  }

  if (/^\/(assets|ocr|icons)\//.test(url.pathname) || url.pathname === '/favicon.svg' || url.pathname === '/manifest.webmanifest') {
    event.respondWith((async () => {
      const cache = await caches.open(ASSETS);
      const hit = await cache.match(request);
      if (hit) return hit;
      const fresh = await fetch(request);
      if (fresh.ok && fresh.status === 200) { await cache.put(request, fresh.clone()); event.waitUntil(trimAssets()); }
      return fresh;
    })());
  }
});
