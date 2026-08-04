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
          lots: JSON.parse(localStorage.getItem('divtracker.holdingLots.v1') || '{}'),
          msftShares: document.querySelector('#holdings-inputs input[data-symbol="MSFT"]').value,
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
    // The seeded FSKAX was not in the file, so replacing that account's bucket
    // must drop it - a merge would leave a sold position on screen forever.
    assert.ok(!('FSKAX' in imported.stored),
      'a position absent from the import survived it: ' + JSON.stringify(imported.stored));
    assert.deepStrictEqual(Object.keys(imported.lots).sort(), ['FXAIX', 'MSFT'],
      'per-account storage disagrees with the totals');

    // FXAIX is split between Fidelity and U.S. Bank. Drive the real UI: add two
    // accounts, type into each box, and confirm the total is their sum - then
    // confirm a sync of one institution cannot damage the other's shares.
    const split = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(async () => {
        document.getElementById('clear-holdings').click();
        const add = (name) => {
          document.getElementById('account-name').value = name;
          document.getElementById('add-account').click();
        };
        add('Fidelity');
        add('U.S. Bank');
        const type = (symbol, account, value) => {
          const el = document.querySelector(
            '#holdings-inputs input[data-symbol="' + symbol + '"][data-account="' + account + '"]');
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return el;
        };
        type('FXAIX', 'fidelity', '900');
        const bankBox = type('FXAIX', 'u-s-bank', '100');
        const totalOf = (symbol) => document.querySelector(
          '#holdings-inputs input[data-symbol="' + symbol + '"]')
          .closest('.holding').querySelector('.holding-total strong').textContent;

        const beforeSync = {
          accounts: state.accounts.map((a) => a.id),
          total: state.holdings.FXAIX,
          shown: totalOf('FXAIX'),
          // Typing must not tear down the field being typed into.
          kept: document.contains(bankBox),
        };

        // What a Fidelity sync does: replace that account only.
        const kept = applyHoldings({ FXAIX: 925 }, 'Fidelity', 'snaptrade');
        const afterSync = {
          kept,
          total: state.holdings.FXAIX,
          fidelity: state.lots.FXAIX.fidelity,
          bank: state.lots.FXAIX['u-s-bank'],
          accounts: state.accounts.length,
        };

        // The same connection, after the provider re-words its own label -
        // SnapTrade prints the brokerage name for one link and a combined name
        // once a second is added. Keying storage off that string forked the
        // bucket and silently doubled the position.
        const reworded = applyHoldings({ FXAIX: 950 }, 'Fidelity + Somewhere', 'snaptrade');
        const afterReword = {
          reworded,
          total: state.holdings.FXAIX,
          accounts: state.accounts.length,
          names: state.accounts.map((a) => a.name),
        };

        // An import that matches nothing must change nothing at all.
        const junk = applyHoldings({ TSLA: 5 }, 'Fidelity', 'snaptrade');
        const junkTotal = state.holdings.FXAIX;
        const csvWrapHidden = document.getElementById('csv-account-wrap').hidden;
        const options = [...document.querySelectorAll('#csv-account option')].map((o) => o.value);

        const removeButton = document.querySelector('.account-remove[data-account="fidelity"]');
        window.confirm = () => true;
        if (removeButton) removeButton.click();
        const removed = {
          had: !!removeButton,
          lots: state.lots.FXAIX,
          accounts: state.accounts.length,
          total: state.holdings.FXAIX,
        };

        // Leave the app holding something, so the later layout checks have
        // dollar amounts to measure.
        state.accounts = [];
        state.lots = {};
        applyHoldings({ MSFT: 100, FXAIX: 250, FSKAX: 10 }, 'Manual entry');

        return JSON.stringify({ beforeSync, afterSync, afterReword, junk,
          junkTotal: junkTotal, removed, csvWrapHidden, options });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const sp = JSON.parse(split.result.value);
    assert.deepStrictEqual(sp.beforeSync.accounts, ['fidelity', 'u-s-bank'],
      'both institutions should be on the shared account list');
    assert.strictEqual(sp.beforeSync.total, 1000, 'the total is not the sum of both accounts');
    assert.match(sp.beforeSync.shown, /^1,000/, 'the on-screen total is wrong: ' + sp.beforeSync.shown);
    assert.ok(sp.beforeSync.kept, 'typing a share count destroyed the field being typed into');
    assert.strictEqual(sp.afterSync.kept, 1, 'the Fidelity sync did not apply');
    assert.strictEqual(sp.afterSync.fidelity, 925, 'Fidelity shares did not update');
    assert.strictEqual(sp.afterSync.bank, 100,
      'syncing Fidelity overwrote the U.S. Bank shares - the bug this feature exists to stop');
    assert.strictEqual(sp.afterSync.total, 1025, 'the total did not follow the sync');
    assert.strictEqual(sp.afterSync.accounts, 2, 'a sync invented a duplicate account');
    assert.strictEqual(sp.afterReword.reworded, 1, 'the re-worded sync did not apply');
    assert.strictEqual(sp.afterReword.accounts, 2,
      'a re-worded provider label forked the account: ' + sp.afterReword.names);
    assert.strictEqual(sp.afterReword.total, 1050,
      'the position doubled when the provider re-worded its label');
    assert.strictEqual(sp.junk, 0, 'an import matching no tracked ticker reported success');
    assert.strictEqual(sp.junkTotal, 1050, 'an import matching nothing still changed the holdings');
    assert.ok(sp.removed.had, 'no remove button was rendered for the Fidelity account');
    assert.deepStrictEqual(sp.removed.lots, { 'u-s-bank': 100 },
      'removing an account took the other account down with it');
    assert.strictEqual(sp.removed.accounts, 1, 'the account was not removed');
    assert.strictEqual(sp.removed.total, 100, 'the total did not follow the removal');
    assert.strictEqual(sp.csvWrapHidden, false, 'the CSV target picker is hidden with two accounts');
    assert.deepStrictEqual(sp.options, ['fidelity', 'u-s-bank'],
      'the CSV target picker does not list the accounts');
    console.log('accounts: FXAIX split 900 + 100, Fidelity sync to 925 left U.S. Bank alone');

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
        // ...and one that genuinely has none. Mutual funds never do: no free
        // feed publishes pay dates for them.
        const noPay = rows.find(r => r.querySelector('.c-pay').textContent.trim() === '—');
        return JSON.stringify({
          sameRow: date.top < amount.bottom && amount.top < date.bottom,
          amountRightOfDate: amount.left >= date.right - 1,
          overflow: wrap.scrollWidth - wrap.clientWidth,
          docOverflow: document.documentElement.scrollWidth - window.innerWidth,
          payHidden: hidden('.c-pay'),
          perHidden: hidden('.c-per'),
          statusHidden: hidden('.c-status'),
          altPay: withPay ? withPay.querySelector('.date-alt').textContent : null,
          mainPay: withPay ? withPay.querySelector('.date-main').textContent : null,
          altPayFull: withPay ? withPay.querySelector('.c-pay').textContent.trim() : null,
          altNoPay: noPay ? noPay.querySelector('.date-alt').textContent : null,
          mainNoPay: noPay ? noPay.querySelector('.date-main').textContent : null,
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
    // The pay date must survive the fold - it is the only place portrait can
    // show it once the Pay date column is gone. It now leads the cell rather
    // than trailing it, so the check moved from the alt line to the main one.
    assert.ok(p.altPayFull.includes(p.mainPay.split(',')[0]),
      `folded pay date ${p.mainPay} does not match the real one ${p.altPayFull}`);
    assert.match(p.altPay, /^ex /,
      'the demoted line should now be the ex-date: ' + p.altPay);
    assert.ok(p.altNoPay, 'no row in the fixture is missing a pay date to fall back on');
    assert.match(p.altNoPay, /ex-date/, 'a row with no pay date must label its large line');
    assert.doesNotMatch(p.altNoPay, /TBD/i,
      'a dividend paid years ago must not be described as pending: ' + p.altNoPay);
    assert.ok(p.mainNoPay && !/TBD/i.test(p.mainNoPay),
      'a row with no pay date should lead with its ex-date, not a placeholder: ' + p.mainNoPay);
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
    assert.match(nh.alt, /per share$/, 'expected a per-share fallback, got: ' + nh.alt);

    // The reported bug: at 390px with real six-figure share counts the amount
    // column was dragged wide enough to push the dollar figure off the screen.
    // 320px is the narrowest phone still in use, so check the whole range
    // rather than the one width that happened to be measured.
    const widths = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        state.holdings = { MSFT: 7885.97, FXAIX: 5242.39, FSKAX: 7057.42 };
        render();
        return 'seeded';
      })()`,
      returnByValue: true,
    });
    assert.strictEqual(widths.result.value, 'seeded');

    for (const width of [320, 360, 390, 430]) {
      await rpc(ws, id++, 'Emulation.setDeviceMetricsOverride', {
        width, height: 844, deviceScaleFactor: 0, mobile: true,
      });
      await new Promise((r) => setTimeout(r, 350));
      const fit = await rpc(ws, id++, 'Runtime.evaluate', {
        expression: `(() => {
          const wrap = document.querySelector('.table-wrap');
          const row = document.querySelector('#dist-body tr.dist-row');
          const cell = row.querySelector('.c-amt');
          const spans = [...row.querySelectorAll('.amt-alt .alt-line')];
          const tops = spans.map((s) => Math.round(s.getBoundingClientRect().top));
          return JSON.stringify({
            tableOverflow: wrap.scrollWidth - wrap.clientWidth,
            docOverflow: document.documentElement.scrollWidth - window.innerWidth,
            cellOverflow: cell.scrollWidth - cell.clientWidth,
            // Distinct tops means genuinely stacked, not merely two elements
            // that happen to exist in the markup at every width.
            stacked: tops.length === 2 && tops[0] !== tops[1],
            tops,
          });
        })()`,
        returnByValue: true,
      });
      const f = JSON.parse(fit.result.value);
      assert.strictEqual(f.tableOverflow, 0, `table scrolls sideways at ${width}px`);
      assert.strictEqual(f.docOverflow, 0, `page scrolls sideways at ${width}px`);
      assert.strictEqual(f.cellOverflow, 0, `amount spills out of its cell at ${width}px`);
      assert.ok(f.stacked,
        `the per-share breakdown is not on two lines at ${width}px, tops: ${f.tops}`);
    }
    console.log('portrait fit: no overflow at 320/360/390/430px, breakdown on two lines');

    // Amounts must read "$7,176.23" everywhere. The default currency format
    // disambiguates USD as "US$" on any non-en-US locale, which is what the
    // phone was actually showing and cost two characters in the tightest
    // column on the page.
    await rpc(ws, id++, 'Emulation.setLocaleOverride', { locale: 'en-GB' });
    const localised = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        render();
        const row = document.querySelector('#dist-body tr.dist-row');
        return JSON.stringify({
          amount: row.querySelector('.amt').textContent,
          footer: document.querySelector('#dist-table tfoot .c-amt').textContent,
        });
      })()`,
      returnByValue: true,
    });
    const loc = JSON.parse(localised.result.value);
    assert.ok(!/US\$/.test(loc.amount), 'amount carries a US$ prefix on en-GB: ' + loc.amount);
    assert.ok(!/US\$/.test(loc.footer), 'footer carries a US$ prefix on en-GB: ' + loc.footer);
    assert.match(loc.amount, /^\$/, 'amount should start with a bare $: ' + loc.amount);
    await rpc(ws, id++, 'Emulation.setLocaleOverride', {});
    console.log('currency: bare $ even on a non-US locale');

    // The three worker-backed buttons carry the `hidden` attribute, but
    // `.primary { display: inline-flex }` outranked the UA rule that acts on
    // it, so they were offered on a site with no worker deployed - and the
    // SnapTrade one then returned silently, looking simply broken.
    //
    // Which of those states applies now depends on whether docs/config.js has
    // a WORKER_BASE, so this reads the page's own config rather than assuming.
    // Both branches are real: the repo shipped for months with no worker, and
    // has one now. window.prompt is stubbed either way - it blocks the page in
    // headless, and once a worker IS configured the passphrase gate reaches it.
    const guards = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        const show = (id) => getComputedStyle(document.getElementById(id)).display;
        document.getElementById('holdings-body').hidden = false;
        const configured = Boolean((window.DIVTRACKER_CONFIG || {}).WORKER_BASE);
        const before = { plaid: show('sync-bank'), snap: show('sync-snaptrade'), disc: show('disconnect-bank') };
        window.prompt = () => '';
        const btn = document.getElementById('sync-snaptrade');
        btn.hidden = false;
        btn.click();
        const status = document.getElementById('sync-status');
        return JSON.stringify({ configured, before,
          statusHidden: status.hidden, statusText: status.textContent });
      })()`,
      returnByValue: true,
    });
    const g = JSON.parse(guards.result.value);
    assert.strictEqual(g.before.disc, 'none', 'the disconnect button is visible with no connection');
    assert.strictEqual(g.statusHidden, false, 'the sync button did nothing at all when tapped');
    if (g.configured) {
      assert.notStrictEqual(g.before.plaid, 'none',
        'a worker is configured but the Plaid button is still hidden');
      // Refusing without a passphrase is the point: the worker fails closed,
      // so a button that fired anyway would only ever produce a 401.
      assert.match(g.statusText, /passphrase/i,
        'with a worker configured, syncing should stop at the passphrase, said: ' + g.statusText);
    } else {
      assert.strictEqual(g.before.plaid, 'none', 'the Plaid button is visible with no worker configured');
      assert.strictEqual(g.before.snap, 'none', 'the SnapTrade button is visible with no worker configured');
      assert.match(g.statusText, /WORKER_BASE/,
        'SnapTrade should explain that no worker is configured, said: ' + g.statusText);
    }
    console.log('sync buttons: ' + (g.configured
      ? 'shown with a worker, and stop at the passphrase'
      : 'hidden without a worker, and explain themselves when shown'));

    // Crossing the breakpoint while nothing matches the filters used to leave
    // the old footer behind, still summarising rows that are gone and still
    // spanning five columns in a three-column table.
    //
    // Set an explicit wide viewport rather than clearing the override: clearing
    // hands the page back to whatever size the headless window happens to be,
    // which is not the same on every machine and made this assertion flaky.
    await rpc(ws, id++, 'Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 0, mobile: false,
    });
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
        return JSON.stringify({ wide, emptied, width: window.innerWidth });
      })()`,
      returnByValue: true,
    });
    const ef = JSON.parse(emptyFoot.result.value);
    assert.strictEqual(ef.wide, 5,
      'desktop footer should span five columns (viewport was ' + ef.width + 'px)');
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

    /* -------------------------------------------------------------------
     * Portrait leads with the pay date. Still at 390px from the block above.
     * ----------------------------------------------------------------- */
    const payLead = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        const head = [...document.querySelectorAll('#dist-table thead th')]
          .map((th) => ({ cls: th.className, text: th.innerText.trim(),
                          shown: th.offsetParent !== null }));
        // A row whose pay date is known, and one whose pay date is not. Both
        // exist in the real feed: equities get pay dates from Nasdaq, mutual
        // funds have none published anywhere.
        const rows = [...document.querySelectorAll('#dist-body tr.dist-row')].map((tr) => {
          const cell = tr.querySelector('.c-ex');
          const main = cell.querySelector('.date-main');
          const alt = cell.querySelector('.date-alt');
          return {
            sym: tr.querySelector('.sym').textContent,
            main: main ? main.textContent.trim() : null,
            alt: alt ? alt.textContent.trim() : null,
            mainSize: main ? parseFloat(getComputedStyle(main).fontSize) : 0,
            altSize: alt ? parseFloat(getComputedStyle(alt).fontSize) : 0,
            altVisible: alt ? getComputedStyle(alt).display !== 'none' : false,
          };
        });
        return JSON.stringify({ head, rows: rows.slice(0, 40) });
      })()`,
      returnByValue: true,
    });
    const pl = JSON.parse(payLead.result.value);

    const exHead = pl.head.find((h) => h.cls.includes('c-ex'));
    assert.ok(exHead, 'the folded date column has no header');
    assert.match(exHead.text, /Pay date/i,
      'portrait header must name the pay date, got "' + exHead.text + '"');
    assert.doesNotMatch(exHead.text, /Ex-date/i,
      'the wide "Ex-date" label leaked into the portrait header: "' + exHead.text + '"');
    const payHead = pl.head.find((h) => h.cls.includes('c-pay'));
    assert.ok(payHead && !payHead.shown,
      'the separate Pay date column should be folded away in portrait');

    const withPay = pl.rows.filter((r) => /^ex /.test(r.alt || ''));
    const withoutPay = pl.rows.filter((r) => (r.alt || '') === 'ex-date');
    assert.ok(withPay.length, 'no row showed a pay date as its main line');
    assert.ok(withoutPay.length,
      'no row exercised the missing-pay-date fallback; the fixture needs a fund row');

    // The whole request: pay date big, ex date small.
    for (const r of withPay) {
      assert.ok(r.altVisible, r.sym + ': the ex-date line is not visible in portrait');
      assert.ok(r.mainSize > r.altSize,
        r.sym + ': pay date (' + r.mainSize + 'px) is not larger than the ex-date ('
        + r.altSize + 'px)');
      assert.match(r.alt, /^ex /, r.sym + ': the small line is not labelled as the ex-date');
    }
    for (const r of withoutPay) {
      assert.doesNotMatch(r.main, /TBD|^—$/i,
        r.sym + ': a row with no pay date put a placeholder on the prominent line');
      assert.ok(r.mainSize > r.altSize,
        r.sym + ': the ex-date fallback is not the prominent line');
    }

    // Crossing back to the wide layout must restore the ex-date column, or the
    // desktop table would show the pay date twice and no ex-date at all.
    await rpc(ws, id++, 'Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 0, mobile: false,
    });
    await new Promise((r) => setTimeout(r, 400));
    const wideDates = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        render();
        const th = document.querySelector('#dist-table thead th.c-ex');
        const tr = [...document.querySelectorAll('#dist-body tr.dist-row')]
          .find((r) => r.querySelector('.sym').textContent === 'MSFT');
        return JSON.stringify({
          head: th.innerText.trim(),
          ex: tr.querySelector('.c-ex .date-main').textContent.trim(),
          pay: tr.querySelector('.c-pay').textContent.trim(),
          payShown: tr.querySelector('.c-pay').offsetParent !== null,
        });
      })()`,
      returnByValue: true,
    });
    const wd = JSON.parse(wideDates.result.value);
    assert.match(wd.head, /Ex-date/i,
      'the wide header should say Ex-date again, got "' + wd.head + '"');
    assert.doesNotMatch(wd.head, /Pay date/i,
      'the portrait label leaked into the wide header: "' + wd.head + '"');
    assert.ok(wd.payShown, 'the Pay date column should be back at desktop width');
    assert.notStrictEqual(wd.ex, wd.pay,
      'the wide table showed the same date in both the Ex-date and Pay date columns');

    await rpc(ws, id++, 'Emulation.clearDeviceMetricsOverride', {});

    // Pull to refresh. An installed app has no reload button, so this gesture
    // and the service-worker update it triggers are the only way to pick up a
    // new build without force-quitting.
    await rpc(ws, id++, 'Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 0, mobile: true,
    });
    await rpc(ws, id++, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await rpc(ws, id++, 'Runtime.evaluate', {
      expression: 'window.scrollTo(0, 0); state.lastRefreshAt = null;',
    });
    await new Promise((r) => setTimeout(r, 250));

    const touch = (type, y, x = 195) => rpc(ws, id++, 'Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });

    // Record whether the app cancelled each touchmove. This has to be a bubble
    // listener on window - the last thing in the propagation path - because the
    // app's own handler is a bubble listener on document; a capture listener
    // would run first and always see defaultPrevented === false.
    await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        window.__prevented = [];
        window.addEventListener('touchmove', (e) => window.__prevented.push(e.defaultPrevented));
      })()`,
    });

    // A short drag must not fire: an accidental brush should not reload.
    await touch('touchStart', 80);
    await touch('touchMove', 100);
    await new Promise((r) => setTimeout(r, 80));
    await touch('touchEnd', 100);
    await new Promise((r) => setTimeout(r, 400));
    const short = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: 'JSON.stringify({ last: state.lastRefreshAt })',
      returnByValue: true,
    });
    assert.strictEqual(JSON.parse(short.result.value).last, null,
      'a 20px drag should be treated as a scroll, not a refresh');

    // A full drag opens the indicator, arms it, and reloads on release.
    await rpc(ws, id++, 'Runtime.evaluate', { expression: 'window.__prevented = [];' });
    await touch('touchStart', 80);
    let armed = null;
    for (const y of [110, 150, 190, 230, 260]) {
      await touch('touchMove', y);
      await new Promise((r) => setTimeout(r, 40));
    }
    armed = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `JSON.stringify({
        height: document.getElementById('pull-indicator').style.height,
        label: document.querySelector('.pull-text').textContent,
        prevented: window.__prevented,
      })`,
      returnByValue: true,
    });
    const a = JSON.parse(armed.result.value);
    assert.ok(Number.parseFloat(a.height) > 0, 'the pull indicator never opened');
    assert.match(a.label, /Release/, 'the gesture never armed, label said: ' + a.label);
    // Proves the observer below can actually see a cancelled move, so the
    // horizontal assertion is not passing for want of a working listener.
    assert.ok(a.prevented.some(Boolean),
      'a downward pull did not cancel the native scroll, so the page fights the gesture');

    await touch('touchEnd', 260);
    await new Promise((r) => setTimeout(r, 2500));
    const pulled = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `JSON.stringify({
        last: state.lastRefreshAt,
        label: document.querySelector('.pull-text').textContent,
        height: document.getElementById('pull-indicator').style.height,
        rows: document.querySelectorAll('#dist-body tr.dist-row').length,
        meta: document.getElementById('meta').textContent,
      })`,
      returnByValue: true,
    });
    const pr = JSON.parse(pulled.result.value);
    assert.ok(pr.last, 'releasing a full pull did not refresh');
    assert.strictEqual(pr.height, '0px', 'the indicator stayed open after refreshing');
    assert.ok(pr.rows > 0, 'the table was emptied by a refresh');
    assert.ok(/refreshed/i.test(pr.meta), 'meta line lost after refresh: ' + pr.meta);

    // A horizontal swipe must reach the table, not the refresh gesture. Above
    // the fold breakpoint - an iPhone in landscape is 844px wide - the table is
    // genuinely side-scrollable, and preventDefault on the first touchmove of a
    // gesture kills scrolling for the whole gesture.
    await rpc(ws, id++, 'Emulation.setDeviceMetricsOverride', {
      width: 700, height: 500, deviceScaleFactor: 0, mobile: true,
    });
    await rpc(ws, id++, 'Runtime.evaluate', {
      expression: 'window.scrollTo(0, 0); state.lastRefreshAt = null; window.__prevented = [];',
    });
    await new Promise((r) => setTimeout(r, 300));
    await touch('touchStart', 400, 350);
    await touch('touchMove', 403, 300);
    await touch('touchMove', 404, 260);
    await new Promise((r) => setTimeout(r, 80));
    const sideways = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `JSON.stringify({
        prevented: window.__prevented,
        height: document.getElementById('pull-indicator').style.height,
      })`,
      returnByValue: true,
    });
    await touch('touchEnd', 404, 260);
    const sw2 = JSON.parse(sideways.result.value);
    assert.ok(!sw2.prevented.some(Boolean),
      'a sideways swipe was swallowed by pull-to-refresh, so the table cannot be panned');
    assert.ok(!Number.parseFloat(sw2.height),
      'the pull indicator opened on a horizontal swipe: ' + sw2.height);

    await rpc(ws, id++, 'Emulation.setTouchEmulationEnabled', { enabled: false });
    await rpc(ws, id++, 'Emulation.clearDeviceMetricsOverride', {});

    // Everything above ran in one page load. Reload for real: a split that does
    // not survive a restart is worthless, and the migration from the old flat
    // map only ever runs on a cold boot, so it cannot be tested any other way.
    await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        Object.keys(localStorage)
          .filter((k) => k.startsWith('divtracker.'))
          .forEach((k) => localStorage.removeItem(k));
        localStorage.setItem('divtracker.accounts.v1', JSON.stringify([
          { id: 'fidelity', name: 'Fidelity' },
          { id: 'u-s-bank', name: 'U.S. Bank' },
        ]));
        localStorage.setItem('divtracker.holdingLots.v1', JSON.stringify({
          FXAIX: { fidelity: 900, 'u-s-bank': 100 },
        }));
        return 'seeded';
      })()`,
      returnByValue: true,
    });
    await rpc(ws, id++, 'Page.navigate', { url: URL_UNDER_TEST + '?reload=2' });
    await new Promise((r) => setTimeout(r, 2500));
    const reloaded = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `JSON.stringify({
        total: state.holdings.FXAIX,
        accounts: state.accounts.map((a) => a.name),
        boxes: [...document.querySelectorAll('#holdings-inputs input[data-symbol="FXAIX"]')]
          .map((el) => el.dataset.account + '=' + el.value),
        stored: JSON.parse(localStorage.getItem('divtracker.holdings.v1') || 'null'),
      })`,
      returnByValue: true,
    });
    const rl = JSON.parse(reloaded.result.value);
    assert.strictEqual(rl.total, 1000, 'the split did not survive a reload');
    assert.deepStrictEqual(rl.accounts, ['Fidelity', 'U.S. Bank'], 'the account list did not persist');
    assert.deepStrictEqual(rl.boxes, ['fidelity=900', 'u-s-bank=100'],
      'the per-account boxes did not repopulate: ' + rl.boxes);
    assert.deepStrictEqual(rl.stored, { FXAIX: 1000 },
      'the derived totals key drifted from the lots: ' + JSON.stringify(rl.stored));

    // A user upgrading from the flat map must not lose anything, and must not
    // end up with shares filed under an account that has no input box.
    await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        Object.keys(localStorage)
          .filter((k) => k.startsWith('divtracker.'))
          .forEach((k) => localStorage.removeItem(k));
        localStorage.setItem('divtracker.holdings.v1',
          JSON.stringify({ MSFT: 7885.97, FXAIX: 1000 }));
        localStorage.setItem('divtracker.syncMeta.v1',
          JSON.stringify({ at: new Date().toISOString(), source: 'Fidelity' }));
        return 'seeded';
      })()`,
      returnByValue: true,
    });
    await rpc(ws, id++, 'Page.navigate', { url: URL_UNDER_TEST + '?reload=3' });
    await new Promise((r) => setTimeout(r, 2500));
    const upgraded = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        const orphans = Object.values(state.lots)
          .flatMap((byAccount) => Object.keys(byAccount))
          .filter((acc) => !state.accounts.some((a) => a.id === acc));
        return JSON.stringify({
          holdings: state.holdings,
          accounts: state.accounts.map((a) => a.name),
          orphans,
          boxes: [...document.querySelectorAll('#holdings-inputs input[data-symbol="MSFT"]')]
            .map((el) => el.value),
        });
      })()`,
      returnByValue: true,
    });
    const up = JSON.parse(upgraded.result.value);
    assert.deepStrictEqual(up.holdings, { MSFT: 7885.97, FXAIX: 1000 },
      'the upgrade lost share counts: ' + JSON.stringify(up.holdings));
    assert.deepStrictEqual(up.accounts, ['Fidelity'],
      'the migrated account should be named after whatever last wrote the holdings');
    assert.deepStrictEqual(up.orphans, [],
      'shares were filed under an account with no input box: ' + up.orphans);
    assert.deepStrictEqual(up.boxes, ['7885.97'], 'the migrated shares have no editable box');

    // Clear writes an empty lots map. That is a real state, not an absent one,
    // so a reload must not re-run the migration and resurrect the flat map.
    await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        document.getElementById('clear-holdings').click();
        return JSON.stringify({
          holdings: localStorage.getItem('divtracker.holdings.v1'),
          lots: localStorage.getItem('divtracker.holdingLots.v1'),
        });
      })()`,
      returnByValue: true,
    });
    await rpc(ws, id++, 'Page.navigate', { url: URL_UNDER_TEST + '?reload=4' });
    await new Promise((r) => setTimeout(r, 2500));
    const cleared = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: 'JSON.stringify({ holdings: state.holdings, lots: state.lots })',
      returnByValue: true,
    });
    const cl = JSON.parse(cleared.result.value);
    assert.deepStrictEqual(cl.holdings, {},
      'Clear was undone by a reload: ' + JSON.stringify(cl.holdings));
    assert.deepStrictEqual(cl.lots, {}, 'lots came back after Clear');

    // An older build can only write the flat map. Overwriting it from the
    // stale lots on the next boot would silently discard those edits.
    await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `(() => {
        Object.keys(localStorage)
          .filter((k) => k.startsWith('divtracker.'))
          .forEach((k) => localStorage.removeItem(k));
        localStorage.setItem('divtracker.accounts.v1', JSON.stringify([
          { id: 'fidelity', name: 'Fidelity' },
          { id: 'u-s-bank', name: 'U.S. Bank' },
        ]));
        localStorage.setItem('divtracker.holdingLots.v1', JSON.stringify({
          FXAIX: { fidelity: 900, 'u-s-bank': 100 }, MSFT: { fidelity: 10 },
        }));
        // What an older build leaves behind after the user edits MSFT there.
        localStorage.setItem('divtracker.holdings.v1',
          JSON.stringify({ FXAIX: 1000, MSFT: 25 }));
        return 'seeded';
      })()`,
      returnByValue: true,
    });
    await rpc(ws, id++, 'Page.navigate', { url: URL_UNDER_TEST + '?reload=5' });
    await new Promise((r) => setTimeout(r, 2500));
    const rolledForward = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: 'JSON.stringify({ holdings: state.holdings, fxaix: state.lots.FXAIX })',
      returnByValue: true,
    });
    const rec2 = JSON.parse(rolledForward.result.value);
    assert.strictEqual(rec2.holdings.MSFT, 25,
      'an edit made by an older build was discarded: ' + JSON.stringify(rec2.holdings));
    assert.deepStrictEqual(rec2.fxaix, { fidelity: 900, 'u-s-bank': 100 },
      'a symbol nobody touched lost its split: ' + JSON.stringify(rec2.fxaix));

    console.log('\nfilters: history=' + hist.paid + ' paid rows, confirmed-only='
      + confirmed.total + ' rows, chip filter OK');
    console.log('csv import: ' + imported.status);
    console.log('staleness: quiet when current, warns when stale');
    console.log('quarters: ' + q.rows + ' rows in ' + q.runs + ' contiguous bands, all labelled');
    console.log('portrait 390px: date + amount side by side, no horizontal scroll');
    console.log('portrait dates: pay date large, ex-date small, header says Pay date,');
    console.log('                and rows with no pay date lead with the ex-date');
    console.log('footer: cleared when empty, colspan follows the layout');
    console.log('pull to refresh: ignores a short drag, reloads on a full one,');
    console.log('                and lets a sideways swipe pan the table');
    console.log('reload: the split persists, the flat map upgrades cleanly,');
    console.log('        and Clear is not undone by a restart');
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
