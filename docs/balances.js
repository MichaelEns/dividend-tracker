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
  // True while Plaid Link is open. Reading a texted verification code means
  // leaving the app, so a bank that uses SMS guarantees a visibilitychange on
  // the way back - the one moment the page must sit still and do nothing.
  linking: false,
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

/**
 * Why a bank could not be read, in words the person looking at it can act on.
 *
 * The audience is whoever opens the app, not whoever built it. "ITEM_LOGIN_
 * REQUIRED" tells them nothing; "needs to be reconnected" tells them the one
 * thing they can do about it. Anything unrecognised falls back to saying it
 * could not be read, which is at least true and never misleading.
 */
const CONNECTION_PROBLEMS = {
  ITEM_LOGIN_REQUIRED: 'needs to be reconnected \u2014 its sign-in has expired',
  ITEM_LOCKED: 'is locked at the bank \u2014 sign in on the bank\u2019s own site first',
  INVALID_CREDENTIALS: 'needs to be reconnected \u2014 the saved sign-in no longer works',
  INVALID_MFA: 'needs to be reconnected \u2014 the bank asked for a new code',
  PENDING_EXPIRATION: 'needs to be reconnected soon',
  USER_PERMISSION_REVOKED: 'was disconnected at the bank',
  USER_ACCOUNT_REVOKED: 'was disconnected at the bank',
  INSTITUTION_DOWN: 'is temporarily unavailable at the bank\u2019s end',
  INSTITUTION_NOT_RESPONDING: 'is not responding \u2014 usually temporary',
  INSTITUTION_NO_LONGER_SUPPORTED: 'can no longer be read by this app',
  RATE_LIMIT_EXCEEDED: 'was read too often \u2014 try again in a few minutes',
};

function describeConnectionProblem(institution) {
  const name = (institution && institution.institution) || 'A bank';
  const code = institution && institution.errorCode;
  return `${name} ${(code && CONNECTION_PROBLEMS[code]) || 'could not be read just now'}.`;
}

/** The banks in this reading that could not be read at all. */
function unreadable(institutions) {
  return (institutions || []).filter((i) => i && i.error);
}

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
  const broken = unreadable(state.institutions);
  const count = state.institutions.length - broken.length;
  // A bank that failed must not be counted among the ones that were read, or
  // the header claims a reading it did not get.
  el.textContent = `${count} institution${count === 1 ? '' : 's'} — read ${describeAge(age)}`
    + (broken.length ? ` · ${broken.length} could not be read` : '');
  el.className = 'meta ' + (broken.length ? 'ancient' : level);
}

function renderSummary() {
  const box = document.getElementById('summary-cards');
  if (!box) return;
  // The panel is hidden rather than left empty: an empty rounded card is the
  // first thing you see before any bank is linked, and it reads as something
  // that failed to load.
  const panel = document.getElementById('summary-panel');
  const all = state.institutions.flatMap((i) => i.accounts || []);
  if (all.length === 0) {
    box.innerHTML = '';
    if (panel) panel.hidden = true;
    return;
  }
  if (panel) panel.hidden = false;

  const inGroup = (id) => all.filter((a) => groupOf(a) === id);
  const cards = [
    { label: 'Cash', accounts: inGroup('depository') },
    { label: 'Owed', accounts: inGroup('credit'), owed: true },
  ];
  const investments = inGroup('investment');
  if (investments.length) cards.push({ label: 'Investments', accounts: investments });

  const net = totalByCurrency(all);
  const broken = unreadable(state.institutions);
  box.innerHTML = cards.filter((c) => c.accounts.length).map((c) => `
    <div class="card">
      <div class="label">${escapeHtml(c.label)}</div>
      <div class="value">${escapeHtml(
        (c.owed ? formatOwed : formatTotals)(totalByCurrency(c.accounts)),
      )}</div>
      <div class="sub">${c.accounts.length} account${c.accounts.length === 1 ? '' : 's'}</div>
    </div>`).join('') + `
    <div class="card${broken.length ? ' incomplete' : ''}">
      <div class="label">Net</div>
      <div class="value">${escapeHtml(formatTotals(net))}</div>
      <div class="sub">${broken.length
        // Presenting a smaller number as the total is the failure that matters:
        // it is wrong in the direction that makes someone think they have less
        // room than they do, or more.
        ? `does NOT include ${broken.length} bank${broken.length === 1 ? '' : 's'} that could not be read`
        : 'everything owed subtracted'}</div>
    </div>`;
}

