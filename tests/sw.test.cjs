/*
 * Unit tests for the service worker's caching strategy.
 *
 * These matter more than they look. The worker decides whether a shipped change
 * ever reaches an installed app, and it fails silently when it gets this wrong:
 * the page renders perfectly, just with last week's code. Asserting on the
 * source text (does it contain "networkFirst"?) would not have caught the
 * original cache-first bug either, so this drives the real handlers instead,
 * with a fake `caches` and a fake `fetch`.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'docs', 'sw.js'), 'utf8');

/* A minimal stand-in for the Cache Storage API, backed by a Map of URL -> body. */
function makeCaches(seed) {
  const store = new Map(Object.entries(seed || {}));
  const cache = {
    addAll: async (urls) => { urls.forEach((u) => store.set(u, 'precached ' + u)); },
    put: async (key, response) => {
      store.set(typeof key === 'string' ? key : key.url, response.body);
    },
    match: async (key) => {
      const k = typeof key === 'string' ? key : key.url;
      return store.has(k) ? { body: store.get(k), fromCache: true, ok: true, clone() { return this; } } : undefined;
    },
  };
  return {
    store,
    api: {
      open: async () => cache,
      match: async (key) => cache.match(key),
      keys: async () => ['divtracker-v1', 'divtracker-v5'],
      delete: async () => true,
    },
  };
}

/*
 * Loads sw.js into a sandbox and returns the registered handlers plus the
 * fakes, so a test can drive a fetch event and inspect what came back.
 */
function loadWorker(options) {
  const opts = options || {};
  const caches = makeCaches(opts.cache);
  const listeners = {};
  const calls = { skipWaiting: 0, claim: 0 };

  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => { calls.skipWaiting += 1; },
    clients: { claim: () => { calls.claim += 1; return Promise.resolve(); } },
    location: { origin: 'https://example.test' },
  };

  const sandbox = {
    self,
    caches: caches.api,
    fetch: opts.fetch || (() => Promise.reject(new Error('offline'))),
    URL,
    Response: class {
      constructor(body, init) {
        this.body = body;
        this.status = (init && init.status) || 200;
        this.statusText = (init && init.statusText) || '';
        this.ok = this.status >= 200 && this.status < 300;
      }
      clone() { return this; }
    },
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox);

  return { listeners, caches, calls, self };
}

/* Drives the fetch handler and resolves with whatever respondWith received. */
function handleFetch(worker, url, extra) {
  const request = Object.assign({
    url,
    method: 'GET',
    mode: 'no-cors',
  }, extra);

  let responded = null;
  worker.listeners.fetch({ request, respondWith: (p) => { responded = p; } });
  return responded;
}

const OK = (body) => ({ body, ok: true, status: 200, clone() { return this; } });

test('a shell asset is served from the network even when a cached copy exists', async () => {
  // The original bug: cache-first meant an installed app kept running the
  // app.js it was installed with, and only a force-quit cleared it.
  const worker = loadWorker({
    cache: { 'https://example.test/app.js': 'STALE' },
    fetch: async () => OK('FRESH'),
  });
  const response = await handleFetch(worker, 'https://example.test/app.js');
  assert.strictEqual(response.body, 'FRESH', 'a cached copy beat the network: still cache-first');
});

test('a successful response replaces the cached copy', async () => {
  const worker = loadWorker({
    cache: { 'https://example.test/app.js': 'STALE' },
    fetch: async () => OK('FRESH'),
  });
  await handleFetch(worker, 'https://example.test/app.js');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(worker.caches.store.get('https://example.test/app.js'), 'FRESH');
});

test('an offline request falls back to the cache', async () => {
  const worker = loadWorker({
    cache: { 'https://example.test/app.js': 'CACHED' },
    fetch: async () => { throw new Error('offline'); },
  });
  const response = await handleFetch(worker, 'https://example.test/app.js');
  assert.strictEqual(response.body, 'CACHED');
});

test('offline with nothing cached yields an explanatory 504 rather than hanging', async () => {
  const worker = loadWorker({ fetch: async () => { throw new Error('offline'); } });
  const response = await handleFetch(worker, 'https://example.test/nope.js');
  assert.strictEqual(response.status, 504);
});

test('a slow network falls back to the cache instead of showing nothing', async () => {
  // The reason network-first is affordable: a train tunnel must not mean a
  // blank page for as long as the platform's own timeout.
  const worker = loadWorker({
    cache: { 'https://example.test/app.js': 'CACHED' },
    fetch: () => new Promise(() => { /* never settles */ }),
  });
  const started = Date.now();
  const response = await handleFetch(worker, 'https://example.test/app.js');
  assert.strictEqual(response.body, 'CACHED');
  assert.ok(Date.now() - started >= 3000, 'gave up on the network far too eagerly');
});

