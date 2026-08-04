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
        const rows = [...document.querySelectorAll('#dist-body tr.dist-row')];
        const first = rows[0];
        const cells = first ? [...first.children].map(c => c.textContent.trim()) : [];
        // Read by class, not column index: cells now carry folded-in duplicates
        // for portrait, so textContent of a whole cell is no longer a number.
        const value = (sel) => (first && first.querySelector(sel)
          ? first.querySelector(sel).textContent.trim() : '');
        return JSON.stringify({
          rowCount: rows.length,
          badges: {
            paid: document.querySelectorAll('#dist-body .badge.paid').length,
            announced: document.querySelectorAll('#dist-body .badge.announced').length,
            projected: document.querySelectorAll('#dist-body .badge.projected').length,
          },
          firstRow: cells,
          firstValues: {
            perShare: value('.c-per'),
            shares: value('.c-sh'),
            dollars: value('.c-amt .amt'),
          },
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
    assert.ok(/\$/.test(result.firstValues.dollars),
      'dollar column empty: ' + result.firstValues.dollars);

    // Verify the dollar maths: shares x per-share = your amount.
    const perShare = Number(result.firstValues.perShare.replace(/[^0-9.]/g, ''));
    const shares = Number(result.firstValues.shares.replace(/[^0-9.]/g, ''));
    const dollars = Number(result.firstValues.dollars.replace(/[^0-9.]/g, ''));
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
          total: document.querySelectorAll('#dist-body tr.dist-row').length,
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

    // The staleness banner is the one piece of UI that exists to be absent
    // most of the time, so check both halves: silent when the build is
    // current, loud when it is not.
    const staleness = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        const box = document.getElementById('staleness');
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = (d) => pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + '/' + d.getFullYear()
          + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00';
        const real = state.data.generatedAt;

        // Pin a known-fresh build rather than trusting the checked-in
        // data.json. Otherwise this assertion fails whenever the working copy
        // is a day old - i.e. exactly when the daily build has broken, adding a
        // spurious failure on top of the real one.
        state.data.generatedAt = stamp(new Date(Date.now() - 3600000));
        renderStaleness();
        const quiet = { hidden: box.hidden, text: box.textContent };

        state.data.generatedAt = stamp(new Date(Date.now() - 5 * 86400000));
        renderStaleness();
        const loud = { hidden: box.hidden, className: box.className, text: box.textContent };

        // A present but unreadable build time must warn, not fall through to
        // the silent "never updated" state.
        state.data.generatedAt = 'sometime last Tuesday';
        renderStaleness();
        const garbled = { hidden: box.hidden, className: box.className, text: box.textContent };

        state.data.generatedAt = real;
        renderStaleness();
        const restored = { hidden: box.hidden };

        return JSON.stringify({ quiet, loud, garbled, restored });
      })()`,
      returnByValue: true,
    });
    const fresh = JSON.parse(staleness.result.value);
    assert.strictEqual(fresh.quiet.hidden, true,
      'banner must stay hidden for a current build, got: ' + fresh.quiet.text);
    assert.strictEqual(fresh.loud.hidden, false, 'a 5-day-old build must raise a warning');
    assert.match(fresh.loud.className, /\bcritical\b/,
      'expected the critical style, got: ' + fresh.loud.className);
    assert.match(fresh.loud.text, /out of date/i, 'warning text missing: ' + fresh.loud.text);
    assert.match(fresh.loud.text, /5 days ago/, 'warning should say how old: ' + fresh.loud.text);
    assert.strictEqual(fresh.garbled.hidden, false, 'an unreadable build time must warn');
    assert.match(fresh.garbled.text, /unreadable/i,
      'expected an unreadable-timestamp warning, got: ' + fresh.garbled.text);
    assert.strictEqual(fresh.restored.hidden, true, 'banner must clear once data is current again');

    // Every row must carry a quarter class that agrees with the ex-date shown
    // beside it, and each quarter must form one contiguous run - the colour
    // bands are meaningless if a quarter is re-entered further down.
    const quarters = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        const rows = [...document.querySelectorAll('#dist-body tr.dist-row')];
        const seen = new Set();
        let previous = null;
        let breaks = 0;
        let mismatched = 0;
        let unclassed = 0;
        let labels = 0;

        for (const tr of rows) {
          const cls = [...tr.classList].find(c => /^q[1-4]$/.test(c));
          if (!cls) { unclassed += 1; continue; }

          // The accessible label is either the visible chip or the clipped
          // copy; exactly one must exist on every row.
          const mark = tr.querySelector('.quarter, .visually-hidden');
          if (!mark) { mismatched += 1; continue; }
          if (tr.querySelector('.quarter')) labels += 1;

          const expected = 'q' + (Math.floor(new Date(
            tr.querySelector('.date-main').textContent).getMonth() / 3) + 1);
          if (cls !== expected) mismatched += 1;

          const key = mark.textContent;
          if (key !== previous) {
            if (seen.has(key)) breaks += 1;
            seen.add(key);
            previous = key;
          }
        }
        return JSON.stringify({
          rows: rows.length, unclassed, mismatched, breaks, labels, runs: seen.size,
          stripe: getComputedStyle(rows[0].querySelector('td')).boxShadow,
        });
      })()`,
      returnByValue: true,
    });
    const q = JSON.parse(quarters.result.value);
    assert.ok(q.rows > 0, 'no distribution rows found');
    assert.strictEqual(q.unclassed, 0, q.unclassed + ' row(s) missing a quarter class');
    assert.strictEqual(q.mismatched, 0, q.mismatched + ' row(s) coloured by the wrong quarter');
    assert.strictEqual(q.breaks, 0, 'a quarter was re-entered, so the colour bands are broken');
    assert.strictEqual(q.labels, q.runs,
      `expected one visible label per run, got ${q.labels} for ${q.runs} runs`);
    assert.ok(/rgb/.test(q.stripe) && q.stripe !== 'none',
      'quarter stripe did not render: ' + q.stripe);

    // Portrait geometry is the whole point of the layout change: the date and
    // the dollar figure have to be visible together without side-scrolling.
    await rpc(ws, id++, 'Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 0, mobile: true,
    });
    await new Promise((r) => setTimeout(r, 400));

    const portrait = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        const rows = [...document.querySelectorAll('#dist-body tr.dist-row')];
        const row = rows[0];
        const date = row.querySelector('.c-ex').getBoundingClientRect();
        const amount = row.querySelector('.c-amt').getBoundingClientRect();
        const wrap = document.querySelector('.table-wrap');
        const hidden = (sel) => getComputedStyle(row.querySelector(sel)).display;

        // Not every distribution has a declared pay date, so check the fold on
        // a row that actually has one rather than assuming the first does.
        const withPay = rows.find(r => r.querySelector('.c-pay').textContent.trim() !== '—');
        return JSON.stringify({
          sameRow: date.top < amount.bottom && amount.top < date.bottom,
          amountRightOfDate: amount.left >= date.right - 1,
          overflow: wrap.scrollWidth - wrap.clientWidth,
          docOverflow: document.documentElement.scrollWidth - window.innerWidth,
          payHidden: hidden('.c-pay'),
          perHidden: hidden('.c-per'),
          statusHidden: hidden('.c-status'),
          altPay: withPay ? withPay.querySelector('.date-alt').textContent : null,
          altPayFull: withPay ? withPay.querySelector('.c-pay').textContent.trim() : null,
          altNoPay: row.querySelector('.date-alt').textContent,
          altAmount: row.querySelector('.amt-alt').textContent,
          miniStatus: row.querySelector('.status-mini').textContent,
          amountText: row.querySelector('.amt').textContent,
          footCols: document.querySelector('#dist-table tfoot td').colSpan,
        });
      })()`,
      returnByValue: true,
    });
    const p = JSON.parse(portrait.result.value);
    assert.strictEqual(p.payHidden, 'none', 'pay-date column should fold away in portrait');
    assert.strictEqual(p.perHidden, 'none', 'per-share column should fold away in portrait');
    assert.strictEqual(p.statusHidden, 'none', 'status column should fold away in portrait');
    assert.ok(p.sameRow, 'date and amount cells are not on the same visual row');
    assert.ok(p.amountRightOfDate, 'amount should sit to the right of the date, not below it');
    assert.strictEqual(p.overflow, 0,
      'table still needs ' + p.overflow + 'px of horizontal scrolling in portrait');
    assert.strictEqual(p.docOverflow, 0, 'page overflows the viewport in portrait');
    assert.strictEqual(p.footCols, 2, 'footer colspan must shrink with the folded table');
    assert.ok(p.altPay, 'no row in the fixture has a pay date to fold');
    assert.match(p.altPay, /^pays /, 'pay date was not folded into the date cell: ' + p.altPay);
    // The folded form drops the year, which the ex-date directly above supplies.
    assert.ok(p.altPayFull.includes(p.altPay.replace(/^pays /, '').split(',')[0]),
      `folded pay date ${p.altPay} does not match the real one ${p.altPayFull}`);
    assert.match(p.altNoPay, /TBD/, 'a missing pay date should say so, not render blank');
    assert.match(p.altAmount, /×/, 'per-share breakdown missing on mobile: ' + p.altAmount);
    assert.ok(p.miniStatus.length > 0, 'status was dropped entirely in portrait');
    assert.match(p.amountText, /^\$/, 'dollar amount not shown in portrait: ' + p.amountText);

    // Without share counts the dollar column is all em dashes, so the folded
    // cell must fall back to the per-share rate rather than showing nothing.
    const noHoldings = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        state.holdings = {};
        render();
        const row = document.querySelector('#dist-body tr.dist-row');
        return JSON.stringify({
          dashHidden: getComputedStyle(row.querySelector('.amt')).display,
          alt: row.querySelector('.amt-alt').textContent,
        });
      })()`,
      returnByValue: true,
    });
    const nh = JSON.parse(noHoldings.result.value);
    assert.strictEqual(nh.dashHidden, 'none', 'the em dash should not occupy the portrait cell');
    assert.match(nh.alt, /\/ share$/, 'expected a per-share fallback, got: ' + nh.alt);

    // Crossing the breakpoint while nothing matches the filters used to leave
    // the old footer behind, still summarising rows that are gone and still
    // spanning five columns in a three-column table.
    await rpc(ws, id++, 'Emulation.clearDeviceMetricsOverride', {});
    await new Promise((r) => setTimeout(r, 300));
    const emptyFoot = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        const foot = () => document.querySelector('#dist-table tfoot td');
        state.prefs.range = 'upcoming';
        state.prefs.symbols = [];
        render();
        const wide = foot() ? foot().colSpan : null;

        // Filter to nothing at all.
        state.prefs.symbols = ['NOSUCHSYMBOL'];
        render();
        const emptied = {
          foot: foot() ? foot().colSpan : null,
          emptyShown: !document.getElementById('empty-state').hidden,
          rows: document.querySelectorAll('#dist-body tr.dist-row').length,
        };
        return JSON.stringify({ wide, emptied });
      })()`,
      returnByValue: true,
    });
    const ef = JSON.parse(emptyFoot.result.value);
    assert.strictEqual(ef.wide, 5, 'desktop footer should span five columns');
    assert.strictEqual(ef.emptied.rows, 0, 'filter should have emptied the table');
    assert.ok(ef.emptied.emptyShown, 'empty state should be visible');
    assert.strictEqual(ef.emptied.foot, null,
      'footer must not outlive the rows it summarises (colSpan left at '
      + ef.emptied.foot + ')');

    // Now cross the breakpoint while empty, then restore rows, and confirm the
    // rebuilt footer matches the folded layout rather than the old one.
    await rpc(ws, id++, 'Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 0, mobile: true,
    });
    await new Promise((r) => setTimeout(r, 400));
    const recovered = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        state.prefs.symbols = [];
        render();
        const td = document.querySelector('#dist-table tfoot td');
        const wrap = document.querySelector('.table-wrap');
        return JSON.stringify({
          colSpan: td ? td.colSpan : null,
          overflow: wrap.scrollWidth - wrap.clientWidth,
        });
      })()`,
      returnByValue: true,
    });
    const rec = JSON.parse(recovered.result.value);
    assert.strictEqual(rec.colSpan, 2, 'footer did not adopt the folded layout');
    assert.strictEqual(rec.overflow, 0,
      'table scrolls sideways again after refilling in portrait');
    await rpc(ws, id++, 'Emulation.clearDeviceMetricsOverride', {});

    console.log('\nfilters: history=' + hist.paid + ' paid rows, confirmed-only='
      + confirmed.total + ' rows, chip filter OK');
    console.log('csv import: ' + imported.status);
    console.log('staleness: quiet when current, warns when stale');
    console.log('quarters: ' + q.rows + ' rows in ' + q.runs + ' contiguous bands, all labelled');
    console.log('portrait 390px: date + amount side by side, no horizontal scroll');
    console.log('footer: cleared when empty, colspan follows the layout');
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
