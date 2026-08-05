/*
 * Loads the published balances page and checks it behaves with nothing linked.
 *
 * The empty state is the state the page will actually be in until a Plaid
 * Trial account exists, so it is the one worth proving: it must explain itself
 * rather than showing a blank panel or a spurious error.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BROWSER = process.argv[2];
const URL_UNDER_TEST = process.argv[3]
  || 'https://michaelens.github.io/dividend-tracker/balances.html';
const CDP_PORT = 9254;

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '\n         ' + extra : ''));
  if (!cond) fails += 1;
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

async function main() {
  if (!BROWSER) throw new Error('usage: node tests/balances-live.cjs <browser> [url]');
  const profile = path.join(os.tmpdir(), 'ballive-' + Date.now());
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

    const problems = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        problems.push(msg.params.exceptionDetails.exception?.description || 'exception');
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        problems.push(msg.params.entry.text);
      }
    });

    await rpc(ws, id++, 'Runtime.enable', {});
    await rpc(ws, id++, 'Log.enable', {});
    await rpc(ws, id++, 'Page.enable', {});
    await rpc(ws, id++, 'Page.navigate', { url: URL_UNDER_TEST });
    await new Promise((r) => setTimeout(r, 6000));

    const evalJs = async (expression) => {
      const r = await rpc(ws, id++, 'Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
      return r.result.value;
    };

    const view = JSON.parse(await evalJs(`JSON.stringify({
      title: document.title,
      h1: document.querySelector('h1') ? document.querySelector('h1').textContent.trim() : null,
      empty: document.getElementById('empty-state') ? {
        hidden: document.getElementById('empty-state').hidden,
        text: document.getElementById('empty-state').innerText.trim(),
      } : null,
      panelHidden: document.getElementById('balances-panel').hidden,
      summaryHidden: document.getElementById('summary-panel').hidden,
      addHidden: document.getElementById('add-bank-balances').hidden,
      status: document.getElementById('sync-status').textContent.trim(),
      backLink: !!document.querySelector('.page-nav a'),
      styled: getComputedStyle(document.body).fontFamily,
    })`));

    console.log('  page: ' + view.h1 + ' — ' + view.title);
    check('the page loads and is the balances page', /balance/i.test(view.h1 || ''), view.h1);
    check('the stylesheet applied', /\w/.test(view.styled || ''), view.styled);
    check('there is a way back to the dividend page', view.backLink);
    check('with nothing linked, the table is hidden', view.panelHidden === true);
    check('and the page explains itself instead of going blank',
      view.empty && view.empty.hidden === false && view.empty.text.length > 20,
      view.empty && view.empty.text.replace(/\n/g, ' | '));
    check('the link-a-bank button is offered', view.addHidden === false);
    check('no empty summary card is shown before anything is linked',
      view.summaryHidden === true,
      'an empty rounded panel reads as something that failed to load');
    check('no error is shown when nothing is wrong',
      !/error|failed|could not/i.test(view.status), view.status);
    check('no console errors', problems.length === 0, problems.slice(0, 3).join(' | '));

    console.log(fails === 0 ? '\nLIVE PAGE VERIFIED' : `\n${fails} CHECK(S) FAILED`);
  } finally {
    if (ws) ws.close();
    try { process.kill(proc.pid); } catch { /* gone */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
