/*
 * Dividend & distribution tracker - client logic.
 *
 * Privacy model: the published data.json contains only public, per-share
 * information. Share counts live exclusively in this browser's localStorage and
 * are never transmitted anywhere, which is what keeps account details off a
 * publicly reachable page.
 */
'use strict';

const HOLDINGS_KEY = 'divtracker.holdings.v1';
const PREFS_KEY = 'divtracker.prefs.v1';
const SYNC_META_KEY = 'divtracker.syncMeta.v1';
const SYNC_KEY_KEY = 'divtracker.syncKey.v1';

const CONFIG = (typeof window !== 'undefined' && window.DIVTRACKER_CONFIG) || {};
const QUARTER_DAYS = Number(CONFIG.QUARTER_DAYS) > 0 ? Number(CONFIG.QUARTER_DAYS) : 92;
const WORKER_BASE = String(CONFIG.WORKER_BASE || '').replace(/\/+$/, '');

const state = {
  data: null,
  holdings: {},
  syncMeta: { at: null, source: null },
  prefs: { range: 'upcoming', hideProjected: false, symbols: [], drip: false },
  today: new Date(),
};

/* ---------------------------------------------------------------- utilities */

/** Parse YYYY-MM-DD as a local date; `new Date(str)` would treat it as UTC. */
function parseDate(value) {
  if (!value) return null;
  const parts = String(value).split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function formatDate(value) {
  const date = parseDate(value);
  if (!date) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function money(value, digits = 2) {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function perShare(value) {
  return '$' + value.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function shareText(value) {
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? Object.assign({}, fallback, JSON.parse(raw)) : fallback;
  } catch (err) {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    /* Private-browsing or quota errors are non-fatal; the table still renders. */
  }
}

/* --------------------------------------------------------- freshness pill */

/** How stale the holdings are today. Interpolates green -> red over one
 *  quarter (92 days) via HSL, matching the natural cadence of dividends. */
function freshnessColor(daysSince) {
  if (daysSince == null) return '#64748b';
  const t = Math.max(0, Math.min(1, daysSince / QUARTER_DAYS));
  const hue = Math.round(120 * (1 - t));
  const sat = 60 + Math.round(18 * t);
  const light = 42 - Math.round(6 * t);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function describeAge(days) {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

function markSynced(source) {
  state.syncMeta = { at: new Date().toISOString(), source: source || null };
  save(SYNC_META_KEY, state.syncMeta);
}

function renderSyncPill() {
  const pill = document.getElementById('sync-pill');
  const src = document.getElementById('sync-source');
  if (!pill) return;
  const meta = state.syncMeta || {};
  if (!meta.at) {
    pill.textContent = 'never';
    pill.classList.add('never');
    pill.style.background = '';
    pill.title = 'Holdings have never been synced on this device.';
    if (src) src.textContent = '';
    return;
  }
  const at = new Date(meta.at);
  const days = Math.max(0, Math.floor((state.today - at) / 86400000));
  pill.classList.remove('never');
  pill.style.background = freshnessColor(days);
  pill.textContent = `${at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} · ${describeAge(days)}`;
  pill.title = `Holdings last updated ${at.toLocaleString()}.\n`
    + `Pill turns green -> red over ${QUARTER_DAYS} days (one quarter).`;
  if (src) src.textContent = meta.source ? `via ${meta.source}` : '';
}

const KIND_LABEL = {
  income: 'Income dividend',
  capital_gain: 'Capital gain',
  distribution: 'Income + capital gain',
};

/* --------------------------------------------------------------- CSV import */

/** Minimal RFC4180 CSV parser: handles quoted fields, escaped quotes, CRLF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const SYMBOL_HEADERS = /^(symbol|ticker|security\s*symbol|symbol\/cusip|fund\s*symbol)$/i;
const QUANTITY_HEADERS = /^(quantity|qty|shares|share\s*quantity|units|quantity\s*owned|number\s*of\s*shares)$/i;

/**
 * Extract {symbol: shares} from a brokerage positions export.
 * Fidelity and U.S. Bancorp Investments both emit a header row plus footer
 * disclaimer text, so the header is located by scanning rather than assumed
 * to be the first line.
 */
function extractHoldings(text, knownSymbols) {
  const rows = parseCsv(text);
  let symbolIdx = -1;
  let quantityIdx = -1;
  let headerRow = -1;

  for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
    const cells = rows[i].map((c) => c.trim());
    const sIdx = cells.findIndex((c) => SYMBOL_HEADERS.test(c));
    const qIdx = cells.findIndex((c) => QUANTITY_HEADERS.test(c));
    if (sIdx !== -1 && qIdx !== -1) {
      symbolIdx = sIdx; quantityIdx = qIdx; headerRow = i;
      break;
    }
  }
  if (headerRow === -1) {
    throw new Error('Could not find "Symbol" and "Quantity" columns in that file.');
  }

  const known = new Set(knownSymbols);
  const found = {};
  for (let i = headerRow + 1; i < rows.length; i += 1) {
    const cells = rows[i];
    if (cells.length <= Math.max(symbolIdx, quantityIdx)) continue;
    // Money-market and cash rows carry a "**" suffix at Fidelity; strip noise.
    const symbol = (cells[symbolIdx] || '').trim().replace(/\*+$/, '').toUpperCase();
    const rawQty = (cells[quantityIdx] || '').replace(/[$,\s]/g, '');
    const qty = Number.parseFloat(rawQty);
    if (!symbol || !known.has(symbol) || !Number.isFinite(qty) || qty <= 0) continue;
    // Same holding can appear in several accounts; sum them.
    found[symbol] = (found[symbol] || 0) + qty;
  }
  if (Object.keys(found).length === 0) {
    throw new Error('No tracked symbols found in that file.');
  }
  return found;
}

/* ------------------------------------------------------------ derived views */

function allRows() {
  if (!state.data) return [];
  const rows = [];
  state.data.symbols.forEach((sym) => {
    sym.distributions.forEach((dist) => {
      rows.push({
        symbol: sym.symbol,
        name: sym.name,
        price: sym.price,
        exDate: dist.ex_date,
        payDate: dist.pay_date || null,
        amount: dist.amount,
        status: dist.status,
        kind: dist.kind || 'income',
        confidence: dist.confidence,
        basis: dist.basis || '',
        source: dist.source || '',
        note: dist.note || '',
        date: parseDate(dist.ex_date),
      });
    });
  });
  rows.sort((a, b) => a.date - b.date || a.symbol.localeCompare(b.symbol));
  return rows;
}

/**
 * Attach share counts and dollar amounts.
 * With DRIP enabled, shares compound forward from today using each projected
 * payment reinvested at the latest known price - an approximation, since the
 * real reinvestment price is unknown.
 */
function withDollars(rows) {
  const running = {};
  Object.keys(state.holdings).forEach((sym) => { running[sym] = state.holdings[sym]; });

  return rows.map((row) => {
    const base = state.holdings[row.symbol];
    if (!Number.isFinite(base) || base <= 0) {
      return Object.assign({}, row, { shares: null, dollars: null });
    }
    let shares = base;
    if (state.prefs.drip && row.date > state.today) {
      shares = running[row.symbol] != null ? running[row.symbol] : base;
    }
    const dollars = shares * row.amount;
    if (state.prefs.drip && row.date > state.today && row.price > 0) {
      running[row.symbol] = shares + dollars / row.price;
    }
    return Object.assign({}, row, { shares, dollars });
  });
}

function filterRows(rows) {
  const { range, hideProjected, symbols } = state.prefs;
  const today = state.today;
  return rows.filter((row) => {
    if (symbols.length && !symbols.includes(row.symbol)) return false;
    if (hideProjected && row.status === 'projected') return false;
    if (range === 'upcoming' && row.date < today) return false;
    if (range === 'history' && row.date >= today) return false;
    return true;
  });
}

/* ----------------------------------------------------------------- rendering */

function renderMeta() {
  const el = document.getElementById('meta');
  const generated = new Date(state.data.generatedAt);
  const symbols = state.data.symbols.map((s) => s.symbol).join(' · ');
  el.textContent = `${symbols} — data refreshed ${generated.toLocaleString(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  })}`;
  document.getElementById('sources').textContent = 'Sources: ' + state.data.sources.join('; ') + '.';
}

function renderSummary(rows) {
  const container = document.getElementById('summary-cards');
  const today = state.today;
  const yearAgo = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
  const yearAhead = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());
  const hasHoldings = Object.values(state.holdings).some((v) => v > 0);

  const scoped = rows.filter((r) => !state.prefs.symbols.length || state.prefs.symbols.includes(r.symbol));
  const trailing = scoped.filter((r) => r.status === 'paid' && r.date > yearAgo && r.date <= today);
  const ahead = scoped.filter((r) => r.date > today && r.date <= yearAhead);
  const confirmedAhead = ahead.filter((r) => r.status !== 'projected');
  const next = scoped.find((r) => r.date > today);

  const sum = (list) => list.reduce((acc, r) => acc + (hasHoldings ? (r.dollars || 0) : r.amount), 0);
  const fmt = (value) => (hasHoldings ? money(value) : perShare(value));

  const cards = [
    {
      label: 'Received, last 12 mo',
      value: fmt(sum(trailing)),
      sub: `${trailing.length} payment${trailing.length === 1 ? '' : 's'}${hasHoldings ? '' : ' per share'}`,
    },
    {
      label: 'Next 12 months',
      value: fmt(sum(ahead)),
      sub: `${fmt(sum(confirmedAhead))} confirmed · rest projected`,
    },
    {
      label: 'Next payment',
      value: next ? next.symbol : '—',
      sub: next
        ? `${formatDate(next.exDate)} · ${perShare(next.amount)}/sh · ${next.status === 'projected' ? 'projected' : 'confirmed'}`
        : 'None scheduled',
    },
  ];

  if (!hasHoldings) {
    cards.push({
      label: 'Dollar amounts',
      value: 'Off',
      sub: 'Add share counts under “Your holdings”',
    });
  }

  container.innerHTML = cards
    .map((card) => `<div class="card"><div class="label">${card.label}</div>
      <div class="value">${card.value}</div><div class="sub">${card.sub}</div></div>`)
    .join('');
}

function renderChips() {
  const container = document.getElementById('symbol-chips');
  const symbols = state.data.symbols.map((s) => s.symbol);
  const chips = [{ id: '', label: 'All' }].concat(symbols.map((s) => ({ id: s, label: s })));
  container.innerHTML = chips
    .map((chip) => {
      const active = chip.id === ''
        ? state.prefs.symbols.length === 0
        : state.prefs.symbols.includes(chip.id);
      return `<button type="button" class="chip${active ? ' active' : ''}" data-symbol="${chip.id}"
        aria-pressed="${active}">${chip.label}</button>`;
    })
    .join('');
}

function renderHoldingsInputs() {
  const container = document.getElementById('holdings-inputs');
  container.innerHTML = state.data.symbols
    .map((sym) => {
      const value = state.holdings[sym.symbol];
      return `<div class="holding">
        <label for="sh-${sym.symbol}">${sym.symbol} — shares held</label>
        <input id="sh-${sym.symbol}" type="number" inputmode="decimal" step="0.001" min="0"
          placeholder="0" data-symbol="${sym.symbol}" value="${value != null ? value : ''}" />
      </div>`;
    })
    .join('');

  const count = Object.values(state.holdings).filter((v) => v > 0).length;
  document.getElementById('holdings-hint').textContent = count
    ? `${count} position${count === 1 ? '' : 's'} saved on this device`
    : 'Tap to enter share counts';
}

function renderTable(rows) {
  const body = document.getElementById('dist-body');
  const empty = document.getElementById('empty-state');
  const today = state.today;
  const hasHoldings = Object.values(state.holdings).some((v) => v > 0);

  if (!rows.length) {
    body.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const nextIdx = rows.findIndex((r) => r.date > today);
  body.innerHTML = rows
    .map((row, idx) => {
      const badge = `<span class="badge ${row.status}">${row.status}</span>`;
      const conf = row.status === 'projected' && row.confidence != null
        ? `<span class="conf">${Math.round(row.confidence * 100)}% confidence</span>`
        : '';
      const tooltip = row.status === 'projected'
        ? row.basis
        : [row.source, row.note].filter(Boolean).join(' — ');
      return `<tr class="${row.status}${idx === nextIdx ? ' next-up' : ''}">
        <td><span class="sym">${row.symbol}</span><span class="kind">${KIND_LABEL[row.kind] || row.kind}</span></td>
        <td>${formatDate(row.exDate)}</td>
        <td>${row.payDate ? formatDate(row.payDate) : '—'}</td>
        <td class="num">${perShare(row.amount)}</td>
        <td class="num">${row.shares != null ? shareText(row.shares) : '—'}</td>
        <td class="num">${row.dollars != null ? money(row.dollars) : '—'}</td>
        <td title="${String(tooltip).replace(/"/g, '&quot;')}">${badge}${conf}</td>
      </tr>`;
    })
    .join('');

  const total = rows.reduce((acc, r) => acc + (hasHoldings ? (r.dollars || 0) : r.amount), 0);
  const existing = document.querySelector('#dist-table tfoot');
  if (existing) existing.remove();
  const tfoot = document.createElement('tfoot');
  tfoot.innerHTML = `<tr><td colspan="5">Total shown (${rows.length} row${rows.length === 1 ? '' : 's'})</td>
    <td class="num">${hasHoldings ? money(total) : perShare(total)}</td><td></td></tr>`;
  document.getElementById('dist-table').appendChild(tfoot);
}

function renderYearTable(rows) {
  const body = document.getElementById('year-body');
  const hasHoldings = Object.values(state.holdings).some((v) => v > 0);
  const scoped = rows.filter((r) => !state.prefs.symbols.length || state.prefs.symbols.includes(r.symbol));
  const byYear = new Map();

  scoped.forEach((row) => {
    const year = row.date.getFullYear();
    if (!byYear.has(year)) byYear.set(year, { confirmed: 0, projected: 0 });
    const bucket = byYear.get(year);
    const value = hasHoldings ? (row.dollars || 0) : row.amount;
    if (row.status === 'projected') bucket.projected += value;
    else bucket.confirmed += value;
  });

  const fmt = (v) => (v === 0 ? '—' : (hasHoldings ? money(v) : perShare(v)));
  const years = Array.from(byYear.keys()).sort((a, b) => b - a).slice(0, 8);
  body.innerHTML = years
    .map((year) => {
      const bucket = byYear.get(year);
      const isFuture = bucket.projected > 0;
      return `<tr class="${isFuture ? 'projected' : ''}"><td>${year}</td>
        <td class="num">${fmt(bucket.confirmed)}</td>
        <td class="num">${fmt(bucket.projected)}</td>
        <td class="num">${fmt(bucket.confirmed + bucket.projected)}</td></tr>`;
    })
    .join('');
}

function renderNotes() {
  const container = document.getElementById('notes-panel');
  const blocks = state.data.symbols.map((sym) => {
    const items = [];
    if (sym.notes) items.push(sym.notes);
    items.push(`Pays ${sym.cadence}. Trailing 12 months: ${perShare(sym.trailing12m || 0)}/share`
      + (sym.yieldPct ? ` (${sym.yieldPct.toFixed(2)}% yield at ${money(sym.price)})` : '') + '.');
    if (sym.growthRate != null) {
      items.push(`Projections grow the annual total by ${(sym.growthRate * 100).toFixed(1)}%/yr, `
        + 'the median year-over-year change in its own payout history.');
    }
    (sym.warnings || []).forEach((w) => items.push(w));
    return `<h3>${sym.symbol} — ${sym.name}</h3><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
  });

  const errors = state.data.errors || [];
  const errorBlock = errors.length
    ? `<h3>Fetch errors</h3><ul>${errors.map((e) => `<li>${e.symbol}: ${e.error}</li>`).join('')}</ul>`
    : '';

  container.innerHTML = '<h2 class="section-title">Methodology &amp; notes</h2>' + blocks.join('') + errorBlock;
}

function render() {
  const rows = withDollars(allRows());
  renderSummary(rows);
  renderChips();
  renderTable(filterRows(rows));
  renderYearTable(rows);
}

/* -------------------------------------------------------------------- events */

function bindEvents() {
  document.getElementById('holdings-toggle').addEventListener('click', (event) => {
    const button = event.currentTarget;
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    document.getElementById('holdings-body').hidden = expanded;
  });

  document.getElementById('holdings-inputs').addEventListener('input', (event) => {
    const input = event.target;
    if (!input.dataset.symbol) return;
    const value = Number.parseFloat(input.value);
    if (Number.isFinite(value) && value > 0) state.holdings[input.dataset.symbol] = value;
    else delete state.holdings[input.dataset.symbol];
    save(HOLDINGS_KEY, state.holdings);
    markSynced('Manual entry');
    renderSyncPill();
    document.getElementById('holdings-hint').textContent =
      `${Object.keys(state.holdings).length} position(s) saved on this device`;
    render();
  });

  document.getElementById('clear-holdings').addEventListener('click', () => {
    state.holdings = {};
    state.syncMeta = { at: null, source: null };
    save(HOLDINGS_KEY, state.holdings);
    save(SYNC_META_KEY, state.syncMeta);
    renderHoldingsInputs();
    renderSyncPill();
    setStatus('Holdings cleared from this device.', 'ok');
    render();
  });

  document.getElementById('csv-input').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const known = state.data.symbols.map((s) => s.symbol);
        const found = extractHoldings(String(reader.result), known);
        Object.assign(state.holdings, found);
        save(HOLDINGS_KEY, state.holdings);
        markSynced(`CSV import — ${file.name}`);
        renderHoldingsInputs();
        renderSyncPill();
        setStatus(`Imported ${Object.keys(found).length} position(s): `
          + Object.entries(found).map(([s, q]) => `${s} ${shareText(q)}`).join(', ')
          + '. Nothing was uploaded.', 'ok');
        render();
      } catch (err) {
        setStatus(err.message, 'error');
      }
    };
    reader.onerror = () => setStatus('Could not read that file.', 'error');
    reader.readAsText(file);
    event.target.value = '';
  });

  const syncButton = document.getElementById('sync-bank');
  if (syncButton) {
    syncButton.addEventListener('click', () => syncFromBank());
  }

  const disconnectButton = document.getElementById('disconnect-bank');
  if (disconnectButton) {
    disconnectButton.addEventListener('click', () => disconnectBank());
  }

  const snaptradeButton = document.getElementById('sync-snaptrade');
  if (snaptradeButton) {
    snaptradeButton.addEventListener('click', () => syncFromSnaptrade());
  }

  document.getElementById('drip-toggle').addEventListener('change', (event) => {
    state.prefs.drip = event.target.checked;
    save(PREFS_KEY, state.prefs);
    render();
  });

  document.getElementById('hide-projected').addEventListener('change', (event) => {
    state.prefs.hideProjected = event.target.checked;
    save(PREFS_KEY, state.prefs);
    render();
  });

  document.querySelectorAll('.segmented button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.segmented button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      state.prefs.range = button.dataset.range;
      save(PREFS_KEY, state.prefs);
      render();
    });
  });

  document.getElementById('symbol-chips').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    const symbol = chip.dataset.symbol;
    if (!symbol) state.prefs.symbols = [];
    else if (state.prefs.symbols.includes(symbol)) {
      state.prefs.symbols = state.prefs.symbols.filter((s) => s !== symbol);
    } else {
      state.prefs.symbols = state.prefs.symbols.concat([symbol]);
    }
    save(PREFS_KEY, state.prefs);
    render();
  });
}

function setStatus(message, kind) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = message;
  el.className = 'hint' + (kind ? ' ' + kind : '');
  el.hidden = !message;
}

/* ------------------------------------------------------------ federated sync
 *
 * "Sync from bank" pulls share counts through the Cloudflare Worker in
 * docs/config.js.
 *
 * First run (links the Plaid Item):
 *   1. POST worker /link/token/create   -> { link_token }
 *   2. Plaid.create({token}).open()     -> public_token on success
 *   3. POST worker /link/token/exchange -> { holdings, institution }
 *
 * Every run after that:
 *   POST worker /holdings/refresh       -> { holdings, institution }
 *
 * The refresh path creates no new Plaid Item, which is what keeps this free
 * forever: Plaid's Trial plan allows 10 Items for the lifetime of the account
 * and never refunds a slot, so re-linking each time would run out after ten.
 *
 * The browser never sees the Plaid access token. It does hold the worker
 * passphrase, which is stored locally and sent as X-Sync-Key - without it the
 * worker would expose real holdings to anyone who found its URL. */

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

function getSyncKey(promptIfMissing) {
  let key = '';
  try { key = window.localStorage.getItem(SYNC_KEY_KEY) || ''; } catch { key = ''; }
  if (!key && promptIfMissing) {
    key = (window.prompt('Enter the sync passphrase you set on the worker (SYNC_PASSPHRASE):') || '').trim();
    if (key) { try { window.localStorage.setItem(SYNC_KEY_KEY, key); } catch { /* ignore */ } }
  }
  return key;
}

function forgetSyncKey() {
  try { window.localStorage.removeItem(SYNC_KEY_KEY); } catch { /* ignore */ }
}

async function workerPost(path, body, key) {
  const resp = await fetch(`${WORKER_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sync-Key': key,
    },
    body: JSON.stringify(body || {}),
  });
  let payload = null;
  try { payload = await resp.json(); } catch { /* leave null */ }
  if (!resp.ok) {
    if (resp.status === 401) {
      // Stale or mistyped passphrase: drop it so the next attempt re-prompts.
      forgetSyncKey();
      throw new Error('Worker rejected the passphrase. It has been cleared; try again.');
    }
    throw new Error((payload && payload.error) || `Worker ${path} returned HTTP ${resp.status}`);
  }
  return payload || {};
}

/* Applies a {SYMBOL: shares} map, keeping only tracked tickers. */
function applyHoldings(holdings, source) {
  const known = new Set(state.data.symbols.map((s) => s.symbol));
  let kept = 0;
  Object.entries(holdings).forEach(([sym, qty]) => {
    const upper = String(sym || '').toUpperCase();
    const value = Number(qty);
    if (!Number.isFinite(value) || value <= 0) return;
    if (!known.has(upper)) return;
    state.holdings[upper] = value;
    kept += 1;
  });
  if (kept === 0) return 0;
  save(HOLDINGS_KEY, state.holdings);
  markSynced(source);
  renderHoldingsInputs();
  renderSyncPill();
  render();
  return kept;
}

async function syncFromBank() {
  if (!WORKER_BASE) {
    setStatus('No Plaid Worker is configured. Set WORKER_BASE in docs/config.js after deploying the worker.', 'error');
    return;
  }
  const button = document.getElementById('sync-bank');
  const original = button ? button.innerHTML : '';
  const restore = () => {
    if (!button) return;
    button.disabled = false;
    button.innerHTML = original;
  };

  const key = getSyncKey(true);
  if (!key) {
    setStatus('A sync passphrase is required. Set SYNC_PASSPHRASE on the worker first.', 'error');
    return;
  }

  try {
    if (button) { button.disabled = true; button.textContent = 'Checking connection…'; }

    // Reuse the stored Plaid Item when there is one. This is the whole point:
    // no new Item means no Trial-plan slot consumed and no bank sign-in.
    const status = await workerPost('/status', {}, key);
    if (status.connected) {
      setStatus('Refreshing holdings through the saved connection…', 'ok');
      if (button) button.textContent = 'Refreshing…';
      const payload = await workerPost('/holdings/refresh', {}, key);
      const holdings = payload && payload.holdings;
      if (!holdings || typeof holdings !== 'object') throw new Error('The worker returned no holdings.');
      const source = payload.institution || status.institution || 'Bank sync';
      const kept = applyHoldings(holdings, source);
      if (kept === 0) {
        setStatus(`No tracked symbols returned from ${source}. `
          + `Held ${Object.keys(holdings).length} position(s) but none matched configured tickers.`, 'error');
      } else {
        setStatus(`Refreshed ${kept} position(s) from ${source}. No new bank sign-in needed.`, 'ok');
      }
      restore();
      return;
    }

    if (button) button.textContent = 'Preparing sign-in…';
    setStatus('Requesting a link token from the sync worker…', 'ok');

    const { link_token: linkToken } = await workerPost('/link/token/create', {}, key);
    if (!linkToken) throw new Error('The worker did not return a link_token.');

    await loadPlaidSdk();
    if (button) button.textContent = 'Waiting for bank sign-in…';
    setStatus('Sign in to your bank in the Plaid window. This is a one-time link; later syncs reuse it.', 'ok');

    const handler = window.Plaid.create({
      token: linkToken,
      onSuccess: async (publicToken, metadata) => {
        try {
          if (button) button.textContent = 'Fetching holdings…';
          const payload = await workerPost('/link/token/exchange', { public_token: publicToken }, key);
          const holdings = payload && payload.holdings;
          if (!holdings || typeof holdings !== 'object') {
            throw new Error('The worker returned no holdings.');
          }
          const source = payload.institution
            || (metadata && metadata.institution && metadata.institution.name)
            || 'Bank sync';
          const kept = applyHoldings(holdings, source);
          if (kept === 0) {
            setStatus(`No tracked symbols returned from ${source}. `
              + `Held ${Object.keys(holdings).length} positions but none matched configured tickers.`, 'error');
            restore();
            return;
          }
          setStatus(payload.persisted
            ? `Synced ${kept} position(s) from ${source}. Connection saved, so future syncs skip the bank sign-in.`
            : `Synced ${kept} position(s) from ${source}. Access token discarded (no KV bound).`, 'ok');
        } catch (err) {
          setStatus('Sync failed: ' + err.message, 'error');
        } finally {
          restore();
        }
      },
      onExit: (err) => {
        restore();
        if (err) setStatus('Bank sign-in cancelled or errored: ' + (err.error_message || err.error_code || 'exited'), 'error');
        else setStatus('Bank sign-in cancelled.', 'ok');
      },
      onEvent: () => {},
    });
    handler.open();
  } catch (err) {
    setStatus('Could not start bank sync: ' + err.message, 'error');
    restore();
  }
}

async function disconnectBank() {
  if (!WORKER_BASE) return;
  const key = getSyncKey(true);
  if (!key) return;
  if (!window.confirm('Disconnect the saved bank connection?\n\nHoldings already on this device are kept. Reconnecting later uses another of the 10 Plaid Trial slots.')) return;
  try {
    setStatus('Disconnecting…', 'ok');
    await workerPost('/item/disconnect', {}, key);
    setStatus('Bank connection removed. The stored access token is gone.', 'ok');
    renderSyncPill();
  } catch (err) {
    setStatus('Disconnect failed: ' + err.message, 'error');
  }
}

/* --------------------------------------------------------- SnapTrade sync
 *
 * An alternative to Plaid. Both reach Fidelity through Fidelity Access, so
 * this is not more reliable at the brokerage boundary - it simply has no
 * equivalent of Plaid's 10-Items-for-the-lifetime-of-the-account Trial cap.
 *
 * Flow:
 *   1. POST worker /snaptrade/holdings   -> positions, if already connected
 *   2. If nothing is connected, POST worker /snaptrade/portal -> { url },
 *      open the Connection Portal, and let the user retry once linked.
 *
 * The Personal API key identifies the user, so there is no per-connection
 * token for this page or the worker to hold. */

async function syncFromSnaptrade() {
  if (!WORKER_BASE) return;
  const button = document.getElementById('sync-snaptrade');
  const original = button ? button.innerHTML : '';
  const restore = () => {
    if (!button) return;
    button.disabled = false;
    button.innerHTML = original;
  };

  const key = getSyncKey(true);
  if (!key) {
    setStatus('A sync passphrase is required. Set SYNC_PASSPHRASE on the worker first.', 'error');
    return;
  }

  try {
    if (button) { button.disabled = true; button.textContent = 'Reading positions…'; }
    setStatus('Reading positions from SnapTrade…', 'ok');

    const payload = await workerPost('/snaptrade/holdings', {}, key);

    if (!payload.connected) {
      // Nothing linked yet: hand the user off to SnapTrade's portal. The link
      // completes on their side, so we cannot await it - prompt a retry.
      setStatus('No brokerage is linked to SnapTrade yet. Opening the connection portal…', 'ok');
      const portal = await workerPost('/snaptrade/portal', {}, key);
      if (portal && portal.url) {
        window.open(portal.url, '_blank', 'noopener');
        setStatus('Link your brokerage in the new tab, then press “Sync via SnapTrade” again.', 'ok');
      } else {
        setStatus('SnapTrade did not return a connection portal URL.', 'error');
      }
      restore();
      return;
    }

    const holdings = payload.holdings || {};
    const source = payload.institution || 'SnapTrade';
    const kept = applyHoldings(holdings, source);
    if (kept === 0) {
      setStatus(`No tracked symbols returned from ${source}. `
        + `Read ${Object.keys(holdings).length} position(s) across ${payload.accounts} account(s) `
        + `but none matched configured tickers.`, 'error');
    } else {
      setStatus(`Synced ${kept} position(s) from ${source} across ${payload.accounts} account(s).`, 'ok');
    }
  } catch (err) {
    setStatus('SnapTrade sync failed: ' + err.message, 'error');
  } finally {
    restore();
  }
}

/* ---------------------------------------------------------------------- init */

async function init() {
  state.today = new Date();
  state.today.setHours(0, 0, 0, 0);
  state.holdings = load(HOLDINGS_KEY, {});
  state.prefs = load(PREFS_KEY, state.prefs);
  state.syncMeta = load(SYNC_META_KEY, { at: null, source: null });

  const syncBtn = document.getElementById('sync-bank');
  if (syncBtn) syncBtn.hidden = !WORKER_BASE;

  // Only offer "Disconnect" once a connection is actually stored, and only
  // offer SnapTrade if the worker has credentials for it. Probing requires the
  // passphrase, so stay quiet if it has not been entered yet.
  const disconnectBtn = document.getElementById('disconnect-bank');
  const snaptradeBtn = document.getElementById('sync-snaptrade');
  if (disconnectBtn) disconnectBtn.hidden = true;
  if (snaptradeBtn) snaptradeBtn.hidden = true;
  if (WORKER_BASE && getSyncKey(false)) {
    workerPost('/status', {}, getSyncKey(false))
      .then((s) => {
        if (disconnectBtn) disconnectBtn.hidden = !(s && s.connected);
        if (snaptradeBtn) snaptradeBtn.hidden = !(s && s.snaptradeConfigured);
        // If only SnapTrade is set up, the Plaid button is just a dead end.
        if (syncBtn && s && s.snaptradeConfigured && !s.plaidConfigured) syncBtn.hidden = true;
      })
      .catch(() => { /* offline or bad key: leave hidden */ });
  }

  renderSyncPill();

  try {
    const response = await fetch('data.json?t=' + Date.now(), { cache: 'no-cache' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    state.data = await response.json();
  } catch (err) {
    document.getElementById('meta').textContent =
      'Could not load data.json (' + err.message + '). If offline, a cached copy may load shortly.';
    return;
  }

  document.getElementById('hide-projected').checked = !!state.prefs.hideProjected;
  document.getElementById('drip-toggle').checked = !!state.prefs.drip;
  document.querySelectorAll('.segmented button').forEach((button) => {
    button.classList.toggle('active', button.dataset.range === state.prefs.range);
  });

  renderMeta();
  renderHoldingsInputs();
  renderNotes();
  bindEvents();
  render();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

// Exported so the CSV import logic can be unit tested under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseCsv, extractHoldings, parseDate };
}
