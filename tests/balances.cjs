/*
 * Does the balances page actually show balances?
 *
 * Drives the real page against a local `wrangler dev` and real Plaid sandbox
 * Items, because the interesting failures are in the wiring rather than in any
 * pure function: currency mixing, credit-vs-cash sign, and whether a bank with
 * no investment accounts renders sensibly.
 *
 *   cd worker; npx wrangler dev --port 8787 --local
 *   node tests\balances.cjs "<edge path>" <passphrase>
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BROWSER = process.argv[2];
const PASSPHRASE = process.argv[3];
const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET = process.env.PLAID_SECRET;
const WORKER = 'http://127.0.0.1:8787';
const SITE_PORT = 8765;
const CDP_PORT = 9252;
const DOCS = path.join(__dirname, '..', 'docs');
const { normalizePassphrase } = require(path.join(DOCS, 'balances.js'));
const KEY = () => normalizePassphrase(PASSPHRASE);

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
      clearTimeout(timer); ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function plaid(p, body) {
  const r = await fetch('https://sandbox.plaid.com' + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, secret: SECRET, ...body }),
  });
  const j = JSON.parse(await r.text());
  if (!r.ok) throw new Error(p + ': ' + j.error_message);
  return j;
}

async function worker(p, body) {
  const r = await fetch(WORKER + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${SITE_PORT}`, 'X-Sync-Key': KEY() },
    body: JSON.stringify(body || {}),
  });
  let j = null; try { j = JSON.parse(await r.text()); } catch { /* ignore */ }
  return { status: r.status, body: j };
}

async function main() {
  if (!BROWSER || !PASSPHRASE) throw new Error('usage: node tests/balances.cjs <browser> <passphrase>');
  if (!CLIENT_ID || !SECRET) throw new Error('set PLAID_CLIENT_ID and PLAID_SECRET');

  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { ready = (await fetch(WORKER + '/health')).ok; } catch { /* not up */ }
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error('no worker; run: cd worker; npx wrangler dev --port 8787 --local');

  // Two institutions, so grouping and per-institution totals are exercised.
  await worker('/item/disconnect', {});
  for (const inst of ['ins_109508', 'ins_109511']) {
    const pub = await plaid('/sandbox/public_token/create', {
      institution_id: inst, initial_products: ['auth'],
    });
    const ex = await worker('/link/token/exchange', { public_token: pub.public_token });
    if (ex.status !== 200) throw new Error('link failed: ' + JSON.stringify(ex.body));
  }

  const server = await serve();
  const url = `http://127.0.0.1:${SITE_PORT}/balances.html`;
  const profile = path.join(os.tmpdir(), 'divbal-' + Date.now());
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
    const evalJs = async (expression) => {
      const r = await rpc(ws, id++, 'Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
      return r.result.value;
    };

    await rpc(ws, id++, 'Runtime.enable', {});
    await rpc(ws, id++, 'Page.enable', {});
    await rpc(ws, id++, 'Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 2000));
    await evalJs(`localStorage.setItem('divtracker.syncKey.v1', ${JSON.stringify(KEY())});
      localStorage.removeItem('divtracker.balances.v1'); 'seeded'`);
    await rpc(ws, id++, 'Page.navigate', { url: url + '?run=1' });
    await new Promise((r) => setTimeout(r, 12000));

    const view = JSON.parse(await evalJs(`(() => {
      const rows = [...document.querySelectorAll('.bal-row')].map(r => ({
        name: r.querySelector('.bal-name').textContent.trim(),
        amount: r.querySelector('.bal-amount').textContent.trim(),
        owed: r.classList.contains('owed'),
      }));
      return JSON.stringify({
        meta: document.getElementById('meta').textContent,
        institutions: [...document.querySelectorAll('.bal-inst-name')].map(e => e.textContent.trim()),
        groups: [...document.querySelectorAll('.bal-group')].map(e => e.textContent.trim()),
        cards: [...document.querySelectorAll('#summary-cards .card')].map(e => e.innerText.replace(/\\n/g, ' | ')),
        rows,
        panelHidden: document.getElementById('balances-panel').hidden,
        consoleClean: true,
      });
    })()`));

    console.log('the page:');
    console.log('         ' + view.meta);
    for (const c of view.cards) console.log('         ' + c);

    check('the balances panel is shown', view.panelHidden === false);
    check('both institutions rendered', view.institutions.length === 2,
      view.institutions.join(' | '));
    check('accounts rendered', view.rows.length >= 20, 'rows=' + view.rows.length);
    check('cash and owed are separate groups',
      view.groups.some(g => /^cash/i.test(g)) && view.groups.some(g => /^owed/i.test(g)),
      view.groups.join(' | '));

    // A heading that says "Owed" and then shows a minus reads as the opposite.
    check('the Owed heading does not contradict the rows under it',
      view.groups.filter(g => /^owed/i.test(g)).every(g => !/-|\u2212/.test(g)),
      view.groups.filter(g => /^owed/i.test(g)).join(' | ').replace(/\n/g, ' '));
    check('the Owed card does not contradict the rows either',
      view.cards.filter(c => /^owed/i.test(c)).every(c => !/-|\u2212/.test(c)),
      view.cards.filter(c => /^owed/i.test(c)).join(' | '));

    const owed = view.rows.filter(r => r.owed);
    check('credit and loan accounts are marked as owed', owed.length >= 6, 'owed rows=' + owed.length);
    check('an owed amount is shown positive with a label, not as a minus',
      owed.every(r => !/^-|^\u2212/.test(r.amount) && /owed/i.test(r.amount)),
      owed.slice(0, 3).map(r => r.name + ' = ' + r.amount.replace(/\n/g, ' ')).join(' | '));

    const cash = view.rows.filter(r => !r.owed);
    check('cash amounts are not negated', cash.every(r => !/^-/.test(r.amount)),
      cash.slice(0, 3).map(r => r.name + ' = ' + r.amount.replace(/\n/g, ' ')).join(' | '));

    // innerText applies text-transform, so the labels come back uppercased.
    check('a Net card is present', view.cards.some(c => /^net/i.test(c)), view.cards.join(' || '));
    check('the header says how old the reading is', /read /.test(view.meta), view.meta);

    // Cached figures must survive a cold open, so the page is never blank.
    await rpc(ws, id++, 'Page.navigate', { url: url + '?run=2' });
    await new Promise((r) => setTimeout(r, 1200));
    const cachedRows = await evalJs("document.querySelectorAll('.bal-row').length");
    check('cached balances render immediately on a cold open', cachedRows >= 20,
      'rows before any fetch: ' + cachedRows);

    console.log(fails === 0 ? '\nBALANCES PAGE VERIFIED' : `\n${fails} CHECK(S) FAILED`);
  } finally {
    if (ws) ws.close();
    try { process.kill(proc.pid); } catch { /* gone */ }
    server.close();
    await worker('/item/disconnect', {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