function renderBalances() {
  const panel = document.getElementById('balances-panel');
  const body = document.getElementById('balances-body');
  const empty = document.getElementById('empty-state');
  if (!panel || !body) return;

  if (state.institutions.length === 0) {
    // Cleared, not just hidden: leaving the markup in place keeps a bank that
    // has since been disconnected sitting in the DOM, ready to reappear the
    // next time the panel is shown for some unrelated reason.
    body.innerHTML = '';
    panel.hidden = true;
    if (empty) empty.hidden = !WORKER_BASE;
    return;
  }
  panel.hidden = false;
  if (empty) empty.hidden = true;

  body.innerHTML = state.institutions.map((inst) => {
    // A bank that could not be read renders as a problem, not as an absence.
    // Dropping it made a broken connection look identical to a bank with no
    // accounts: it left the totals quietly, and nothing on the page said so.
    if (inst.error) {
      return `<section class="bal-institution bal-unreadable">
        <h3 class="bal-inst-name">${escapeHtml(inst.institution || 'Bank')}
          <span class="bal-inst-total">not read</span>
        </h3>
        <p class="bal-problem">${escapeHtml(describeConnectionProblem(inst))}</p>
      </section>`;
    }

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
    const broken = unreadable(state.institutions);
    if (broken.length) {
      // Shown even on a quiet refresh. Auto-refresh is the only kind most
      // people ever trigger, so suppressing this as "noise" meant a bank could
      // drop out of the totals and never once say so.
      setStatus(broken.map(describeConnectionProblem).join(' '), 'error');
    } else if (!quiet) {
      const n = state.institutions.reduce((sum, i) => sum + (i.accounts || []).length, 0);
      setStatus(`Read ${n} account(s) from ${state.institutions.length} institution(s).`, 'ok');
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
 * Where Plaid Link was when it closed, in plain English.
 *
 * Link reports the step as a machine token; naming it is the difference
 * between "it didn't work" and knowing the code was the part that failed.
 */
const LINK_STEPS = {
  requires_credentials: 'entering your username and password',
  requires_code: 'entering the verification code',
  choose_device: 'choosing where the code was sent',
  requires_questions: 'answering the security questions',
  requires_selections: 'answering the security questions',
  requires_account_selection: 'choosing which accounts to share',
  requires_oauth: 'signing in at the bank',
  institution_not_found: 'searching for the bank',
};

/**
 * Turn a Plaid Link exit into something a person can act on.
 *
 * The useful parts are split across both arguments, and the original handler
 * used only the first: the error says what went wrong, `metadata.status` says
 * how far the flow got, and `metadata.request_id` is the one thing Plaid
 * support asks for. Dropping the last two made "the bank refused the code"
 * indistinguishable from "you changed your mind".
 *
 * Always states that nothing was consumed. A sign-in that never completes
 * creates no Item, so it costs none of the ten a free Plaid account ever gets,
 * and being unsure of that is its own reason not to try again.
 */
function describeLinkExit(err, metadata) {
  const meta = metadata || {};
  const bank = (meta.institution && meta.institution.name) || 'The bank';
  const step = LINK_STEPS[meta.status];
  const safe = 'Nothing was linked, and no bank connection was used up.';

  if (!err) {
    return {
      level: 'ok',
      text: step
        ? `Sign-in stopped at ${step}. ${safe}`
        : `Bank sign-in cancelled. ${safe}`,
    };
  }

  // display_message is Plaid's own wording for the end user, and the only one
  // of the three written to be read; the codes are for us.
  const why = err.display_message || err.error_message || err.error_code || 'it did not complete';
  const where = step ? ` It stopped at ${step}.` : '';
  const ref = meta.request_id ? ` Plaid reference ${meta.request_id}.` : '';
  return { level: 'error', text: `${bank}: ${why}${where} ${safe}${ref}` };
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
    const { link_token: linkToken } = await workerPost(
      '/link/token/create', { scope: 'balances' }, key,
    );
    if (!linkToken) throw new Error('The worker did not return a link_token.');
    await loadPlaidSdk();
    setStatus('Sign in to your bank in the Plaid window. Each bank is linked once.', 'ok');

    const handler = window.Plaid.create({
      token: linkToken,
      onSuccess: async (publicToken) => {
        // Cleared before the reads below, which are ordinary page work and
        // should not leave auto-refresh switched off if one of them throws.
        state.linking = false;
        try {
          // Link hands back a short-lived public token and nothing else. It has
          // to be exchanged for the long-lived one the worker stores, or the
          // sign-in succeeds and the bank is never actually connected.
          setStatus('Linked. Storing the connection…', 'ok');
          await workerPost(
            '/link/token/exchange', { public_token: publicToken, scope: 'balances' }, key,
          );
          setStatus('Linked. Reading balances…', 'ok');
          await refreshBalances();
          await refreshConnections(key);
        } catch (err) {
          setStatus('Linked, but reading balances failed: ' + err.message, 'error');
        } finally {
          if (button) { button.disabled = false; button.textContent = original; }
        }
      },
      onExit: (err, metadata) => {
        state.linking = false;
        if (button) { button.disabled = false; button.textContent = original; }
        const exit = describeLinkExit(err, metadata);
        setStatus(exit.text, exit.level);
      },
      onEvent: () => {},
    });
    state.linking = true;
    handler.open();
  } catch (err) {
    state.linking = false;
    setStatus('Could not start bank sign-in: ' + err.message, 'error');
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

/**
 * Reopen a bank you already linked, to change which accounts it shares.
 *
 * Plaid asks which accounts to share during sign-in, and a bank that offered
 * only a credit card leaves the rest invisible. This is Link's update mode: it
 * reuses the existing connection, so unlike linking again it does not consume
 * one of the ten Trial connections.
 */
async function editAccounts() {
  if (!WORKER_BASE) return;
  const key = getSyncKey(true);
  if (!key) {
    setStatus('A sync passphrase is required.', 'error');
    return;
  }
  const button = document.getElementById('edit-accounts-balances');
  const original = button ? button.textContent : '';
  try {
    if (button) { button.disabled = true; button.textContent = 'Preparing…'; }
    const target = state.connections && state.connections.length === 1
      ? state.connections[0].key
      : (state.connections || []).map((c) => c.key)[0];
    const { link_token: linkToken, institution } = await workerPost(
      // Deliberately does NOT narrow the products. Link only offers accounts
      // supporting every product asked for, so narrowing hides account types
      // rather than revealing them - asking for `auth` would exclude credit
      // cards, and a card-only connection would have nothing left to select.
      '/link/token/update', { key: target }, key,
    );
    if (!linkToken) throw new Error('The worker did not return a link_token.');
    await loadPlaidSdk();
    setStatus(
      `Sign in to ${institution || 'your bank'} and tick any accounts you want `
      + 'added. This reuses the existing connection, so it costs nothing.', 'ok',
    );

    const handler = window.Plaid.create({
      token: linkToken,
      // Update mode reuses the Item, so there is no public token to exchange
      // and nothing new to store - only the account list has changed.
      onSuccess: async () => {
        state.linking = false;
        try {
          setStatus('Accounts updated. Reading balances…', 'ok');
          await refreshBalances();
          await refreshConnections(key);
        } catch (err) {
          setStatus('Accounts updated, but reading balances failed: ' + err.message, 'error');
        } finally {
          if (button) { button.disabled = false; button.textContent = original; }
        }
      },
      onExit: (err, metadata) => {
        state.linking = false;
        if (button) { button.disabled = false; button.textContent = original; }
        const exit = describeLinkExit(err, metadata);
        setStatus(err ? exit.text : 'No changes made.', exit.level);
      },
      onEvent: () => {},
    });
    state.linking = true;
    handler.open();
  } catch (err) {
    state.linking = false;
    setStatus('Could not reopen the bank: ' + err.message, 'error');
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
    const edit = document.getElementById('edit-accounts-balances');
    if (add) add.hidden = false;
    if (sync) sync.hidden = !status.connected;
    // Only offered once something is linked: it reopens an existing connection.
    if (edit) edit.hidden = !status.connected;
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
    // These listeners are on window and call preventDefault, so they must stand
    // down entirely while Plaid Link is over the page.
    if (state.linking) return;
    startY = event.touches[0].clientY;
    startX = event.touches[0].clientX;
    pulling = false;
    decided = false;
  }, { passive: true });

  window.addEventListener('touchmove', (event) => {
    if (startY === null || state.linking) return;
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
  const edit = document.getElementById('edit-accounts-balances');
  if (edit) edit.addEventListener('click', () => editAccounts());
  setupPullToRefresh();

  // A balance is worth re-reading on every open and every resume - unlike a
  // share count, it changes whenever money moves, and one request is cheap.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Not while signing in. A texted code has to be read somewhere else, so
    // this fires on the way back from Messages every single time - refreshing
    // underneath a half-finished sign-in at best rewrites the status message
    // telling the user what to do, and at worst disturbs the flow itself.
    if (state.linking) return;
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
    describeLinkExit,
    describeConnectionProblem,
    unreadable,
    describeAge,
    money,
    GROUPS,
  };
}
