/*
 * Headless smoke test: loads the real page over HTTP, seeds holdings into
 * localStorage, and asserts the table renders with correct dollar maths.
 * Uses the Chrome DevTools Protocol directly so no npm dependency is needed.
 */
'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert');

const BROWSER = process.argv[2];
const URL_UNDER_TEST = process.argv[3] || 'http://127.0.0.1:8765/index.html';
const PORT = 9223;

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function waitForDevtools(retries = 40) {
  for (let i = 0; i < retries; i += 1) {
    try {
      return await getJson('/json/list');
    } catch (err) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('DevTools endpoint never became available');
}

function connect(wsUrl) {
  // Node 22+ ships a global WebSocket client.
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || 'unknown')));
  });
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

async function main() {
  const proc = spawn(BROWSER, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + require('node:os').tmpdir() + '/divtracker-smoke-' + Date.now(),
    'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    const targets = await waitForDevtools();
    const page = targets.find((t) => t.type === 'page');
    assert.ok(page, 'no page target');
    ws = await connect(page.webSocketDebuggerUrl);

    let id = 1;
    await rpc(ws, id++, 'Runtime.enable', {});
    await rpc(ws, id++, 'Page.enable', {});

    // Seed holdings before the app boots so dollar amounts are exercised.
    await rpc(ws, id++, 'Page.navigate', { url: URL_UNDER_TEST });
    await new Promise((r) => setTimeout(r, 1500));
    await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `localStorage.setItem('divtracker.holdings.v1',
        JSON.stringify({ MSFT: 100, FXAIX: 250, FSKAX: 10 }));`,
      awaitPromise: true,
    });
    await rpc(ws, id++, 'Page.navigate', { url: URL_UNDER_TEST + '?reload=1' });
    await new Promise((r) => setTimeout(r, 2500));

    const probe = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        const rows = [...document.querySelectorAll('#dist-body tr')];
        const first = rows[0];
        const cells = first ? [...first.children].map(c => c.textContent.trim()) : [];
        return JSON.stringify({
          rowCount: rows.length,
          badges: {
            paid: document.querySelectorAll('#dist-body .badge.paid').length,
            announced: document.querySelectorAll('#dist-body .badge.announced').length,
            projected: document.querySelectorAll('#dist-body .badge.projected').length,
          },
          firstRow: cells,
          meta: document.getElementById('meta').textContent,
          cards: [...document.querySelectorAll('#summary-cards .card')].map(c => ({
            label: c.querySelector('.label').textContent,
            value: c.querySelector('.value').textContent,
          })),
          yearRows: document.querySelectorAll('#year-body tr').length,
          notes: document.querySelectorAll('#notes-panel h3').length,
          consoleErrors: window.__errors || [],
        });
      })()`,
      returnByValue: true,
    });

    const result = JSON.parse(probe.result.value);
    console.log(JSON.stringify(result, null, 2));

    assert.ok(result.rowCount > 0, 'no distribution rows rendered');
    assert.ok(result.badges.projected > 0, 'expected projected rows');
    assert.ok(result.notes >= 3, 'expected per-symbol notes for each symbol');
    assert.ok(result.yearRows > 0, 'year rollup did not render');
    assert.ok(/\$/.test(result.firstRow[5]), 'dollar column empty: ' + result.firstRow[5]);

    // Verify the dollar maths: shares x per-share = your amount.
    const perShare = Number(result.firstRow[3].replace(/[^0-9.]/g, ''));
    const shares = Number(result.firstRow[4].replace(/[^0-9.]/g, ''));
    const dollars = Number(result.firstRow[5].replace(/[^0-9.]/g, ''));
    assert.ok(Math.abs(perShare * shares - dollars) < 0.02,
      `dollar maths wrong: ${perShare} x ${shares} != ${dollars}`);

    // History view must surface realized payments.
    const history = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        document.querySelector('.segmented button[data-range="history"]').click();
        return JSON.stringify({
          paid: document.querySelectorAll('#dist-body .badge.paid').length,
          projected: document.querySelectorAll('#dist-body .badge.projected').length,
        });
      })()`,
      returnByValue: true,
    });
    const hist = JSON.parse(history.result.value);
    assert.ok(hist.paid > 50, 'history view should list many paid rows, got ' + hist.paid);
    assert.strictEqual(hist.projected, 0, 'history view must not contain projections');

    // "Confirmed only" must remove every projected row.
    const confirmedOnly = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        document.querySelector('.segmented button[data-range="all"]').click();
        const cb = document.getElementById('hide-projected');
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
        return JSON.stringify({
          projected: document.querySelectorAll('#dist-body .badge.projected').length,
          total: document.querySelectorAll('#dist-body tr').length,
        });
      })()`,
      returnByValue: true,
    });
    const confirmed = JSON.parse(confirmedOnly.result.value);
    assert.strictEqual(confirmed.projected, 0, '"Confirmed only" left projections visible');
    assert.ok(confirmed.total > 0, '"Confirmed only" hid everything');

    // Symbol chip filtering must scope the table to one security.
    const chipFiltered = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        document.getElementById('hide-projected').checked = false;
        document.getElementById('hide-projected').dispatchEvent(new Event('change'));
        document.querySelector('.chip[data-symbol="FSKAX"]').click();
        const syms = new Set([...document.querySelectorAll('#dist-body .sym')].map(s => s.textContent));
        return JSON.stringify({ symbols: [...syms] });
      })()`,
      returnByValue: true,
    });
    const chips = JSON.parse(chipFiltered.result.value);
    assert.deepStrictEqual(chips.symbols, ['FSKAX'], 'chip filter did not scope the table');

    // Drive the real CSV import path with a Fidelity-shaped export.
    const csvImport = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(async () => {
        document.querySelector('.chip[data-symbol=""]').click();
        const csv = [
          '"Account Number","Account Name","Symbol","Description","Quantity","Last Price"',
          '"Z1","INDIVIDUAL","MSFT","MICROSOFT CORP","12.000","$495.76"',
          '"Z1","INDIVIDUAL","FXAIX","FIDELITY 500 INDEX FUND","3.500","$264.23"',
          '"Z2","ROTH IRA","MSFT","MICROSOFT CORP","8.000","$495.76"',
          '"Z1","INDIVIDUAL","SPAXX**","MONEY MARKET","1,000.00","$1.00"'
        ].join('\\r\\n');
        const file = new File([csv], 'Portfolio_Positions.csv', { type: 'text/csv' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = document.getElementById('csv-input');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 600));
        return JSON.stringify({
          status: document.getElementById('sync-status').textContent,
          stored: JSON.parse(localStorage.getItem('divtracker.holdings.v1') || '{}'),
          msftShares: document.getElementById('sh-MSFT').value,
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const imported = JSON.parse(csvImport.result.value);
    assert.strictEqual(imported.stored.MSFT, 20, 'MSFT should sum both accounts (12 + 8)');
    assert.strictEqual(imported.stored.FXAIX, 3.5, 'FXAIX quantity wrong');
    assert.ok(!('SPAXX' in imported.stored), 'money-market row must be ignored');
    assert.strictEqual(imported.msftShares, '20', 'input did not refresh after import');
    assert.match(imported.status, /Imported 2 position/, 'import status not shown: ' + imported.status);

    console.log('\nfilters: history=' + hist.paid + ' paid rows, confirmed-only='
      + confirmed.total + ' rows, chip filter OK');
    console.log('csv import: ' + imported.status);
    console.log('\nSMOKE TEST PASSED');
  } finally {
    if (ws) ws.close();
    proc.kill();
  }
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err.message);
  process.exit(1);
});
