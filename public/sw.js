// Service worker: lets World War install as an app and open even with a weak connection.
// Network first, so updates show up right away; the cached copy is only a fallback.
const CACHE = 'ww-v1';
const SHELL = ['/', '/style.css', '/js/app.js', '/js/game.js', '/js/render.js', '/shared/engine.js', '/shared/bots.js', '/shared/rules.js', '/shared/map.js', '/shared/mapdata.js', '/manifest.webmanifest', '/icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/ws') || url.pathname.startsWith('/avatar/') || url.pathname.startsWith('/api/')) return;
  const isPage = e.request.mode === 'navigate';
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(isPage ? '/' : e.request, copy)); }
    return res;
  }).catch(() => caches.match(isPage ? '/' : e.request).then(r => r || new Response('Offline', { status: 503 }))));
});
