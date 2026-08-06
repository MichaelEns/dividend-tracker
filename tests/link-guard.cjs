/*
 * Does the page sit still while a bank sign-in is in progress?
 *
 * A texted verification code has to be read somewhere else, so a bank using
 * SMS guarantees the page is backgrounded and foregrounded in the middle of
 * Link. That is the one moment it must do nothing: refreshing underneath a
 * half-finished sign-in rewrites the status message telling the user what to
 * do, and fires network work while they are mid-flow.
 *
 * Drives the real page and the real buttons, stubbing only `window.Plaid` -
 * that widget is Plaid's hosted UI and automating its iframe would test their
 * code - and the worker, so this needs no credentials and no server.
 *
 *   node tests\link-guard.cjs "<edge path>"
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BROWSER = process.argv[2];
const SITE_PORT = 8765;
const CDP_PORT = 9259;
const PUBLISHED_AT = '/dividend-tracker/';
const DOCS = path.join(__dirname, '..', 'docs');

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
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (!p.startsWith(PUBLISHED_AT)) { res.writeHead(404).end(); return; }
    const rel = p.slice(PUBLISHED_AT.length) || 'balances.html';
    const file = path.join(DOCS, rel);
    if (!file.startsWith(DOCS)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      let body = buf;
      if (rel === 'config.js') {
        const text = buf.toString();
        const patched = text.replace(/WORKER_BASE:\s*"[^"]*"/, 'WORKER_BASE: "https://worker.test"');
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

/*
 * Replaces fetch and window.Plaid, and records both. Link is held open rather
 * than completing, which is exactly the state the page is in while the user is
 * off reading a text message.
 */
const HARNESS = `
  window.__calls = [];
  window.__plaidOpened = 0;
  window.__handlers = null;
  const realFetch = window.fetch;
  window.fetch = async (url, opts) => {
    const p = new URL(url, location.href).pathname;
    window.__calls.push(p);
    const reply = (body) => ({
      ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
    });
    if (p.endsWith('/status')) {
      return reply({ connected: true, connections: [{ key: 'ins_39', institution: 'RBC Royal Bank' }] });
    }
    if (p.endsWith('/balances')) return reply({ connected: true, institutions: [], errors: [] });
    if (p.endsWith('/link/token/create') || p.endsWith('/link/token/update')) {
      return reply({ link_token: 'link-sandbox-test', institution: 'RBC Royal Bank', key: 'ins_39' });
    }
    return realFetch(url, opts);
  };
  window.Plaid = {
    create(opts) {
      window.__handlers = opts;
      return { open() { window.__plaidOpened += 1; }, exit() {}, destroy() {} };
    },
  };
  'ready';
`;

async function main() {
  if (!BROWSER) throw new Error('usage: node tests/link-guard.cjs <browser>');
  const server = await serve();
  const url = `http://127.0.0.1:${SITE_PORT}${PUBLISHED_AT}balances.html`;
  const profile = path.join(os.tmpdir(), 'linkguard-' + Date.now());
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
    await rpc(ws, id++, 'Page.addScriptToEvaluateOnNewDocument', { source: HARNESS });
    await rpc(ws, id++, 'Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 1500));
    await evalJs("localStorage.setItem('divtracker.syncKey.v1', 'testpassphrase'); 1");
    await rpc(ws, id++, 'Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 3000));

    // Baseline: with no sign-in in progress, returning to the app refreshes.
    await evalJs('window.__calls = []; 1');
    await evalJs(`document.dispatchEvent(new Event('visibilitychange')); 1`);
    await new Promise((r) => setTimeout(r, 800));
    const idleCalls = await evalJs('JSON.stringify(window.__calls)');
    check('returning to the app normally does refresh balances',
      JSON.parse(idleCalls).some((p) => p.endsWith('/balances')),
      'calls: ' + idleCalls);

    // Now start a sign-in and leave it open, as if reading a texted code.
    await evalJs("document.getElementById('add-bank-balances').click(); 1");
    await new Promise((r) => setTimeout(r, 1200));
    const opened = await evalJs('window.__plaidOpened');
    check('pressing Link a bank opens Plaid Link', opened === 1, 'opened=' + opened);

    await evalJs('window.__calls = []; 1');
    // Backgrounded to read the text, then foregrounded to type the code.
    await evalJs(`document.dispatchEvent(new Event('visibilitychange')); 1`);
    await new Promise((r) => setTimeout(r, 1000));
    const duringCalls = JSON.parse(await evalJs('JSON.stringify(window.__calls)'));
    check('coming back mid-sign-in does NOT refresh underneath Link',
      duringCalls.length === 0,
      'the page fetched ' + JSON.stringify(duringCalls) + ' while the user was entering a code');

    // The status message is the instruction on screen; it must survive.
    const status = await evalJs("document.getElementById('sync-status').textContent");
    check('the sign-in instructions are still on screen',
      /Sign in to your bank/i.test(status), JSON.stringify(status));

    // Closing Link must hand normal behaviour back.
    await evalJs(`window.__handlers.onExit(
      { error_code: 'INVALID_MFA', display_message: 'The code was incorrect.' },
      { status: 'requires_code', institution: { name: 'RBC Royal Bank' }, request_id: 'req_test1' }
    ); 1`);
    await new Promise((r) => setTimeout(r, 400));

    const exitText = await evalJs("document.getElementById('sync-status').textContent");
    check('a refused code says so, names the step, and says nothing was used up',
      /code was incorrect/i.test(exitText) && /verification code/i.test(exitText)
        && /no bank connection was used up/i.test(exitText),
      JSON.stringify(exitText));
    check('and carries the Plaid reference for support', /req_test1/.test(exitText),
      JSON.stringify(exitText));

    await evalJs('window.__calls = []; 1');
    await evalJs(`document.dispatchEvent(new Event('visibilitychange')); 1`);
    await new Promise((r) => setTimeout(r, 800));
    const afterCalls = JSON.parse(await evalJs('JSON.stringify(window.__calls)'));
    check('auto-refresh resumes once Link has closed',
      afterCalls.some((p) => p.endsWith('/balances')),
      'calls: ' + JSON.stringify(afterCalls));

    // A sign-in that succeeds must also restore it.
    await evalJs("document.getElementById('add-bank-balances').click(); 1");
    await new Promise((r) => setTimeout(r, 1000));
    await evalJs('window.__handlers.onSuccess("public-token-test"); 1');
    await new Promise((r) => setTimeout(r, 1200));
    await evalJs('window.__calls = []; 1');
    await evalJs(`document.dispatchEvent(new Event('visibilitychange')); 1`);
    await new Promise((r) => setTimeout(r, 800));
    const doneCalls = JSON.parse(await evalJs('JSON.stringify(window.__calls)'));
    check('auto-refresh resumes after a successful link too',
      doneCalls.some((p) => p.endsWith('/balances')),
      'calls: ' + JSON.stringify(doneCalls));

    console.log(fails === 0 ? '\nLINK GUARD VERIFIED' : `\n${fails} CHECK(S) FAILED`);
  } finally {
    if (ws) ws.close();
    try { process.kill(proc.pid); } catch { /* gone */ }
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
