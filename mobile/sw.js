// vibeReply phone app - service worker.
// Needed so Android can install the app and list it in the Share menu.
// Network first, so updates show up right away; the cached copy is only used offline.
const CACHE = 'vibereply-v1';
const SHELL = [
  './', './index.html', './app.css', './app.js', './chrome-shim.js', './manifest.webmanifest',
  './icon-192.png', '../background.js', '../popup.html', '../popup.js', '../popup-styles.css'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // Only this app's own files; AI calls, FxTwitter and images go straight to the network
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