test('a late network response still refreshes the cache after a timeout fallback', async () => {
  let release;
  const worker = loadWorker({
    cache: { 'https://example.test/app.js': 'CACHED' },
    fetch: () => new Promise((resolve) => { release = () => resolve(OK('FRESH')); }),
  });
  const response = await handleFetch(worker, 'https://example.test/app.js');
  assert.strictEqual(response.body, 'CACHED', 'expected the timeout fallback');
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(worker.caches.store.get('https://example.test/app.js'), 'FRESH',
    'the late response should still leave the cache current for next time');
});

test('an error response never overwrites a good cached copy', async () => {
  const worker = loadWorker({
    cache: { 'https://example.test/app.js': 'GOOD' },
    fetch: async () => ({ body: '<html>502</html>', ok: false, status: 502, clone() { return this; } }),
  });
  await handleFetch(worker, 'https://example.test/app.js');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(worker.caches.store.get('https://example.test/app.js'), 'GOOD');
});

test('data.json is cached under a stable key despite its cache-busting query', async () => {
  const worker = loadWorker({ fetch: async () => OK('{"generatedAt":"now"}') });
  await handleFetch(worker, 'https://example.test/data.json?t=1730000000000');
  await new Promise((r) => setImmediate(r));
  assert.ok(worker.caches.store.has('./data.json'),
    'cached under the raw URL, so the offline fallback would never find it again');
});

test('an offline data.json request finds the copy stored under the stable key', async () => {
  const worker = loadWorker({
    cache: { './data.json': '{"cached":true}' },
    fetch: async () => { throw new Error('offline'); },
  });
  const response = await handleFetch(worker, 'https://example.test/data.json?t=42');
  assert.strictEqual(response.body, '{"cached":true}');
});

test('an offline navigation falls back to the cached shell', async () => {
  const worker = loadWorker({
    cache: { './index.html': '<html>shell</html>' },
    fetch: async () => { throw new Error('offline'); },
  });
  const response = await handleFetch(worker, 'https://example.test/', { mode: 'navigate' });
  assert.strictEqual(response.body, '<html>shell</html>');
});

test('an offline navigation serves the page asked for, not always index', async () => {
  // Two separate apps live in this scope. Collapsing every navigation onto
  // index.html meant opening Balances offline showed the dividend page.
  const worker = loadWorker({
    cache: {
      './index.html': '<html>dividends</html>',
      './balances.html': '<html>balances</html>',
    },
    fetch: async () => { throw new Error('offline'); },
  });
  const response = await handleFetch(
    worker, 'https://example.test/balances.html', { mode: 'navigate' },
  );
  assert.strictEqual(response.body, '<html>balances</html>',
    'the Balances app opened to the dividend page');
});

test('a navigation is cached under its own page, not over index.html', async () => {
  // The nastier half of the same bug: fetching balances.html online wrote it
  // to the index.html key, so the *dividend* app then opened to Balances the
  // next time it was offline. The damage outlived the navigation that caused it.
  const worker = loadWorker({
    cache: { './index.html': '<html>dividends</html>' },
    fetch: async () => OK('<html>balances</html>'),
  });
  await handleFetch(worker, 'https://example.test/balances.html', { mode: 'navigate' });
  assert.strictEqual(worker.caches.store.get('./balances.html'), '<html>balances</html>');
  assert.strictEqual(worker.caches.store.get('./index.html'), '<html>dividends</html>',
    'navigating to Balances overwrote the cached dividend page');
});

test('a navigation to the bare directory still maps to index.html', async () => {
  const worker = loadWorker({
    cache: { './index.html': '<html>dividends</html>' },
    fetch: async () => { throw new Error('offline'); },
  });
  const response = await handleFetch(worker, 'https://example.test/', { mode: 'navigate' });
  assert.strictEqual(response.body, '<html>dividends</html>');
});

test('cross-origin and non-GET requests are left alone', async () => {
  const worker = loadWorker({ fetch: async () => OK('x') });
  assert.strictEqual(handleFetch(worker, 'https://cdn.example.com/x.js'), null,
    'a cross-origin request should pass straight through');
  assert.strictEqual(handleFetch(worker, 'https://example.test/x', { method: 'POST' }), null,
    'a POST should pass straight through');
});

test('install precaches the shell and takes over immediately', async () => {
  // Without skipWaiting a new worker sits idle until every tab closes, which on
  // an installed app means until it is force-quit - the exact problem this is
  // meant to solve.
  const worker = loadWorker({});
  let waited = null;
  worker.listeners.install({ waitUntil: (p) => { waited = p; } });
  await waited;
  assert.strictEqual(worker.calls.skipWaiting, 1, 'install must call skipWaiting()');
  assert.ok(worker.caches.store.has('./app.js'), 'the shell was not precached for offline use');
  assert.ok(worker.caches.store.has('./index.html'));
  assert.ok(worker.caches.store.has('./balances.html'),
    'the Balances app must work offline too, or installing it is pointless');
});

test('activate drops old caches and claims open pages', async () => {
  const worker = loadWorker({});
  let waited = null;
  worker.listeners.activate({ waitUntil: (p) => { waited = p; } });
  await waited;
  assert.strictEqual(worker.calls.claim, 1, 'activate must claim clients or the page keeps the old worker');
});
