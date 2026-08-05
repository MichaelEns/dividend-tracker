/*
 * Balances page.
 *
 * Deliberately separate from app.js rather than another mode of it. The two
 * pages answer different questions from different endpoints: the dividend page
 * projects income from share counts, this one reports what is in the accounts
 * right now. Sharing a script would mean loading a projection engine to show a
 * chequing balance.
 *
 * What they do share is the worker, the passphrase and the stylesheet, so a
 * bank linked on either page is linked for both.
 */
'use strict';

const CONFIG = (typeof window !== 'undefined' && window.DIVTRACKER_CONFIG) || {};
const WORKER_BASE = String(CONFIG.WORKER_BASE || '').replace(/\/+$/, '');
const SYNC_KEY_KEY = 'divtracker.syncKey.v1';
const BALANCES_KEY = 'divtracker.balances.v1';

/*
 * A balance is stale far sooner than a share count. Share counts move when a
 * trade settles; a chequing balance moves when you buy coffee. Anything over an
 * hour is worth flagging, and anything over a day is worth not trusting.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;
const ANCIENT_AFTER_MS = 24 * 60 * 60 * 1000;

const state = {
  institutions: [],
  readAt: null,
  errors: [],
  connections: [],
  refreshing: false,
};

/* ------------------------------------------------------------- utilities */

