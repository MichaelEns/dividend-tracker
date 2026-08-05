/*
 * Offline support.
 *
 * Network-first for everything, with the cache as a fallback for when the
 * network is absent or slow.
 *
 * The shell used to be cache-first, which is the textbook choice: it opens
 * instantly and the files rarely change. On a personal app that ships several
 * times a week it turned out to be the wrong trade. An installed PWA kept
 * running whatever app.js it had cached on the day it was installed, and the
 * only way out was to force-quit the app — twice, shipped features sat on the
 * server for days without ever reaching the phone. What is on screen being
 * current matters more here than a few hundred milliseconds off a warm start.
 *
 * The cache is still filled on install so a first-ever offline open works, and
 * every successful response refreshes it.
 */
const CACHE = 'divtracker-v16';
const SHELL = [
  './',
  './index.html',
  './balances.html',
  './styles.css',
  './app.js',
  './balances.js',
  './config.js',
  './manifest.webmanifest',
  './balances.webmanifest',
  './icon.svg',
  './icon-balances.svg',
  './icon-180.png',
  './icon-balances-180.png',
];

/*
 * How long to wait for the network before showing cached content instead. A
 * dead connection rejects straight away; this budget is for the slow-but-alive
 * case, where waiting for a real timeout leaves the user staring at nothing.
 */
const NETWORK_TIMEOUT_MS = 3500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/*
 * data.json is requested with a cache-busting query string, and a navigation
 * arrives as the bare directory URL. Both have to map onto the key they were
 * stored under or the offline fallback silently misses.
 *
 * Navigations are mapped to their own page, not to index.html. Two separate
 * apps are served from this scope, and collapsing every navigation onto one of
 * them broke both directions: opening Balances offline served the dividend
 * page, and opening it online cached the balances HTML *under* the index key,
 * so the dividend app then opened to Balances the next time it was offline.
 */
function cacheKeyFor(request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith('/data.json')) return './data.json';
  if (request.mode === 'navigate') {
    const file = url.pathname.split('/').pop();
    return file ? `./${file}` : './index.html';
  }
  return request;
}

function networkFirst(request) {
  const key = cacheKeyFor(request);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    const timer = setTimeout(() => {
      caches.match(key).then((cached) => { if (cached) finish(cached); });
    }, NETWORK_TIMEOUT_MS);

    fetch(request)
      .then((response) => {
        clearTimeout(timer);
        // Refresh the cache even if the timeout already served the stale copy,
        // so the next open is current. Never cache an error over a good copy.
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(key, copy)).catch(() => { /* quota */ });
        }
        finish(response);
      })
      .catch(() => {
        clearTimeout(timer);
        caches.match(key).then((cached) => finish(cached || new Response(
          'Offline, and this has not been cached yet.',
          { status: 504, statusText: 'Offline' }
        )));
      });
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});

/* Lets the page tell a waiting worker to take over without a force-quit. */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
