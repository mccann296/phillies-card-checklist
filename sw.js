const VERSION = 'cc-v17';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'sample-set.json',
  'data/index.json', 'data/s1.json', 'data/s2.json', 'data/upd.json', 'data/chrome.json', 'data/sapphire.json', 'data/logofractor.json', 'data/t08gold.json', 'data/od08.json', 'data/ch08.json', 'data/s1all.json', 'data/s2all.json', 'data/updall.json', 'data/harper-psa10.json', 'data/spvar.json', 'data/extra.json', 'prices.json',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
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
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
  }
});

// Web Push deal alerts (sent from the weekly price job on Groky's box)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Card deal', {
    body: d.body || '', tag: d.tag || undefined, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    data: { url: d.url || '', app: d.app || self.registration.scope }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { url, app } = e.notification.data || {};
  // open the listing if there is one, otherwise the card in the app
  e.waitUntil((async () => {
    if (url) return clients.openWindow(url);
    const ws = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of ws) if (w.url.startsWith(self.registration.scope)) { await w.focus(); return w.navigate ? w.navigate(app) : null; }
    return clients.openWindow(app);
  })());
});
