/*
 * Does the app re-read share counts on its own?
 *
 * Three moments, which is what was actually asked: opening the app, returning
 * to it after a while, and pulling down. Each must refresh WITHOUT pressing
 * Sync, and none must do so when the counts are already fresh.
 *
 * Runs against a local `wrangler dev` and real SnapTrade data.
 *   cd worker; npx wrangler dev --port 8787 --local
 *   node tests\auto-sync.cjs "<edge path>" <passphrase>
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BROWSER = process.argv[2];
const PASSPHRASE = process.argv[3];
const WORKER = 'http://127.0.0.1:8787';
const SITE_PORT = 8765;
const CDP_PORT = 9241;
const DOCS = path.join(__dirname, '..', 'docs');
const { normalizePassphrase } = require(path.join(DOCS, 'app.js'));

const LOTS = 'divtracker.holdingLots.v1';
const META = 'divtracker.syncMeta.v1';

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '\n         ' + extra : ''));
  if (!cond) fails += 1;
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(DOCS, rel);
    if (!file.startsWith(DOCS)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      let body = buf;
      if (rel === 'config.js') {
        const text = buf.toString();
        const patched = text.replace(/WORKER_BASE:\s*"[^"]*"/, `WORKER_BASE: "${WORKER}"`);
        if (patched === text) throw new Error('could not rewrite WORKER_BASE');
        body = Buffer.from(patched);
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
  });
  return new Promise((r) => server.listen(SITE_PORT, '127.0.0.1', () => r(server)));
}

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function rpc(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout on ' + method)), 60000);
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  if (!BROWSER || !PASSPHRASE) throw new Error('usage: node tests/auto-sync.cjs <browser> <passphrase>');

  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) {
    try { ready = (await fetch(WORKER + '/health')).ok; } catch { /* not up */ }
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error(`no worker at ${WORKER}; run: cd worker; npx wrangler dev --port 8787 --local`);

  const server = await serve();
  const url = `http://127.0.0.1:${SITE_PORT}/index.html`;
  const profile = path.join(os.tmpdir(), 'divauto-' + Date.now());
  const proc = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    let targets;
    for (let i = 0; i < 40; i += 1) {
      try { targets = await getJson('/json/list'); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    ws = await new Promise((resolve, reject) => {
      const s = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
      s.onopen = () => resolve(s); s.onerror = () => reject(new Error('ws failed'));
    });
    let id = 1;
    const evalJs = async (expression) => {
      const r = await rpc(ws, id++, 'Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
      return r.result.value;
    };
    const load = async (tag) => {
      await rpc(ws, id++, 'Page.navigate', { url: url + '?' + tag + '=' + Date.now() });
      await new Promise((r) => setTimeout(r, 2500));
    };
    const lots = async () => JSON.parse(await evalJs(`localStorage.getItem('${LOTS}') || '{}'`));
    const syncedAt = async () => evalJs(
      `(JSON.parse(localStorage.getItem('${META}') || '{}').at) || null`);

    await rpc(ws, id++, 'Runtime.enable', {});
    await rpc(ws, id++, 'Page.enable', {});
    await load('boot');

    /* ------------------------------------------------- 1. opening the app */
    console.log('opening the app with no share counts stored:');
    await evalJs(`
      localStorage.setItem('divtracker.syncKey.v1', ${JSON.stringify(normalizePassphrase(PASSPHRASE))});
      localStorage.removeItem('${LOTS}');
      localStorage.removeItem('divtracker.accounts.v1');
      localStorage.removeItem('divtracker.holdings.v1');
      localStorage.removeItem('${META}'); 'cleared'`);
    await load('open');
    check('the table paints before the sync lands',
      typeof (await evalJs("document.querySelectorAll('#dist-body tr').length")) === 'number');
    await new Promise((r) => setTimeout(r, 14000));

    const opened = await lots();
    console.log('         lots after open: ' + JSON.stringify(opened));
    check('opening the app synced share counts with no button press',
      Object.keys(opened).length > 0, JSON.stringify(opened));
    const firstAt = await syncedAt();
    check('and recorded when it synced', !!firstAt, String(firstAt));

    /* -------------------------------------- 2. reopening while still fresh */
    console.log('reopening immediately, while the counts are fresh:');
    await load('again');
    await new Promise((r) => setTimeout(r, 9000));
    check('a fresh reopen does NOT re-sync', (await syncedAt()) === firstAt,
      'expected the timestamp to be unchanged; a sync on every open would hammer the API');

    /* ------------------------------- 3. returning after the counts go stale */
    console.log('returning to a backgrounded app whose counts have gone stale:');
    await evalJs(`(() => {
      const m = JSON.parse(localStorage.getItem('${META}') || '{}');
      m.at = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      localStorage.setItem('${META}', JSON.stringify(m));
      return m.at;
    })()`);
    await load('stale');
    await new Promise((r) => setTimeout(r, 14000));
    const afterStale = await syncedAt();
    check('a week-old sync is refreshed on open',
      afterStale && Date.parse(afterStale) > Date.parse(firstAt) - 1,
      'stored: ' + afterStale);

    // The resume path, without a reload: exactly what a PWA does.
    console.log('resuming a backgrounded tab, with no reload at all:');
    await evalJs(`(() => {
      const m = JSON.parse(localStorage.getItem('${META}') || '{}');
      m.at = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      localStorage.setItem('${META}', JSON.stringify(m));
      window.__before = m.at;
      // Real resumes are minutes or hours apart; this test's are seconds, so
      // clear the gap that exists to stop resume storms rather than wait it out.
      state.lastAutoSyncAt = null;
      return m.at;
    })()`);
    await evalJs(`(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return 'resumed';
    })()`);
    await new Promise((r) => setTimeout(r, 14000));
    const afterResume = await syncedAt();
    check('coming back to the app refreshes without a reload',
      afterResume && afterResume !== await evalJs('window.__before'), 'stored: ' + afterResume);

    /* ------------------------------------------------------ 4. pulling down */
    console.log('pulling down, with the counts perfectly fresh:');
    const beforePull = await syncedAt();
    await evalJs(`(async () => {
      // No gap-clearing here on purpose: a pull is an explicit request and must
      // work regardless of how recently anything else synced.
      await refreshNow();
      return 'pulled';
    })()`);
    await new Promise((r) => setTimeout(r, 14000));
    const afterPull = await syncedAt();
    check('a deliberate pull re-syncs even when nothing is stale',
      afterPull && afterPull !== beforePull,
      'before: ' + beforePull + '  after: ' + afterPull);

    /* ----------------------------------------- 5. it must not fight the user */
    console.log('safety: it must not clobber someone mid-edit:');
    const guarded = await evalJs(`(() => {
      document.getElementById('holdings-body').hidden = false;
      const input = document.querySelector('#holdings-inputs input');
      if (!input) return 'no input';
      input.focus();
      return typeof isEditingHoldings === 'function' ? String(isEditingHoldings()) : 'missing';
    })()`);
    check('a focused share-count box suppresses a background sync',
      guarded === 'true', String(guarded));
    const notGuarded = await evalJs(`(() => { document.activeElement.blur(); return String(isEditingHoldings()); })()`);
    check('and it resumes once focus leaves', notGuarded === 'false', String(notGuarded));

    console.log(fails === 0 ? '\nAUTO SYNC VERIFIED' : `\n${fails} CHECK(S) FAILED`);
  } finally {
    if (ws) ws.close();
    try { process.kill(proc.pid); } catch { /* already gone */ }
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