function load(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function save(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked */ }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Fold a passphrase to the form the worker compares.
 *
 * Must agree exactly with normalizePassphrase in app.js and worker/src/auth.js.
 * Also makes the value ASCII, which matters because an HTTP header is a byte
 * string and fetch throws outright on anything above U+00FF - iOS turns a
 * straight apostrophe into U+2019 without being asked.
 */
function normalizePassphrase(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function money(value, currency) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  try {
    return value.toLocaleString(undefined, {
      style: 'currency',
      currency: currency || 'CAD',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    // narrowSymbol is unsupported on older Safari, and an unknown currency
    // code throws outright. Neither is a reason to show nothing.
    return (value < 0 ? '-' : '') + '$' + Math.abs(value).toFixed(2);
  }
}

function describeAge(ms) {
  if (ms == null) return 'never';
  // Floor, not round: rounding calls a 30-second-old reading "a minute ago"
  // and a 31-minute-old one "an hour ago". "An hour ago" conventionally means
  // between one and two hours, which is what flooring gives.
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return 'a minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return 'an hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/* --------------------------------------------------------------- grouping */

/**
 * Which section an account belongs in.
 *
 * Plaid's `type` is the right level to group at: a chequing account and a
 * savings account are both money you have, while a credit card and a mortgage
 * are both money you owe, and mixing them into one list makes the totals
 * meaningless.
 */
const GROUPS = [
  { id: 'depository', label: 'Cash', types: ['depository'] },
  { id: 'credit', label: 'Owed', types: ['credit', 'loan'] },
  { id: 'investment', label: 'Investments', types: ['investment', 'brokerage'] },
  { id: 'other', label: 'Other', types: [] },
];

function groupOf(account) {
  const type = String((account && account.type) || '').toLowerCase();
  const hit = GROUPS.find((g) => g.types.includes(type));
  return (hit || GROUPS[GROUPS.length - 1]).id;
}

/**
 * Sum a list of accounts, in the currency they are actually in.
 *
 * Returns one total per currency rather than one number. Adding CAD to USD
 * would produce a figure that is wrong in both, and this is a page that will
 * routinely hold both.
 */
function totalByCurrency(accounts) {
  const totals = new Map();
  for (const a of accounts || []) {
    if (typeof a.current !== 'number') continue;
    const cur = a.currency || 'CAD';
    totals.set(cur, (totals.get(cur) || 0) + a.current);
  }
  return [...totals.entries()].map(([currency, amount]) => ({ currency, amount }));
}

function formatTotals(totals) {
  if (!totals.length) return '—';
  return totals.map((t) => money(t.amount, t.currency)).join(' + ');
}

/**
 * The same, for a figure already labelled "Owed".
 *
 * Debts are stored negative so that a net total means something, but under a
 * heading that says "Owed", a minus sign reads as the opposite of what it is —
 * as though the bank owed you. Individual rows already drop it, so the
 * headings have to as well or the two disagree on screen.
 */
function formatOwed(totals) {
  return formatTotals(totals.map((t) => ({ ...t, amount: Math.abs(t.amount) })));
}

/* --------------------------------------------------------------- rendering */

function setStatus(message, kind) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = message || '';
  el.className = 'hint' + (kind ? ' ' + kind : '');
  el.hidden = !message;
}

function renderMeta() {
  const el = document.getElementById('meta');
  if (!el) return;
  if (!state.readAt) {
    el.textContent = WORKER_BASE ? 'Not read yet' : 'No sync worker configured';
    return;
  }
  const age = Date.now() - Date.parse(state.readAt);
  const level = age >= ANCIENT_AFTER_MS ? 'ancient' : age >= STALE_AFTER_MS ? 'stale' : 'fresh';
  const count = state.institutions.length;
  el.textContent = `${count} institution${count === 1 ? '' : 's'} — read ${describeAge(age)}`;
  el.className = 'meta ' + level;
}

function renderSummary() {
  const box = document.getElementById('summary-cards');
  if (!box) return;
  const all = state.institutions.flatMap((i) => i.accounts || []);
  if (all.length === 0) { box.innerHTML = ''; return; }

  const inGroup = (id) => all.filter((a) => groupOf(a) === id);
  const cards = [
    { label: 'Cash', accounts: inGroup('depository') },
    { label: 'Owed', accounts: inGroup('credit'), owed: true },
  ];
  const investments = inGroup('investment');
  if (investments.length) cards.push({ label: 'Investments', accounts: investments });

  const net = totalByCurrency(all);
  box.innerHTML = cards.filter((c) => c.accounts.length).map((c) => `
    <div class="card">
      <div class="label">${escapeHtml(c.label)}</div>
      <div class="value">${escapeHtml(
        (c.owed ? formatOwed : formatTotals)(totalByCurrency(c.accounts)),
      )}</div>
      <div class="sub">${c.accounts.length} account${c.accounts.length === 1 ? '' : 's'}</div>
    </div>`).join('') + `
    <div class="card">
      <div class="label">Net</div>
      <div class="value">${escapeHtml(formatTotals(net))}</div>
      <div class="sub">everything owed subtracted</div>
    </div>`;
}

function renderBalances() {
  const panel = document.getElementById('balances-panel');
  const body = document.getElementById('balances-body');
  const empty = document.getElementById('empty-state');
  if (!panel || !body) return;

  if (state.institutions.length === 0) {
    panel.hidden = true;
    if (empty) empty.hidden = !WORKER_BASE;
    return;
  }
  panel.hidden = false;
  if (empty) empty.hidden = true;

  body.innerHTML = state.institutions.map((inst) => {
    const accounts = inst.accounts || [];
    const groups = GROUPS
      .map((g) => ({ ...g, rows: accounts.filter((a) => groupOf(a) === g.id) }))
      .filter((g) => g.rows.length);

    const rows = groups.map((g) => `
      <h4 class="bal-group">${escapeHtml(g.label)}
        <span class="bal-group-total">${escapeHtml(
          (g.id === 'credit' ? formatOwed : formatTotals)(totalByCurrency(g.rows)),
        )}</span>
      </h4>
      <ul class="bal-list">
        ${g.rows.map((a) => {
          // A negative figure here is money owed, which reads better as a
          // positive number labelled "owed" than as a minus sign to decode.
          const owed = a.current != null && a.current < 0;
          const shown = owed ? money(Math.abs(a.current), a.currency) : money(a.current, a.currency);
          // available differs from current when a hold or a credit limit is in
          // play, and only then is it worth the extra line.
          const extra = a.available != null && a.available !== a.current
            ? `<span class="bal-extra">${escapeHtml(money(Math.abs(a.available), a.currency))} ${owed ? 'available to spend' : 'available'}</span>`
            : '';
          return `<li class="bal-row${owed ? ' owed' : ''}">
            <span class="bal-name">${escapeHtml(a.shortName || a.name)}${
              a.mask ? `<span class="bal-mask">••${escapeHtml(a.mask)}</span>` : ''}</span>
            <span class="bal-amount">${escapeHtml(shown)}${owed ? '<span class="bal-owed">owed</span>' : ''}${extra}</span>
          </li>`;
        }).join('')}
      </ul>`).join('');

    return `<section class="bal-institution">
      <h3 class="bal-inst-name">${escapeHtml(inst.institution || 'Bank')}
        <span class="bal-inst-total">${escapeHtml(formatTotals(totalByCurrency(accounts)))}</span>
      </h3>
      ${rows}
    </section>`;
  }).join('');
}

function renderConnections() {
  const box = document.getElementById('connection-list');
  if (!box) return;
  const list = state.connections || [];
  if (!WORKER_BASE || list.length === 0) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = '<span class="connections-label">Linked:</span>'
    + list.map((c) => `<span class="connection">${escapeHtml(c.institution || 'Bank')}</span>`).join('');
}

function render() {
  renderMeta();
  renderSummary();
  renderBalances();
  renderConnections();
}

/* ----------------------------------------------------------- worker calls */

function getSyncKey(promptIfMissing) {
  let key = '';
  try { key = window.localStorage.getItem(SYNC_KEY_KEY) || ''; } catch { key = ''; }
  if (!key && promptIfMissing) {
    key = (window.prompt('Enter the sync passphrase you set on the worker (SYNC_PASSPHRASE):') || '').trim();
    if (key) { try { window.localStorage.setItem(SYNC_KEY_KEY, key); } catch { /* ignore */ } }
  }
  return key;
}

async function workerPost(path, body, key) {
  const resp = await fetch(`${WORKER_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sync-Key': normalizePassphrase(key),
    },
    body: JSON.stringify(body || {}),
  });
  let payload = null;
  try { payload = await resp.json(); } catch { /* leave null */ }
  if (!resp.ok) {
    if (resp.status === 401) {
      try { window.localStorage.removeItem(SYNC_KEY_KEY); } catch { /* ignore */ }
      throw new Error('Worker rejected the passphrase. It has been cleared; try again.');
    }
    throw new Error((payload && payload.error) || `Worker ${path} returned HTTP ${resp.status}`);
  }
  return payload || {};
}

function commit(payload) {
  state.institutions = (payload && payload.institutions) || [];
  state.errors = (payload && payload.errors) || [];
  state.readAt = new Date().toISOString();
  // Cached so a cold open shows the last known figures immediately rather than
  // an empty page, with the header saying how old they are.
  save(BALANCES_KEY, {
    institutions: state.institutions, errors: state.errors, readAt: state.readAt,
  });
  render();
}

async function refreshBalances(options) {
  const quiet = !!(options && options.quiet);
  if (!WORKER_BASE || state.refreshing) return false;
  const key = quiet ? getSyncKey(false) : getSyncKey(true);
  if (!key) {
    if (!quiet) setStatus('A sync passphrase is required. Set SYNC_PASSPHRASE on the worker first.', 'error');
    return false;
  }

  const button = document.getElementById('sync-balances');
  const original = button ? button.textContent : '';
  state.refreshing = true;
  try {
    if (button && !quiet) { button.disabled = true; button.textContent = 'Reading…'; }
    const payload = await workerPost('/balances', {}, key);
    if (!payload.connected) {
      if (!quiet) setStatus('No bank is linked yet. Press “Link a bank” to add one.', 'ok');
      return false;
    }
    commit(payload);
    if (!quiet) {
      const n = state.institutions.reduce((sum, i) => sum + (i.accounts || []).length, 0);
      setStatus(`Read ${n} account(s) from ${state.institutions.length} institution(s).`
        + (state.errors.length ? ' ' + state.errors.join('; ') : ''),
        state.errors.length ? 'error' : 'ok');
    }
    return true;
  } catch (err) {
    // Quiet refreshes run without being asked, so a banner would be noise; the
    // header ages by itself and says the figures are old.
    if (!quiet) setStatus('Could not read balances: ' + err.message, 'error');
    return false;
  } finally {
    state.refreshing = false;
    if (button && !quiet) { button.disabled = false; button.textContent = original; }
  }
}

function loadPlaidSdk() {
  if (window.Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the Plaid Link SDK. Check your network.'));
    document.head.appendChild(s);
  });
}

/**
 * Link another bank.
 *
 * Always opens Plaid Link rather than short-circuiting to a refresh, because
 * there is no other route to a second institution - the same trap the dividend
 * page hit, where linking one bank made the Link flow unreachable.
 */
async function linkBank() {
  if (!WORKER_BASE) return;
  const key = getSyncKey(true);
  if (!key) {
    setStatus('A sync passphrase is required. Set SYNC_PASSPHRASE on the worker first.', 'error');
    return;
  }
  const button = document.getElementById('add-bank-balances');
  const original = button ? button.textContent : '';
  try {
    if (button) { button.disabled = true; button.textContent = 'Preparing sign-in…'; }
    const { link_token: linkToken } = await workerPost('/link/token/create', {}, key);
    if (!linkToken) throw new Error('The worker did not return a link_token.');
    await loadPlaidSdk();
    setStatus('Sign in to your bank in the Plaid window. Each bank is linked once.', 'ok');

    const handler = window.Plaid.create({
      token: linkToken,
      onSuccess: async () => {
        try {
          setStatus('Linked. Reading balances…', 'ok');
          await refreshBalances();
          await refreshConnections(key);
        } catch (err) {
          setStatus('Linked, but reading balances failed: ' + err.message, 'error');
        } finally {
          if (button) { button.disabled = false; button.textContent = original; }
        }
      },
      onExit: (err) => {
        if (button) { button.disabled = false; button.textContent = original; }
        if (err) setStatus('Bank sign-in cancelled or errored: ' + (err.error_message || err.error_code || 'exited'), 'error');
        else setStatus('Bank sign-in cancelled.', 'ok');
      },
      onEvent: () => {},
    });
    handler.open();
  } catch (err) {
    setStatus('Could not start bank sign-in: ' + err.message, 'error');
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

async function refreshConnections(key) {
  if (!WORKER_BASE) return;
  try {
    const status = await workerPost('/status', {}, key || getSyncKey(false));
    state.connections = status.connections || [];
    const add = document.getElementById('add-bank-balances');
    const sync = document.getElementById('sync-balances');
    if (add) add.hidden = false;
    if (sync) sync.hidden = !status.connected;
    renderConnections();
  } catch { /* a status check must never break the page */ }
}

/* ---------------------------------------------------------------- pull */

const PULL_TRIGGER_PX = 64;
const PULL_MAX_PX = 96;
const PULL_SLOP_PX = 10;

function setupPullToRefresh() {
  const indicator = document.getElementById('pull-indicator');
  if (!indicator) return;
  let startY = null;
  let startX = null;
  let pulling = false;
  let decided = false;

  window.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;
    if (window.scrollY > 0) return;
    startY = event.touches[0].clientY;
    startX = event.touches[0].clientX;
    pulling = false;
    decided = false;
  }, { passive: true });

  window.addEventListener('touchmove', (event) => {
    if (startY === null) return;
    const dy = event.touches[0].clientY - startY;
    const dx = event.touches[0].clientX - startX;
    if (!decided) {
      if (Math.abs(dy) < PULL_SLOP_PX && Math.abs(dx) < PULL_SLOP_PX) return;
      // A sideways swipe belongs to whatever is underneath; only commit to a
      // pull once the gesture is clearly vertical.
      decided = true;
      pulling = dy > 0 && Math.abs(dy) > Math.abs(dx);
      if (!pulling) { startY = null; return; }
    }
    if (!pulling) return;
    const travel = Math.min(dy * 0.5, PULL_MAX_PX);
    indicator.style.height = travel + 'px';
    indicator.querySelector('.pull-text').textContent =
      travel >= PULL_TRIGGER_PX ? 'Release to refresh' : 'Pull to refresh';
    if (event.cancelable) event.preventDefault();
  }, { passive: false });

  window.addEventListener('touchend', () => {
    if (!pulling) { startY = null; return; }
    const travel = parseFloat(indicator.style.height) || 0;
    startY = null;
    pulling = false;
    if (travel >= PULL_TRIGGER_PX) {
      indicator.querySelector('.pull-text').textContent = 'Refreshing…';
      refreshBalances().finally(() => {
        window.setTimeout(() => { indicator.style.height = '0px'; }, 400);
      });
    } else {
      indicator.style.height = '0px';
    }
  }, { passive: true });
}

/* ---------------------------------------------------------------- init */

async function init() {
  const cached = load(BALANCES_KEY, null);
  if (cached && Array.isArray(cached.institutions)) {
    state.institutions = cached.institutions;
    state.errors = cached.errors || [];
    state.readAt = cached.readAt || null;
  }
  render();

  const setup = document.getElementById('setup-hint');
  if (setup) setup.hidden = Boolean(WORKER_BASE);
  if (!WORKER_BASE) return;

  const sync = document.getElementById('sync-balances');
  if (sync) sync.addEventListener('click', () => refreshBalances());
  const add = document.getElementById('add-bank-balances');
  if (add) add.addEventListener('click', () => linkBank());

  setupPullToRefresh();

  // A balance is worth re-reading on every open and every resume - unlike a
  // share count, it changes whenever money moves, and one request is cheap.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    renderMeta();
    refreshBalances({ quiet: true });
  });

  if (getSyncKey(false)) {
    await refreshConnections();
    refreshBalances({ quiet: true });
  } else {
    const addBtn = document.getElementById('add-bank-balances');
    if (addBtn) addBtn.hidden = false;
    setStatus('Enter your sync passphrase to read balances.', 'ok');
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

// Exported for unit testing; the browser only ever runs init().
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizePassphrase,
    groupOf,
    totalByCurrency,
    formatTotals,
    formatOwed,
    describeAge,
    money,
    GROUPS,
  };
}
