/* sw.js — offline app shell for What Now.
   The shell (page, styles, code, fonts, icons) works with no network;
   the DATA never comes from here — feeds are cross-origin to the guide and
   keep their own freshness rules in data.js, so the service worker can't
   serve a stale "now". Bump VERSION on any shell change. */

const VERSION = 'wn-shell-v1';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/engine.js',
  'js/data.js',
  'js/sunset-score.js',
  'manifest.webmanifest',
  'assets/fonts/dm-sans-latin.woff2',
  'assets/fonts/instrument-serif-latin.woff2',
  'assets/fonts/instrument-serif-italic-latin.woff2',
  'assets/icons/favicon-32.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-512-maskable.png',
  'assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // same-origin shell only — cross-origin (guide data, Open-Meteo) passes
  // straight through so its timeouts and honesty rules stay in charge
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  // stale-while-revalidate: serve the cached shell instantly, refresh behind
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const refresh = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});
