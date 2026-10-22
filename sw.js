const VERSION = 'cc-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'sample-set.json',
  'data/index.json', 'data/s1.json', 'data/s2.json', 'data/upd.json', 'data/chrome.json',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== 'cc-img').map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isImg = req.destination === 'image' || /\.(jpe?g|png|webp|gif)$/i.test(url.pathname);
  if (isImg && !url.pathname.includes('/icons/')) {
    // card images: cache-first (they never change), stored as viewed or via "Save all images"
    e.respondWith(caches.open('cc-img').then(async c => {
      const hit = await c.match(req, { ignoreSearch: true }); if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; } catch { return Response.error(); }
    }));
  } else if (url.origin === location.origin) {
    // app shell + data: network-first so updates arrive; cache fallback offline
    e.respondWith(fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
  }
});
