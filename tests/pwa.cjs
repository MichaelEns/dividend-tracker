/*
 * Does each page really install as its own app?
 *
 * The unit tests read the files; this asks a browser. A manifest the browser
 * refuses to parse, an icon that 404s, or a service worker that claims the
 * wrong scope all look perfect on disk and fail only once loaded.
 *
 *   node tests\pwa.cjs "<edge path>" [url-base]
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BROWSER = process.argv[2];
const BASE = process.argv[3] || null;
const SITE_PORT = 8765;
const CDP_PORT = 9255;
const DOCS = path.join(__dirname, '..', 'docs');
// Production is a GitHub Pages *project* site, so it is served from a
// subdirectory rather than the origin root, and the manifests use absolute
// paths that say so. Serving docs/ at the root locally would make those paths
// 404 here and nowhere else, so the harness mirrors the published layout.
const PUBLISHED_AT = '/dividend-tracker/';

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '\n         ' + extra : ''));
  if (!cond) fails += 1;
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (!p.startsWith(PUBLISHED_AT)) { res.writeHead(404).end('outside the published path'); return; }
    const rel = p.slice(PUBLISHED_AT.length) || 'index.html';
    const file = path.join(DOCS, rel);
    if (!file.startsWith(DOCS)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
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
    const timer = setTimeout(() => reject(new Error('timeout on ' + method)), 45000);
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      clearTimeout(timer); ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  if (!BROWSER) throw new Error('usage: node tests/pwa.cjs <browser> [url-base]');
  const server = BASE ? null : await serve();
  const base = BASE || `http://127.0.0.1:${SITE_PORT}${PUBLISHED_AT}`;
  const profile = path.join(os.tmpdir(), 'divpwa-' + Date.now());
  const proc = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
    '--disable-gpu', '--no-first-run', '--user-data-dir=' + profile, 'about:blank',
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
    await rpc(ws, id++, 'Runtime.enable', {});
    await rpc(ws, id++, 'Page.enable', {});

    const evalJs = async (expression) => {
      const r = await rpc(ws, id++, 'Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
      return r.result.value;
    };

    for (const page of ['index.html', 'balances.html']) {
      console.log(`\n--- ${page} ---`);
      await rpc(ws, id++, 'Page.navigate', { url: base + page });
      await new Promise((r) => setTimeout(r, 3500));

      // Ask the browser for the manifest it actually resolved, and fetch it the
      // way the browser would, so a wrong MIME type or a 404 shows up here.
      const info = JSON.parse(await evalJs(`(async () => {
        const link = document.querySelector('link[rel=manifest]');
        const touch = document.querySelector('link[rel="apple-touch-icon"]');
        const out = { href: link && link.href, touch: touch && touch.href };
        try {
          const r = await fetch(out.href);
          out.status = r.status;
          out.mime = r.headers.get('content-type');
          out.manifest = await r.json();
        } catch (e) { out.error = String(e); }
        if (out.touch) {
          const t = await fetch(out.touch);
          out.touchStatus = t.status;
          out.touchBytes = (await t.blob()).size;
        }
        const iconChecks = [];
        for (const ic of (out.manifest && out.manifest.icons) || []) {
          const u = new URL(ic.src, out.href).href;
          const r = await fetch(u);
          iconChecks.push({ src: ic.src, status: r.status, bytes: (await r.blob()).size });
        }
        out.iconChecks = iconChecks;
        out.title = document.title;
        return JSON.stringify(out);
      })()`));

      check(`${page}: the browser parsed its manifest`,
        info.status === 200 && !!info.manifest, `${info.status} ${info.mime} ${info.error || ''}`);
      check(`${page}: served as a manifest MIME type`,
        /manifest\+json|application\/json/.test(info.mime || ''), info.mime);
      check(`${page}: the manifest is the app's own`,
        info.manifest && info.manifest.start_url.includes(page),
        info.manifest && `${info.manifest.name} -> ${info.manifest.start_url}`);
      for (const ic of info.iconChecks || []) {
        check(`${page}: icon ${ic.src} loads`, ic.status === 200 && ic.bytes > 0,
          `HTTP ${ic.status}, ${ic.bytes} bytes`);
      }
      check(`${page}: the iOS touch icon loads`,
        info.touchStatus === 200 && info.touchBytes > 0,
        `${info.touch} -> HTTP ${info.touchStatus}, ${info.touchBytes} bytes`);
    }

    // The two apps share a stylesheet, so their headers must line up. The
    // balances page originally omitted .topbar-inner, which supplies all the
    // horizontal padding, and its title sat flush against the screen edge
    // while the dividend page looked right. Measured rather than asserted on
    // markup, so any future way of breaking the inset is caught too.
    console.log('\n--- header layout ---');
    const insets = {};
    for (const page of ['index.html', 'balances.html']) {
      await rpc(ws, id++, 'Page.navigate', { url: base + page });
      await new Promise((r) => setTimeout(r, 2500));
      insets[page] = JSON.parse(await evalJs(`(() => {
        const h1 = document.querySelector('.topbar h1');
        const meta = document.querySelector('.topbar .meta');
        return JSON.stringify({
          h1: h1.getBoundingClientRect().left,
          meta: meta.getBoundingClientRect().left,
          body: document.body.getBoundingClientRect().left,
        });
      })()`));
    }
    for (const page of ['index.html', 'balances.html']) {
      check(`${page}: the header title is inset from the screen edge`,
        insets[page].h1 - insets[page].body >= 12,
        `left inset is only ${insets[page].h1 - insets[page].body}px`);
    }
    check('both apps inset their header title identically',
      insets['index.html'].h1 === insets['balances.html'].h1,
      `dividends=${insets['index.html'].h1}px balances=${insets['balances.html'].h1}px`);
    check('the subtitle lines up with the title on both',
      insets['index.html'].meta === insets['index.html'].h1
        && insets['balances.html'].meta === insets['balances.html'].h1,
      JSON.stringify(insets));

    // The service worker must serve each app its own page offline. This is the
    // regression that made Balances open to the dividend page.
    console.log('\n--- service worker ---');
    await rpc(ws, id++, 'Page.navigate', { url: base + 'index.html' });
    await new Promise((r) => setTimeout(r, 2500));
    const reg = await evalJs(`navigator.serviceWorker.register('sw.js')
      .then(r => 'scope=' + r.scope).catch(e => 'ERROR ' + e.message)`);
    check('the service worker registers', /^scope=/.test(reg), reg);

    await evalJs("navigator.serviceWorker.ready.then(() => 'ready')");
    await new Promise((r) => setTimeout(r, 2500));

    const cached = JSON.parse(await evalJs(`(async () => {
      const names = await caches.keys();
      const c = await caches.open(names[0]);
      const keys = (await c.keys()).map(r => new URL(r.url).pathname.split('/').pop() || 'index');
      return JSON.stringify({ names, keys: keys.sort() });
    })()`));
    check('a single versioned cache exists', cached.names.length === 1, cached.names.join(', '));
    for (const need of ['balances.html', 'balances.webmanifest', 'icon-balances-180.png', 'icon-180.png']) {
      check(`precached: ${need}`, cached.keys.includes(need), cached.keys.join(' '));
    }

    // Now go offline and confirm each app opens to itself.
    //
    // The server is stopped rather than using CDP's offline emulation: that
    // does not apply to the service worker's own fetch, so the worker happily
    // reached the network, returned the right page, and the check passed even
    // with the routing bug present. Killing the server is the only way to force
    // the cache path that is actually under test.
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      // Probing a cached asset proves nothing: the worker serves it from cache
      // whether or not the network is up. A path that never existed cannot be
      // cached, so the server answers 404 while it lives and the worker's own
      // offline 504 is the only possible answer once it is gone.
      const status = await evalJs(`fetch('${base}never-existed-' + Date.now())
        .then(r => r.status).catch(() => 'threw')`);
      // Either answer proves the server is gone: the worker's own offline 504,
      // or an outright network error. A real HTTP status means it is still up.
      check('the network really is down for the test that follows',
        status === 504 || status === 'threw',
        `got HTTP ${status} from a path that never existed - the server is still reachable`);

      for (const [page, expect] of [['balances.html', 'Balances'], ['index.html', 'Dividend']]) {
        await rpc(ws, id++, 'Page.navigate', { url: base + page });
        await new Promise((r) => setTimeout(r, 3000));
        const title = await evalJs('document.title');
        check(`offline, ${page} opens to itself`, String(title).includes(expect),
          `expected a title containing "${expect}", got "${title}"`);
      }
    } else {
      console.log('  --   offline checks skipped (cannot stop a remote server)');
    }

    console.log(fails === 0 ? '\nSEPARATE PWAs VERIFIED' : `\n${fails} CHECK(S) FAILED`);
  } finally {
    if (ws) ws.close();
    try { process.kill(proc.pid); } catch { /* gone */ }
    if (server && server.listening) server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
