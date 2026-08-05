/*
 * Live sync verification. NOT part of CI: it needs real Plaid credentials and
 * a running worker, so it is driven by hand.
 *
 *   1. worker:  npx wrangler dev --port 8787 --local     (reads .dev.vars)
 *   2. here:    node tests/live-sync.cjs "<edge path>" <passphrase>
 *
 * It serves a copy of docs/ with WORKER_BASE pointed at the local worker, then
 * drives the real page: real button, real fetch, real worker, real Plaid
 * sandbox. The only thing stubbed is window.Plaid itself - Plaid's hosted UI
 * widget is their code, not ours, and automating an iframe login proves
 * nothing about this app. Everything on our side of onSuccess is real.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const BROWSER = process.argv[2];
const PASSPHRASE = process.argv[3];
// With no URL the page is served from docs/ with WORKER_BASE rewritten to a
// local `wrangler dev`. Pass the deployed site to test production instead -
// that origin must be in the worker's ALLOWED_ORIGINS.
const LIVE_URL = process.argv[4] || '';
const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET = process.env.PLAID_SECRET;
const WORKER = 'http://127.0.0.1:8787';
const SITE_PORT = 8765;
const CDP_PORT = 9224;
const DOCS = path.join(__dirname, '..', 'docs');
// Direct fetches here bypass the page, so they must fold the passphrase the
// same way the page does - a header cannot carry a curly apostrophe at all.
const { normalizePassphrase } = require(path.join(DOCS, 'app.js'));
const HEADER_KEY = () => normalizePassphrase(PASSPHRASE);

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '\n         ' + extra : ''));
  if (!cond) fails += 1;
}

async function plaid(p, body) {
  const r = await fetch('https://sandbox.plaid.com' + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, secret: SECRET, ...body }),
  });
  const j = JSON.parse(await r.text());
  if (!r.ok) throw new Error(p + ': ' + j.error_message);
  return j;
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
      // Point the page at the local worker without touching the tracked file.
      // Matches whatever WORKER_BASE currently holds: it was empty before the
      // worker was deployed and is a real URL now, and a rewrite that silently
      // stopped matching would send this test at the deployed worker instead,
      // which does not allow a localhost origin.
      let body = buf;
      if (rel === 'config.js') {
        const text = buf.toString();
        const patched = text.replace(/WORKER_BASE:\s*"[^"]*"/, `WORKER_BASE: "${WORKER}"`);
        if (patched === text) throw new Error('could not rewrite WORKER_BASE in config.js');
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

async function waitForDevtools() {
  for (let i = 0; i < 40; i += 1) {
    try { return await getJson('/json/list'); } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('DevTools never came up');
}

function rpc(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout on ' + method)), 30000);
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

const holding = (ticker, qty, price) => ({
  institution_price: price, institution_price_as_of: '2026-08-03',
  cost_basis: price, quantity: qty, currency: 'USD',
  security: { ticker_symbol: ticker, currency: 'USD' },
});

// A custom Sandbox user, so a real Plaid round trip can carry the symbols this
// page actually tracks. NVDA is deliberately included and deliberately not
// tracked, to prove an untracked position is ignored rather than imported.
const CUSTOM_USER = {
  override_accounts: [{
    type: 'investment', subtype: 'brokerage', starting_balance: 1000,
    meta: { name: 'Fidelity Brokerage' },
    holdings: [holding('MSFT', 100, 505.12), holding('FXAIX', 900.512, 215.4),
      holding('NVDA', 7, 180.2)],
  }],
};

// A second, different institution holding a slice of the SAME fund - the exact
// shape of the owner's real position, where FXAIX sits at both Fidelity and
// U.S. Bank. Tartan Bank is simply another Plaid sandbox institution that
// supports investments; what matters is that it is not the first one.
const SECOND_INSTITUTION = 'ins_109511';
const SECOND_USER = {
  override_accounts: [{
    type: 'investment', subtype: 'brokerage', starting_balance: 500,
    meta: { name: 'U.S. Bank Brokerage' },
    holdings: [holding('FXAIX', 100, 215.4)],
  }],
};

async function main() {
  if (!BROWSER || !PASSPHRASE) throw new Error('usage: node tests/live-sync.cjs <browser> <passphrase>');
  if (!CLIENT_ID || !SECRET) throw new Error('set PLAID_CLIENT_ID and PLAID_SECRET');

  // Wait for the worker rather than assuming it is up. `wrangler dev` takes
  // the better part of a minute to start, and a test that races it fails as
  // "Failed to fetch" in the browser - which reads like a broken page rather
  // than a worker that is not listening yet.
  if (!LIVE_URL) {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) {
      try {
        const r = await fetch(WORKER + '/health');
        ready = r.ok;
      } catch { /* not up yet */ }
      if (!ready) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ready) {
      throw new Error(`no worker answering at ${WORKER} - start it with:\n`
        + '  cd worker; npx wrangler dev --port 8787 --local');
    }
  }

  const server = LIVE_URL ? null : await serve();
  const url = LIVE_URL || `http://127.0.0.1:${SITE_PORT}/index.html`;
  console.log('testing: ' + url + '\n');
  const profile = path.join(os.tmpdir(), 'divtracker-live-' + Date.now());
  const proc = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    const targets = await waitForDevtools();
    ws = await new Promise((resolve, reject) => {
      const s = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
      s.onopen = () => resolve(s); s.onerror = () => reject(new Error('ws failed'));
    });
    let id = 1;
    const evalJs = async (expression) => {
      const r = await rpc(ws, id++, 'Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || 'page threw');
      }
      return r.result.value;
    };

    await rpc(ws, id++, 'Runtime.enable', {});
    await rpc(ws, id++, 'Page.enable', {});
    await rpc(ws, id++, 'Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 2000));

    console.log('configuration:');
    const cfg = await evalJs('JSON.stringify(window.DIVTRACKER_CONFIG)');
    check('page picked up WORKER_BASE', cfg.includes(LIVE_URL ? 'workers.dev' : '8787'), cfg);
    const btn = await evalJs(`(() => {
      const b = document.getElementById('sync-bank');
      return JSON.stringify({ exists: !!b, hidden: b ? b.hidden : null });
    })()`);
    check('sync button is visible once a worker is configured',
      JSON.parse(btn).exists && JSON.parse(btn).hidden === false, btn);

    // Seed the passphrase so no window.prompt is needed, and clear any state.
    await evalJs(`localStorage.setItem('divtracker.syncKey.v1', ${JSON.stringify(PASSPHRASE)});
      localStorage.removeItem('divtracker.holdingLots.v1');
      localStorage.removeItem('divtracker.accounts.v1');
      localStorage.removeItem('divtracker.holdings.v1'); 'ok'`);

    // A real sandbox public_token, exactly what Plaid Link hands to onSuccess.
    const pub = await plaid('/sandbox/public_token/create', {
      institution_id: 'ins_109508', initial_products: ['investments'],
    });

    await rpc(ws, id++, 'Page.navigate', { url: url + '?run=1' });
    await new Promise((r) => setTimeout(r, 2000));

    // Stub only Plaid's hosted widget.
    await evalJs(`window.Plaid = {
      create: (opts) => ({
        open: () => opts.onSuccess(${JSON.stringify(pub.public_token)},
          { institution: { name: 'First Platypus Bank' } }),
      }),
    }; 'stubbed'`);

    console.log('live sandbox sync:');
    await evalJs("document.getElementById('sync-bank').click(); 'clicked'");
    await new Promise((r) => setTimeout(r, 9000));

    const status = await evalJs(`(() => {
      const el = document.getElementById('sync-status');
      return el ? el.textContent.trim() : '(no #sync-status element)';
    })()`);
    console.log('         status line: ' + status);
    check('a status line was actually produced', status.length > 20
      && !status.startsWith('(no '), status);
    check('the worker was actually reached', !/Could not start|Sync failed/i.test(status), status);
    check('the sandbox institution is named', /First Platypus Bank/.test(status), status);
    // Plaid's stock sandbox holds everything in an IRA and a 401(k), so after
    // the spendable-accounts filter there is nothing left to import. The page
    // must say that rather than report a mismatch: "0 positions matched" would
    // send the reader looking for a broken sync instead of a working filter.
    check('an all-retirement login explains itself',
      /retirement or health account/.test(status), status);
    check('and names the accounts it left out',
      /IRA/.test(status) && /401k/i.test(status), status);
    check('it says nothing was added', /nothing was added/i.test(status), status);

    // "Wrote nothing" cannot mean "storage is empty": auto-sync pulls real
    // holdings in on load, and comparing a before/after snapshot only turned
    // that into a race. The precise claim is about THIS sync - a Plaid sync
    // that matched nothing must not have created a Plaid account, nor filed a
    // single share under one. Whatever SnapTrade did is irrelevant to it.
    const plaidState = await evalJs(`(() => {
      const accounts = JSON.parse(localStorage.getItem('divtracker.accounts.v1') || '[]');
      const lots = JSON.parse(localStorage.getItem('divtracker.holdingLots.v1') || '{}');
      const plaidIds = accounts.filter((a) => /^plaid:/.test(a.provider || '')).map((a) => a.id);
      const filed = Object.entries(lots).flatMap(([sym, buckets]) =>
        Object.keys(buckets).filter((id) => plaidIds.includes(id)).map((id) => sym + '@' + id));
      return JSON.stringify({ plaidIds, filed });
    })()`);
    const ps = JSON.parse(plaidState);
    check('a sync matching nothing created no account', ps.plaidIds.length === 0,
      'created: ' + ps.plaidIds.join(', '));
    check('and filed no shares', ps.filed.length === 0, 'filed: ' + ps.filed.join(', '));

    // Once a TOKENS namespace is bound the worker remembers the connection, so
    // the next sync would refresh through it rather than link afresh. That is
    // the whole point of KV, and it means a second scenario needs a clean slate.
    const disconnect = async () => evalJs(`(async () => {
      const base = window.DIVTRACKER_CONFIG.WORKER_BASE;
      const r = await fetch(base + '/item/disconnect', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Key': ${JSON.stringify(HEADER_KEY())} },
        body: '{}' });
      return r.status + ' ' + (await r.text());
    })()`);
    console.log('         disconnect: ' + await disconnect());

    /* ---------------------------------------------------------------------
     * The real scenario: U.S. Bank holds some FXAIX by hand, then the broker
     * syncs its own larger FXAIX plus MSFT. Nothing here is faked except
     * Plaid's UI widget - the holdings genuinely travel Plaid -> worker -> page.
     * ------------------------------------------------------------------- */
    console.log('live sandbox sync carrying tracked symbols:');
    await evalJs(`
      localStorage.setItem('divtracker.accounts.v1', JSON.stringify([{ id: 'u-s-bank', name: 'U.S. Bank' }]));
      localStorage.setItem('divtracker.holdingLots.v1', JSON.stringify({ FXAIX: { 'u-s-bank': 100 } }));
      localStorage.removeItem('divtracker.holdings.v1'); 'seeded'`);

    const custom = await plaid('/sandbox/public_token/create', {
      institution_id: 'ins_109508', initial_products: ['investments'],
      options: { override_username: 'user_custom', override_password: JSON.stringify(CUSTOM_USER) },
    });

    await rpc(ws, id++, 'Page.navigate', { url: url + '?run=2' });
    await new Promise((r) => setTimeout(r, 2000));
    await evalJs(`window.Plaid = {
      create: (opts) => ({
        open: () => opts.onSuccess(${JSON.stringify(custom.public_token)},
          { institution: { name: 'First Platypus Bank' } }),
      }),
    }; 'stubbed'`);
    await evalJs("document.getElementById('sync-bank').click(); 'clicked'");
    await new Promise((r) => setTimeout(r, 9000));

    const status2 = await evalJs(`(() => {
      const el = document.getElementById('sync-status');
      return el ? el.textContent.trim() : '(no #sync-status element)';
    })()`);
    console.log('         status line: ' + status2);
    check('the sync reported success', /Synced 2 position\(s\)/.test(status2), status2);

    const lots = JSON.parse(await evalJs("localStorage.getItem('divtracker.holdingLots.v1')"));
    check('MSFT arrived from the broker', lots.MSFT && lots.MSFT['first-platypus-bank'] === 100,
      JSON.stringify(lots.MSFT));
    check('the broker FXAIX arrived', lots.FXAIX && lots.FXAIX['first-platypus-bank'] === 900.512,
      JSON.stringify(lots.FXAIX));
    check('the hand-entered U.S. Bank FXAIX was NOT overwritten',
      lots.FXAIX && lots.FXAIX['u-s-bank'] === 100, JSON.stringify(lots.FXAIX));
    check('an untracked position was ignored, not imported', !lots.NVDA, JSON.stringify(lots.NVDA));

    const totals = JSON.parse(await evalJs("localStorage.getItem('divtracker.holdings.v1')"));
    check('the FXAIX total is both institutions combined',
      Math.abs(totals.FXAIX - 1000.512) < 1e-9, JSON.stringify(totals));

    check('a new overlapping account explains itself', /is new, so its/.test(status2), status2);

    const rendered = await evalJs(`(() => {
      const cells = [...document.querySelectorAll('table tbody td')].map((c) => c.textContent);
      return JSON.stringify({ rows: document.querySelectorAll('table tbody tr').length,
        hasDollars: cells.some((t) => /\\$[0-9,]+/.test(t)) });
    })()`);
    check('the table rendered real dollar amounts from the synced shares',
      JSON.parse(rendered).rows > 0 && JSON.parse(rendered).hasDollars, rendered);

    /* ---------------------------------------------------------------------
     * Pressing sync again. With KV bound the worker must reuse the stored
     * token: no Plaid Link, no new Item, no Trial slot consumed. This is the
     * path that makes the free tier survive more than ten syncs, so it is
     * worth proving from the browser rather than only against the API.
     * ------------------------------------------------------------------- */
    const status3 = await evalJs(`(async () => {
      window.Plaid = { create: () => ({ open: () => { window.__relinked = true; } }) };
      window.__relinked = false;
      document.getElementById('sync-bank').click();
      await new Promise((r) => setTimeout(r, 8000));
      const el = document.getElementById('sync-status');
      return JSON.stringify({ status: el ? el.textContent.trim() : '', relinked: window.__relinked });
    })()`);
    const again = JSON.parse(status3);
    console.log('         status line: ' + again.status);
    const persisted = /Connection saved/.test(status2);
    if (!persisted) {
      console.log('         (no KV namespace bound on this worker; refresh path not applicable)');
    } else {
      check('a second sync refreshed instead of re-linking',
        /Refreshed \d+ position\(s\)/.test(again.status), again.status);
      check('no bank sign-in was needed', again.relinked === false, 'Plaid Link was opened');
      check('the refresh says so plainly', /No new bank sign-in needed/.test(again.status), again.status);
    }

    // Leave no live connection behind on a worker that outlives this test.
    if (persisted) console.log('         cleanup: ' + await disconnect());

    /* ---------------------------------------------------------------------
     * Two institutions at once. This is the case the whole per-account model
     * exists for, and until now the worker could not express it: it stored one
     * token, so linking the second removed the first.
     * ------------------------------------------------------------------- */
    if (persisted) {
      console.log('two institutions holding the same fund:');
      await evalJs(`
        localStorage.removeItem('divtracker.accounts.v1');
        localStorage.removeItem('divtracker.holdingLots.v1');
        localStorage.removeItem('divtracker.holdings.v1'); 'cleared'`);

      const first = await plaid('/sandbox/public_token/create', {
        institution_id: 'ins_109508', initial_products: ['investments'],
        options: { override_username: 'user_custom', override_password: JSON.stringify(CUSTOM_USER) },
      });
      const second = await plaid('/sandbox/public_token/create', {
        institution_id: SECOND_INSTITUTION, initial_products: ['investments'],
        options: { override_username: 'user_custom', override_password: JSON.stringify(SECOND_USER) },
      });

      // Link each in turn through the real page. The first goes through the
      // main sync button; the second MUST go through "Add an institution",
      // because by then the main button short-circuits to a refresh - which is
      // exactly the trap that made a second institution unreachable.
      const buttons = ['sync-bank', 'add-bank'];
      for (let i = 0; i < 2; i += 1) {
        const token = i === 0 ? first.public_token : second.public_token;
        await rpc(ws, id++, 'Page.navigate', { url: url + '?run=' + Date.now() });
        await new Promise((r) => setTimeout(r, 2500));
        await evalJs(`window.Plaid = { create: (o) => ({ open: () =>
          o.onSuccess(${JSON.stringify(token)}, { institution: { name: 'Bank' } }) }) }; 'ok'`);
        const clicked = await evalJs(`(() => {
          const b = document.getElementById(${JSON.stringify(buttons[i])});
          if (!b) return 'missing';
          b.hidden = false;
          b.click();
          return 'clicked';
        })()`);
        check(`${buttons[i]} exists and was clickable`, clicked === 'clicked', clicked);
        await new Promise((r) => setTimeout(r, 9000));
      }

      const both = await evalJs(`(() => {
        const el = document.getElementById('sync-status');
        return JSON.stringify({
          status: el ? el.textContent.trim() : '',
          accounts: JSON.parse(localStorage.getItem('divtracker.accounts.v1') || '[]'),
          lots: JSON.parse(localStorage.getItem('divtracker.holdingLots.v1') || '{}'),
          totals: JSON.parse(localStorage.getItem('divtracker.holdings.v1') || '{}'),
        });
      })()`);
      const st = JSON.parse(both);
      console.log('         status line: ' + st.status);
      console.log('         accounts: ' + st.accounts.map((a) => a.name + '/' + a.provider).join(', '));

      check('both institutions became their own account', st.accounts.length === 2,
        JSON.stringify(st.accounts));
      const providers = st.accounts.map((a) => a.provider);
      check('each account is pinned to its own institution id',
        new Set(providers).size === 2 && providers.every((p) => /^plaid:ins_/.test(p)),
        providers.join(', '));

      const fxaixBuckets = Object.keys(st.lots.FXAIX || {});
      check('FXAIX is held in two accounts, not one', fxaixBuckets.length === 2,
        JSON.stringify(st.lots.FXAIX));
      check('the second institution did NOT overwrite the first',
        Math.abs((st.totals.FXAIX || 0) - 1000.512) < 1e-9,
        'FXAIX total is ' + st.totals.FXAIX + ', expected 900.512 + 100');
      check('MSFT survived, held at only the one institution that has it',
        Object.keys(st.lots.MSFT || {}).length === 1 && st.totals.MSFT === 100,
        JSON.stringify(st.lots.MSFT));

      const status = await evalJs(`(async () => {
        const r = await fetch(window.DIVTRACKER_CONFIG.WORKER_BASE + '/status', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sync-Key': ${JSON.stringify(HEADER_KEY())} },
          body: '{}' });
        return JSON.stringify(await r.json());
      })()`);
      const stat = JSON.parse(status);
      check('the worker is holding two connections at once',
        (stat.connections || []).length === 2, JSON.stringify(stat.connections));

      // One press must now refresh BOTH without any bank sign-in.
      const refreshed = await evalJs(`(async () => {
        window.Plaid = { create: () => ({ open: () => { window.__relinked = true; } }) };
        window.__relinked = false;
        document.getElementById('sync-bank').click();
        await new Promise((r) => setTimeout(r, 9000));
        return JSON.stringify({
          status: document.getElementById('sync-status').textContent.trim(),
          relinked: window.__relinked,
          totals: JSON.parse(localStorage.getItem('divtracker.holdings.v1') || '{}'),
        });
      })()`);
      const rf = JSON.parse(refreshed);
      console.log('         status line: ' + rf.status);
      check('one press refreshed both institutions', /Refreshed/.test(rf.status), rf.status);
      check('and named them both',
        /Platypus/.test(rf.status) && /Tartan/.test(rf.status), rf.status);
      check('with no bank sign-in', rf.relinked === false, 'Plaid Link was opened');
      check('and the split total is unchanged after refreshing',
        Math.abs((rf.totals.FXAIX || 0) - 1000.512) < 1e-9, JSON.stringify(rf.totals));

      console.log('         cleanup: ' + await disconnect());
    }

    /* ---------------------------------------------------------------------
     * SnapTrade, if the worker has credentials for it. Unlike the Plaid
     * scenarios above there is no sandbox here - this reads whatever is really
     * linked - so it asserts shape and invariants rather than fixed numbers.
     * ------------------------------------------------------------------- */
    const snapConfigured = await evalJs(`(async () => {
      const r = await fetch(window.DIVTRACKER_CONFIG.WORKER_BASE + '/status', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Key': ${JSON.stringify(HEADER_KEY())} },
        body: '{}' });
      const j = await r.json();
      return j.snaptradeConfigured === true;
    })()`);

    if (!snapConfigured) {
      console.log('snaptrade: not configured on this worker, skipped');
    } else {
      console.log('snaptrade, against whatever is really linked:');
      // Clear BEFORE the load that matters. Clearing after the page has booted
      // only empties storage: init() has already read it into memory, and the
      // next commit writes that memory straight back.
      await evalJs(`
        localStorage.removeItem('divtracker.accounts.v1');
        localStorage.removeItem('divtracker.holdingLots.v1');
        localStorage.removeItem('divtracker.holdings.v1'); 'cleared'`);
      await rpc(ws, id++, 'Page.navigate', { url: url + '?snap=' + Date.now() });
      await new Promise((r) => setTimeout(r, 2500));

      const snap = await evalJs(`(async () => {
        const b = document.getElementById('sync-snaptrade');
        b.hidden = false;
        b.click();
        await new Promise((r) => setTimeout(r, 20000));
        return JSON.stringify({
          status: document.getElementById('sync-status').textContent.trim(),
          accounts: JSON.parse(localStorage.getItem('divtracker.accounts.v1') || '[]'),
          lots: JSON.parse(localStorage.getItem('divtracker.holdingLots.v1') || '{}'),
          totals: JSON.parse(localStorage.getItem('divtracker.holdings.v1') || '{}'),
          rows: document.querySelectorAll('#dist-body tr.dist-row').length,
        });
      })()`);
      const sn = JSON.parse(snap);
      console.log('         status line: ' + sn.status);
      console.log('         accounts: ' + sn.accounts.map((a) => a.name + '/' + a.provider).join(', '));

      check('the SnapTrade sync succeeded', /Synced \d+ position/.test(sn.status), sn.status);
      check('it created an account per institution', sn.accounts.length >= 1,
        JSON.stringify(sn.accounts));
      check('every account is pinned to a snaptrade key',
        sn.accounts.every((a) => /^snaptrade:/.test(a.provider || '')),
        sn.accounts.map((a) => a.provider).join(', '));
      check('the account is named after the brokerage, not "N accounts"',
        sn.accounts.every((a) => !/^\d+ accounts?$/.test(a.name)),
        sn.accounts.map((a) => a.name).join(', '));

      const symbols = Object.keys(sn.totals);
      check('it filed at least one tracked symbol', symbols.length > 0, JSON.stringify(sn.totals));
      check('only tracked symbols were written',
        symbols.every((s) => ['MSFT', 'FXAIX', 'FSKAX'].includes(s)),
        'symbols written: ' + symbols.join(', '));
      // Money-market and cash sweep positions (SPAXX, FCASH, FDRXX) and the
      // opaque 401(k) plan codes must not be mistaken for holdings.
      check('cash sweep positions were ignored',
        !symbols.some((s) => ['SPAXX', 'FCASH', 'FDRXX'].includes(s)),
        'symbols written: ' + symbols.join(', '));

      // Only accounts whose dividends could be spent on arrival are counted, so
      // a Roth IRA or an HSA behind the same login must be excluded - and said
      // so, because an unexplained shortfall reads as a bug.
      const skipped = await evalJs(`(async () => {
        const r = await fetch(window.DIVTRACKER_CONFIG.WORKER_BASE + '/snaptrade/holdings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sync-Key': ${JSON.stringify(HEADER_KEY())} },
          body: '{}' });
        const j = await r.json();
        return JSON.stringify({ skipped: j.skipped || [], read: j.accounts });
      })()`);
      const sk = JSON.parse(skipped);
      const sheltered = sk.skipped.filter((x) => x.kind === 'sheltered');
      console.log('         read ' + sk.read + ' account(s), skipped ' + sk.skipped.length);
      for (const x of sk.skipped) console.log(`           [${x.kind}] ${x.name}`);

      if (sheltered.length) {
        check('the status line names the retirement accounts it left out',
          /Not counted:/.test(sn.status), sn.status);
        check('and says why', /spendable/.test(sn.status), sn.status);
      }
      const cards = sk.skipped.filter((x) => x.kind === 'credit');
      if (cards.length) {
        check('a credit card is classified as credit, not as a holding',
          cards.every((c) => /card|visa/i.test(c.name)), JSON.stringify(cards));
        check('cards are not mentioned in the status line',
          !cards.some((c) => sn.status.includes(c.name)), sn.status);
      }

      const derived = Object.fromEntries(Object.entries(sn.lots).map(
        ([sym, buckets]) => [sym, Object.values(buckets).reduce((a, b) => a + b, 0)]));
      check('the per-account lots add up to the totals shown',
        JSON.stringify(derived) === JSON.stringify(sn.totals),
        JSON.stringify(derived) + ' vs ' + JSON.stringify(sn.totals));
      check('the table rendered from the synced shares', sn.rows > 0, String(sn.rows));
    }

    console.log(fails === 0 ? '\nLIVE SYNC VERIFIED' : `\n${fails} CHECK(S) FAILED`);
  } finally {
    if (ws) ws.close();
    try { process.kill(proc.pid); } catch { /* already gone */ }
    if (server) server.close();
    // The browser may still be releasing its profile; losing a temp dir is not
    // worth failing a passing run over.
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
