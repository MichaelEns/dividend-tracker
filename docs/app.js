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
const ACCOUNTS_KEY = 'divtracker.accounts.v1';
const LOTS_KEY = 'divtracker.holdingLots.v1';
const PREFS_KEY = 'divtracker.prefs.v1';
const SYNC_META_KEY = 'divtracker.syncMeta.v1';
const SYNC_KEY_KEY = 'divtracker.syncKey.v1';
const SYNC_SOURCES_KEY = 'divtracker.syncSources.v1';

const CONFIG = (typeof window !== 'undefined' && window.DIVTRACKER_CONFIG) || {};
const QUARTER_DAYS = Number(CONFIG.QUARTER_DAYS) > 0 ? Number(CONFIG.QUARTER_DAYS) : 92;
const WORKER_BASE = String(CONFIG.WORKER_BASE || '').replace(/\/+$/, '');

const state = {
  data: null,
  holdings: {},
  // Where the shares actually sit: { SYMBOL: { accountId: shares } }. The same
  // fund can be held at several institutions - FXAIX is split between Fidelity
  // and U.S. Bank - and each is synced separately, so a single number per
  // symbol cannot be updated without destroying the other institution's share.
  // `state.holdings` is the derived total, recomputed from this.
  lots: {},
  accounts: [],
  syncMeta: { at: null, source: null },
  syncSources: {},
  // Appended to the next sync's status line when a brand-new account overlaps
  // what other accounts already hold, i.e. when the total may have doubled.
  syncNote: '',
  prefs: { range: 'upcoming', hideProjected: false, symbols: [], drip: false },
  today: new Date(),
  // Test-only clock injection. Production reads the real clock per render, so
  // a tab left open overnight still crosses a staleness threshold.
  nowOverride: null,
  // Service worker registration, once it resolves, so a refresh can ask it to
  // look for a new build.
  swRegistration: null,
  refreshing: false,
  lastRefreshAt: null,
  // Set once data.json has been loaded and the controls have been bound.
  activated: false,
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

/** Month + day only. Used where a nearby date already establishes the year. */
function formatDateShort(value) {
  const date = parseDate(value);
  if (!date) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The calendar quarter a distribution belongs to.
 *
 * Keyed off the ex-date, which is both how dividends are conventionally
 * labelled ("the Q1 dividend") and the column the table sorts by. Using the pay
 * date instead would scatter the colour bands, because a late-March ex-date
 * often pays in April and would land in a different quarter from the rows it
 * sits between.
 */
function quarterOf(value) {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  const index = Math.floor(date.getMonth() / 3) + 1;
  const year = date.getFullYear();
  return { index, year, key: `${year}-Q${index}`, label: `Q${index} ${year}` };
}

function money(value, digits = 2) {
  // narrowSymbol keeps this as "$1,234.56" in every locale. The default
  // currencyDisplay disambiguates, rendering USD as "US$1,234.56" for anyone
  // whose phone is not set to en-US - two characters of pure noise in the
  // narrowest column of the folded phone layout. Older engines reject the
  // option outright, hence the fallback.
  try {
    return value.toLocaleString(undefined, {
      style: 'currency',
      currency: 'USD',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  } catch (err) {
    return '$' + value.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }
}

function perShare(value) {
  return '$' + value.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function shareText(value) {
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

/** Account names are user-typed and also arrive from the sync worker, and they
 *  are rendered through innerHTML. */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? Object.assign({}, fallback, JSON.parse(raw)) : fallback;
  } catch (err) {
    return fallback;
  }
}

/** `load` merges onto an object, which turns a stored array into {0: …}. */
function loadArray(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

/** Distinguishes "never written" from "written and empty", which the holdings
 *  migration has to tell apart. */
function hasStored(key) {
  try {
    return localStorage.getItem(key) !== null;
  } catch (err) {
    return false;
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

/**
 * Collapses "CSV import — march.csv" to "CSV import" so re-importing a
 * differently named file updates one record instead of growing the list
 * forever. The full label is kept for display.
 */
function sourceId(source) {
  const raw = String(source || 'Manual entry').trim();
  const cut = raw.split('—')[0].trim();
  return cut || raw;
}

function markSynced(source) {
  state.syncMeta = { at: new Date().toISOString(), source: source || null };
  save(SYNC_META_KEY, state.syncMeta);
  recordSource(sourceId(source), source || 'Manual entry', 'sync');
  renderStaleness();
}

/* ------------------------------------------------------------- staleness
 *
 * The pill above answers "how old are my share counts?" and fades over a
 * quarter, which suits dividends. It does not cover the failure that actually
 * misleads you: data.json going stale.
 *
 * Share counts are edited by hand, so their age is self-evident. data.json is
 * refreshed by a scheduled GitHub Action, so when that breaks - an expired
 * token, a Yahoo schema change, a workflow error - the page keeps rendering
 * confident, plausible, wrong numbers with no visible difference. Prices and
 * "next payment" dates simply stop advancing. That is a silent failure, and
 * silent failures deserve loud warnings.
 *
 * One classifier covers both because staleness is judged as a ratio of age to
 * the cadence that source is *expected* to keep, not as an absolute age. A
 * day-old holdings entry is fine; a day-old daily build is already suspect. */

const FRESHNESS_ORDER = ['fresh', 'aging', 'stale', 'critical', 'broken', 'never'];

/** Cadence a source is expected to keep, in hours. */
const DATA_CADENCE_HOURS = 24;      // the workflow's daily cron
const HOLDINGS_CADENCE_HOURS = QUARTER_DAYS * 24;

/**
 * Classifies one source. Returns a level plus the numbers behind it so the UI
 * can explain itself rather than just showing a colour.
 */
function classifyFreshness(options) {
  const opts = options || {};
  const cadence = Number(opts.cadenceHours) > 0 ? Number(opts.cadenceHours) : DATA_CADENCE_HOURS;

  if (opts.brokenReason) {
    return { level: 'broken', ageHours: null, ratio: null, reason: String(opts.brokenReason) };
  }
  if (!opts.at) {
    return { level: 'never', ageHours: null, ratio: null, reason: 'never updated' };
  }
  const at = opts.at instanceof Date ? opts.at : new Date(opts.at);
  if (Number.isNaN(at.getTime())) {
    return { level: 'broken', ageHours: null, ratio: null, reason: 'unreadable timestamp' };
  }

  const now = opts.now instanceof Date ? opts.now : (opts.now ? new Date(opts.now) : new Date());
  // Clamp at zero: a clock skew or a future build date is not "very fresh".
  const ageHours = Math.max(0, (now.getTime() - at.getTime()) / 3600000);
  const ratio = ageHours / cadence;

  let level;
  if (ratio < 0.5) level = 'fresh';
  else if (ratio < 1) level = 'aging';
  else if (ratio < 3) level = 'stale';
  else level = 'critical';

  return { level, ageHours, ratio, reason: null };
}

/** The worst of several levels, for a single summary state. */
function worstLevel(levels) {
  let worst = 'fresh';
  for (const l of levels || []) {
    if (FRESHNESS_ORDER.indexOf(l) > FRESHNESS_ORDER.indexOf(worst)) worst = l;
  }
  return worst;
}

function isConcerning(level) {
  return level === 'stale' || level === 'critical' || level === 'broken';
}

function describeAgeHours(hours) {
  if (hours == null) return 'unknown';
  if (hours < 1) return 'just now';
  if (hours < 2) return 'an hour ago';
  if (hours < 48) return `${Math.round(hours)} hours ago`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/**
 * Folds the legacy single-source record into the per-source map.
 *
 * Existing users already have divtracker.syncMeta.v1 in localStorage; dropping
 * it would reset their pill to "never" and imply their holdings are unverified
 * when they are not.
 */
function migrateSyncMeta(legacy, existing) {
  const sources = Object.assign({}, existing || {});
  if (legacy && legacy.at) {
    const label = legacy.source || 'Previous sync';
    const id = sourceId(label);
    const legacyTime = new Date(legacy.at).getTime();
    if (!Number.isNaN(legacyTime)) {
      const prior = sources[id] ? new Date(sources[id].at).getTime() : NaN;
      // Never move a source backwards in time. An unparseable prior timestamp
      // counts as no timestamp, so the legacy value wins rather than losing to
      // a comparison that silently returns false.
      if (Number.isNaN(prior) || prior < legacyTime) {
        sources[id] = { at: legacy.at, label, via: 'legacy' };
      }
    }
  }
  return sources;
}

function recordSource(id, label, via) {
  if (!id) return;
  state.syncSources = state.syncSources || {};
  state.syncSources[id] = {
    at: new Date().toISOString(),
    label: label || id,
    via: via || 'manual',
  };
  save(SYNC_SOURCES_KEY, state.syncSources);
}

/* ------------------------------------------------------------------ accounts */

/** Used before the user has named anything, so there is always somewhere for a
 *  share count to go. */
const DEFAULT_ACCOUNT = { id: 'manual-entry', name: 'Manual entry' };

/**
 * Shares are held per account, because the same fund can sit at more than one
 * institution: FXAIX is split between Fidelity and U.S. Bank. A single number
 * per symbol cannot represent that, and worse, syncing either institution
 * would silently overwrite the other's shares with a smaller number.
 *
 * The model is deliberately two flat maps rather than a list of lots:
 *   accounts: [{ id, name }]              - defined once, shared by every symbol
 *   lots:     { SYMBOL: { id: shares } }  - one cell per symbol per account
 *
 * `state.holdings` remains the derived symbol -> total map so that every
 * consumer downstream of it - the table, the projections, DRIP - is untouched.
 */

/** A stable id from a display name. Ids are content-derived so that importing
 *  "Fidelity" twice reuses one account rather than creating a duplicate. */
function accountId(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'account';
}

/**
 * Finds an existing account by name, case- and punctuation-insensitively.
 *
 * Only exact-after-slugging matches count: "Fidelity" and "Fidelity
 * Investments" are *not* treated as the same account, because guessing at
 * substrings would merge genuinely different institutions. Sync providers must
 * therefore not be identified by their display name - see `syncAccount`.
 */
function findAccount(accounts, name) {
  const wanted = accountId(name);
  return (accounts || []).find((a) => a && a.id === wanted) || null;
}

/**
 * The account a sync provider owns, creating it on first use.
 *
 * Crucially the provider - "plaid", "snaptrade" - and not its display name is
 * what identifies the bucket. Providers re-word the institution label freely:
 * SnapTrade reports the brokerage name for one connection but "2 accounts"
 * once a second is linked, and the Plaid lookup is best-effort and falls back
 * to "Bank sync" whenever it fails. Keying on the label meant a re-wording
 * created a *second* bucket, and because each bucket is replaced independently
 * the stale one was never reconciled - so the position silently doubled. That
 * is the same class of failure per-account storage exists to prevent, only in
 * the other direction.
 *
 * The label is still used, but only as the display name, and it is updated in
 * place so the panel keeps up with whatever the provider currently calls it.
 */
function syncAccount(accounts, provider, label) {
  const list = Array.isArray(accounts) ? accounts.slice() : [];
  const name = String(label || '').trim() || provider;

  const index = list.findIndex((a) => a && a.provider === provider);
  if (index >= 0) {
    const existing = list[index];
    if (existing.name !== name) list[index] = Object.assign({}, existing, { name });
    return { accounts: list, account: list[index] };
  }

  // Adopt an account of the same name whoever made it - by hand, by CSV, or
  // by the other provider. Two rails reporting the same institution are
  // reporting the same shares, so one bucket is right; forking would
  // double-count them, which is the failure this whole model exists to stop.
  const byName = list.findIndex((a) => a && a.id === accountId(name));
  if (byName >= 0) {
    list[byName] = Object.assign({}, list[byName], { provider });
    return { accounts: list, account: list[byName] };
  }

  const account = { id: uniqueAccountId(list, name), name, provider };
  list.push(account);
  return { accounts: list, account, created: true };
}

/**
 * Symbols an incoming sync would end up double-counting.
 *
 * A brand-new bucket is added to the existing ones, which is right when it is
 * a genuinely separate institution and wrong when it is the same holdings
 * arriving under a name this app has not seen before - an aggregator that
 * reports "Fidelity + U.S. Bank" against hand-made "Fidelity" and "U.S. Bank"
 * accounts, say. The two cases are indistinguishable from here, so rather than
 * guess, name the symbols and let the user look.
 */
function overlappingSymbols(lots, id, holdings) {
  return Object.keys(holdings || {})
    .map((sym) => String(sym).toUpperCase())
    .filter((sym) => Object.entries((lots || {})[sym] || {})
      .some(([acc, shares]) => acc !== id && Number(shares) > 0))
    .sort();
}

/** Keeps ids unique when two different names slug to the same thing. */
function uniqueAccountId(accounts, name) {
  const base = accountId(name);
  const taken = new Set((accounts || []).map((a) => a && a.id));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

/** Adds an account unless an equivalent one exists; returns { accounts, account, added }. */
function addAccount(accounts, name) {
  const list = Array.isArray(accounts) ? accounts.slice() : [];
  const label = String(name || '').trim();
  if (!label) return { accounts: list, account: null, added: false };
  const existing = findAccount(list, label);
  if (existing) return { accounts: list, account: existing, added: false };
  const account = { id: accountId(label), name: label };
  list.push(account);
  return { accounts: list, account, added: true };
}

/** Drops an account and every share count filed under it. */
function removeAccount(accounts, lots, id) {
  const nextAccounts = (accounts || []).filter((a) => a && a.id !== id);
  const nextLots = {};
  Object.entries(lots || {}).forEach(([sym, byAccount]) => {
    const kept = {};
    Object.entries(byAccount || {}).forEach(([acc, shares]) => {
      if (acc !== id) kept[acc] = shares;
    });
    if (Object.keys(kept).length) nextLots[sym] = kept;
  });
  return { accounts: nextAccounts, lots: nextLots };
}

/**
 * Collapses per-account lots into the symbol -> total map the rest of the app
 * reads. Zero and negative counts are dropped rather than stored, so a symbol
 * emptied everywhere disappears instead of lingering as a 0 that renders as a
 * row of "$0.00".
 */
function totalsFromLots(lots) {
  const totals = {};
  Object.entries(lots || {}).forEach(([sym, byAccount]) => {
    let sum = 0;
    Object.values(byAccount || {}).forEach((shares) => {
      const value = Number(shares);
      if (Number.isFinite(value) && value > 0) sum += value;
    });
    if (sum > 0) totals[sym] = sum;
  });
  return totals;
}

/** Writes one cell, deleting it when the count is empty or not a positive number. */
function setLot(lots, symbol, id, shares) {
  const next = {};
  Object.entries(lots || {}).forEach(([sym, byAccount]) => {
    next[sym] = Object.assign({}, byAccount);
  });
  const value = Number(shares);
  const bucket = next[symbol] || (next[symbol] = {});
  if (Number.isFinite(value) && value > 0) bucket[id] = value;
  else delete bucket[id];
  if (!Object.keys(bucket).length) delete next[symbol];
  return next;
}

/**
 * Replaces everything one account holds, rather than merging into it.
 *
 * Merging is wrong for a sync: if a position was sold at Fidelity, a merge
 * leaves the stale row behind forever, because "sold" arrives as an absence
 * and an absence cannot overwrite anything. Replacement is the only reading
 * under which the number on screen means "what that institution holds today".
 *
 * Other accounts are never touched, so syncing Fidelity cannot disturb the
 * FXAIX shares held at U.S. Bank.
 */
function replaceAccountLots(lots, id, holdings, known) {
  const allowed = known instanceof Set ? known : new Set(known || []);
  const next = {};
  Object.entries(lots || {}).forEach(([sym, byAccount]) => {
    const kept = {};
    Object.entries(byAccount || {}).forEach(([acc, shares]) => {
      if (acc !== id) kept[acc] = shares;
    });
    if (Object.keys(kept).length) next[sym] = kept;
  });

  let kept = 0;
  Object.entries(holdings || {}).forEach(([sym, qty]) => {
    const upper = String(sym || '').toUpperCase();
    const value = Number(qty);
    if (!Number.isFinite(value) || value <= 0) return;
    if (allowed.size && !allowed.has(upper)) return;
    (next[upper] || (next[upper] = {}))[id] = value;
    kept += 1;
  });
  return { lots: next, kept };
}

/**
 * Seeds the per-account model from the flat map written by earlier versions.
 *
 * Everything previously entered goes into a single account named after
 * whatever last wrote it, which is the honest answer: the old model recorded
 * one source for the lot as a whole, so that is all that can be recovered.
 * The user then splits it by hand. Returns null when there is nothing to
 * migrate, so a fresh install does not get a phantom account.
 */
function migrateHoldings(flat, syncMeta) {
  const entries = Object.entries(flat || {}).filter(([, v]) => Number(v) > 0);
  if (!entries.length) return null;
  const name = (syncMeta && syncMeta.source) || 'Manual entry';
  const account = { id: accountId(name), name };
  const lots = {};
  entries.forEach(([sym, shares]) => {
    lots[String(sym).toUpperCase()] = { [account.id]: Number(shares) };
  });
  return { accounts: [account], lots };
}

/**
 * Recomputes the derived totals and writes all three keys.
 *
 * `state.holdings` is deliberately kept as a plain symbol -> total map so that
 * everything downstream - the table, projections, DRIP, the empty-state checks
 * - never learns about accounts. HOLDINGS_KEY is still written so that rolling
 * back to an earlier build shows the right totals rather than an empty page.
 */
function commitLots() {
  state.holdings = totalsFromLots(state.lots);
  save(LOTS_KEY, state.lots);
  save(ACCOUNTS_KEY, state.accounts);
  save(HOLDINGS_KEY, state.holdings);
}

/**
 * Folds edits made by a build that only understands the flat map back in.
 *
 * HOLDINGS_KEY is written as a derived mirror so a rollback still shows the
 * right numbers, but an older build will happily *write* to it, and then the
 * lots are the stale copy. Overwriting the flat map from stale lots on the
 * next boot would discard those edits silently, which is the one outcome this
 * whole model exists to prevent.
 *
 * A symbol can only disagree if something outside this build touched it, so
 * reconciling exactly the symbols that disagree leaves every untouched split
 * intact. A disagreeing symbol does collapse to one account - the old build
 * had no way to express a split, so that really is all it knew - but the share
 * count survives, and a split is far easier to re-enter than a number is to
 * remember.
 */
function reconcileFlatHoldings(lots, flat, fallbackId) {
  const totals = totalsFromLots(lots);
  const symbols = new Set(Object.keys(flat || {}).concat(Object.keys(totals)));
  let next = lots;
  let changed = 0;
  symbols.forEach((sym) => {
    const outside = Number((flat || {})[sym]);
    const mine = totals[sym];
    const wanted = Number.isFinite(outside) && outside > 0 ? outside : 0;
    if (wanted === (mine || 0)) return;
    // Collapse to one bucket: the flat map cannot say which account changed.
    Object.keys(next[sym] || {}).forEach((acc) => { next = setLot(next, sym, acc, 0); });
    if (wanted > 0) next = setLot(next, sym, fallbackId, wanted);
    changed += 1;
  });
  return { lots: next, changed };
}

/**
 * The most recently updated source, or null.
 *
 * Freshness is judged on the newest write rather than per source. Sources are
 * merged into one displayed set of totals, so a stale Fidelity sync sitting
 * beside a fresh manual edit still leaves most of the screen trustworthy;
 * ageing each source separately would warn about a CSV imported once in March
 * even though every number on screen was typed an hour ago.
 */
function latestSource(sources) {
  let best = null;
  for (const [id, rec] of Object.entries(sources || {})) {
    const t = rec && rec.at ? new Date(rec.at).getTime() : NaN;
    if (Number.isNaN(t)) continue;
    if (!best || t > best.time) best = { id, time: t, record: rec };
  }
  return best;
}

/**
 * Renders the warning banner.
 *
 * Deliberately not a subtle tint: the whole point is that a stale build is
 * indistinguishable from a healthy one unless something says so outright.
 */
function renderStaleness() {
  const box = document.getElementById('staleness');
  if (!box) return;

  // Read the clock on every render. Holding a load-time timestamp would mean an
  // installed PWA or a tab left open for days never crosses a threshold, which
  // is exactly the long-lived session this feature is meant to protect.
  const now = state.nowOverride instanceof Date ? state.nowOverride : new Date();
  const problems = [];

  const generatedAt = state.data && state.data.generatedAt;
  const parsedAt = parseGeneratedAt(generatedAt);
  let dataBroken = null;
  if (!generatedAt) dataBroken = 'data.json has no generatedAt, so its age cannot be checked.';
  // A present-but-unreadable timestamp must not degrade to "no timestamp":
  // that path does not warn, and a build.py format change would then render as
  // perfectly healthy — the precise silent failure this exists to catch.
  else if (!parsedAt) dataBroken = `data.json has an unreadable build time (${generatedAt}).`;

  const dataState = classifyFreshness({
    at: parsedAt,
    now,
    cadenceHours: DATA_CADENCE_HOURS,
    brokenReason: dataBroken,
  });
  if (isConcerning(dataState.level)) {
    problems.push({
      level: dataState.level,
      title: 'Dividend data is out of date',
      detail: dataState.reason
        ? dataState.reason
        : `Last rebuilt ${describeAgeHours(dataState.ageHours)}. It should refresh daily, so `
          + (dataState.level === 'stale'
            ? 'a scheduled build has been missed. Prices and upcoming dates may have moved on.'
            : 'the scheduled build has almost certainly been failing. Prices and upcoming '
              + 'dates below may be wrong.'),
    });
  }

  const newest = latestSource(state.syncSources);
  if (newest && Object.keys(state.holdings || {}).length > 0) {
    const s = classifyFreshness({
      at: newest.record.at,
      now,
      cadenceHours: HOLDINGS_CADENCE_HOURS,
      brokenReason: newest.record.brokenReason,
    });
    if (isConcerning(s.level)) {
      const label = newest.record.label || newest.id;
      problems.push({
        level: s.level,
        title: 'Your share counts may be stale',
        detail: s.reason
          ? s.reason
          : `Last updated ${describeAgeHours(s.ageHours)} via ${label}. Share counts drive every `
            + 'dollar figure here, so re-sync or re-enter them if anything has changed.',
      });
    }
  }

  if (problems.length === 0) {
    box.hidden = true;
    box.textContent = '';
    box.className = '';
    return;
  }

  const overall = worstLevel(problems.map((p) => p.level));
  box.hidden = false;
  box.className = `staleness ${overall}`;
  box.setAttribute('role', 'status');
  box.textContent = '';

  const heading = document.createElement('strong');
  heading.textContent = overall === 'critical' || overall === 'broken'
    ? 'Warning: this page may be showing stale numbers'
    : 'Heads up: some data is getting old';
  box.appendChild(heading);

  const list = document.createElement('ul');
  for (const p of problems) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 'staleness-title';
    t.textContent = p.title + ' — ';
    li.appendChild(t);
    li.appendChild(document.createTextNode(p.detail));
    list.appendChild(li);
  }
  box.appendChild(list);
}

/**
 * data.json's generatedAt is written by the Python build, which emits a local
 * "MM/DD/YYYY HH:MM:SS" string rather than ISO. Date parsing of that format is
 * implementation-defined, so try ISO first and fall back explicitly.
 */
function parseGeneratedAt(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const raw = String(value).trim();
  const iso = new Date(raw);
  if (!Number.isNaN(iso.getTime())) return iso;
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const d = new Date(
    Number(m[3]), Number(m[1]) - 1, Number(m[2]),
    Number(m[4]), Number(m[5]), Number(m[6] || 0)
  );
  return Number.isNaN(d.getTime()) ? null : d;
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

/**
 * One input per symbol per account, plus a running total.
 *
 * A single box per symbol cannot describe a position split across
 * institutions, and worse, it makes every sync destructive: Fidelity reporting
 * its own FXAIX would overwrite the U.S. Bank shares with a smaller number
 * that looks entirely plausible. Showing the accounts side by side with their
 * sum makes the split visible, and makes a bad sync obvious.
 *
 * With one account the totals line is suppressed: repeating "1,000 sh" under a
 * box that already says 1,000 is noise, and most people only ever have one.
 */
function renderHoldingsInputs() {
  renderAccountList();
  const container = document.getElementById('holdings-inputs');
  const accounts = state.accounts.length ? state.accounts : [DEFAULT_ACCOUNT];
  const multi = accounts.length > 1;

  container.innerHTML = state.data.symbols
    .map((sym) => {
      const byAccount = state.lots[sym.symbol] || {};
      const total = state.holdings[sym.symbol];
      const fields = accounts
        .map((acc) => {
          const value = byAccount[acc.id];
          const id = `sh-${sym.symbol}-${acc.id}`;
          return `<div class="holding-field">
            <label for="${id}">${multi ? escapeHtml(acc.name) : 'Shares held'}</label>
            <input id="${id}" type="number" inputmode="decimal" step="0.001" min="0"
              placeholder="0" data-symbol="${sym.symbol}" data-account="${acc.id}"
              value="${value != null ? value : ''}" />
          </div>`;
        })
        .join('');
      const totalLine = multi
        ? `<div class="holding-total">Total <strong>${shareText(total || 0)} sh</strong></div>`
        : '';
      return `<div class="holding">
        <div class="holding-symbol">${sym.symbol}</div>
        <div class="holding-fields">${fields}</div>
        ${totalLine}
      </div>`;
    })
    .join('');

  const count = Object.values(state.holdings).filter((v) => v > 0).length;
  document.getElementById('holdings-hint').textContent = count
    ? `${count} position${count === 1 ? '' : 's'} saved on this device`
    : 'Tap to enter share counts';
}

/**
 * Refreshes just the "Total" lines.
 *
 * Rebuilding `holdings-inputs` on every keystroke would tear down the input
 * being typed into and drop focus mid-number, so the totals are patched in
 * place instead.
 */
function updateHoldingTotals() {
  document.querySelectorAll('#holdings-inputs .holding').forEach((row) => {
    const input = row.querySelector('input[data-symbol]');
    const cell = row.querySelector('.holding-total strong');
    if (!input || !cell) return;
    cell.textContent = shareText(state.holdings[input.dataset.symbol] || 0) + ' sh';
  });
}

/** The shared account list, and the box for adding to it. */
function renderAccountList() {
  const list = document.getElementById('account-list');
  if (!list) return;
  list.innerHTML = state.accounts
    .map((acc) => `<li class="account">
      <span class="account-name">${escapeHtml(acc.name)}</span>
      <button type="button" class="account-remove" data-account="${acc.id}"
        aria-label="Remove ${escapeHtml(acc.name)} and its share counts">Remove</button>
    </li>`)
    .join('');

  const hint = document.getElementById('account-hint');
  if (hint) {
    hint.textContent = state.accounts.length > 1
      ? 'Each symbol below gets one box per account. Syncing an account replaces '
        + 'only its own numbers.'
      : 'Add an account for each institution, then enter what each one holds. '
        + 'FXAIX split between Fidelity and U.S. Bank needs two.';
  }

  const select = document.getElementById('csv-account');
  if (select) {
    const previous = select.value;
    const accounts = state.accounts.length ? state.accounts : [DEFAULT_ACCOUNT];
    select.innerHTML = accounts
      .map((acc) => `<option value="${acc.id}">${escapeHtml(acc.name)}</option>`)
      .join('');
    if (accounts.some((a) => a.id === previous)) select.value = previous;
  }
  const wrap = document.getElementById('csv-account-wrap');
  // With one account there is nothing to choose, and an import can only mean
  // one thing.
  if (wrap) wrap.hidden = state.accounts.length < 2;
}

/**
 * Whether the table is folded down to Symbol / Date / Amount.
 *
 * Must stay in step with the 560px breakpoint in styles.css. The duplication is
 * unavoidable: `display: none` genuinely removes a cell from its row, so the
 * footer's colspan has to shrink to match, and colspan is an HTML attribute
 * that CSS cannot touch. Left at 5 on a narrow screen it forces the table to
 * keep six columns and the whole thing scrolls sideways again.
 */
const COMPACT_QUERY = '(max-width: 560px)';

function compactLayout() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(COMPACT_QUERY).matches
    : false;
}

/**
 * The two date lines for the folded portrait column.
 *
 * Portrait drops the separate Pay date column, so one cell has to carry both.
 * Which one gets the prominent line is not a style question: the ex-date only
 * says which dividend you qualified for, while the pay date says when the cash
 * actually lands, and that is the thing worth reading at a glance.
 *
 * Not every row can answer it. Yahoo publishes no pay dates at all and Nasdaq
 * covers no mutual funds, so the funds here have none and never will from a
 * free feed. Rather than lead with "TBD" - which would be most rows, and would
 * bury the one date we do know - a row without a pay date leads with its
 * ex-date and labels it as one. The label is deliberately not "pay date TBD":
 * most such rows were paid years ago, so nothing is "to be determined" about
 * them; the pay date was simply never published. Why that happens is said once
 * in the fund's notes rather than on every row.
 */
function portraitDates(row) {
  if (row.payDate) {
    return { main: formatDate(row.payDate), alt: 'ex ' + formatDateShort(row.exDate) };
  }
  return { main: formatDate(row.exDate), alt: 'ex-date' };
}

function renderTable(rows) {
  const body = document.getElementById('dist-body');
  const empty = document.getElementById('empty-state');
  const today = state.today;
  const hasHoldings = Object.values(state.holdings).some((v) => v > 0);

  // Drop the old footer before the empty-set check. Leaving it behind showed a
  // total for rows that are no longer on screen, and now that its colspan is
  // layout-dependent it would also be left spanning five columns in a table
  // folded down to three.
  const staleFoot = document.querySelector('#dist-table tfoot');
  if (staleFoot) staleFoot.remove();

  if (!rows.length) {
    body.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const nextIdx = rows.findIndex((r) => r.date > today);
  let lastQuarterKey = null;
  // Read once rather than per row: matchMedia is a layout query, and this runs
  // for every distribution on screen.
  const compact = compactLayout();

  body.innerHTML = rows
    .map((row, idx) => {
      const badge = `<span class="badge ${row.status}">${row.status}</span>`;
      const conf = row.status === 'projected' && row.confidence != null
        ? `<span class="conf">${Math.round(row.confidence * 100)}% confidence</span>`
        : '';
      const tooltip = row.status === 'projected'
        ? row.basis
        : [row.source, row.note].filter(Boolean).join(' — ');

      const quarter = quarterOf(row.date);
      // Label the first row of each run so the band has a heading, and keep the
      // label in the accessibility tree on the rest: a colour stripe alone
      // conveys nothing to a screen reader or to anyone who can't tell the
      // hues apart.
      const startsQuarter = quarter && quarter.key !== lastQuarterKey;
      if (quarter) lastQuarterKey = quarter.key;
      const quarterMark = quarter
        ? (startsQuarter
          ? `<span class="quarter">${quarter.label}</span>`
          : `<span class="visually-hidden">${quarter.label}</span>`)
        : '';

      // Narrow screens hide the per-share and shares columns, so the amount
      // cell has to carry the breakdown itself - otherwise anyone who hasn't
      // entered share counts sees a column of em dashes and nothing else.
      //
      // Two lines, not one: a table column is sized from its widest unbreakable
      // run, so "$0.9100 × 7,885.97 sh" on a single line dragged the column
      // ~27px wider than the phone had to give and pushed the dollar figure off
      // the right edge. Splitting it halves the column's appetite and still
      // reads top-to-bottom as a multiplication.
      const amountAlt = row.dollars != null
        ? `<span class="alt-line">${perShare(row.amount)}</span> `
          + `<span class="alt-line">× ${shareText(row.shares)} sh</span>`
        : `<span class="alt-line">${perShare(row.amount)}</span> `
          + '<span class="alt-line">per share</span>';

      // Portrait leads with the pay date; the wide table has a column of its
      // own for that, so there the ex-date stays in its own column and the
      // folded line is the redundant one CSS hides.
      const dates = compact
        ? portraitDates(row)
        : {
          main: formatDate(row.exDate),
          alt: row.payDate ? 'pays ' + formatDateShort(row.payDate) : 'pay date TBD',
        };

      return `<tr class="dist-row ${row.status}${quarter ? ' q' + quarter.index : ''}${idx === nextIdx ? ' next-up' : ''}">
        <td class="c-sym"><span class="sym">${row.symbol}</span><span class="status-mini ${row.status}">${row.status}</span><span class="kind">${KIND_LABEL[row.kind] || row.kind}</span></td>
        <td class="c-ex"><span class="date-main">${dates.main}</span>${quarterMark}<span class="date-alt">${dates.alt}</span></td>
        <td class="c-pay">${row.payDate ? formatDate(row.payDate) : '—'}</td>
        <td class="c-per num">${perShare(row.amount)}</td>
        <td class="c-sh num">${row.shares != null ? shareText(row.shares) : '—'}</td>
        <td class="c-amt num"><span class="amt${row.dollars != null ? '' : ' amt-none'}">${row.dollars != null ? money(row.dollars) : '—'}</span><span class="amt-alt">${amountAlt}</span></td>
        <td class="c-status" title="${String(tooltip).replace(/"/g, '&quot;')}">${badge}${conf}</td>
      </tr>`;
    })
    .join('');

  const total = rows.reduce((acc, r) => acc + (hasHoldings ? (r.dollars || 0) : r.amount), 0);
  const tfoot = document.createElement('tfoot');
  tfoot.innerHTML = `<tr><td colspan="${compact ? 2 : 5}">Total shown (${rows.length} row${rows.length === 1 ? '' : 's'})</td>
    <td class="c-amt num">${hasHoldings ? money(total) : perShare(total)}</td><td class="c-status"></td></tr>`;
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
    const account = input.dataset.account || DEFAULT_ACCOUNT.id;
    // Typing into the implicit default account makes it real, so the box the
    // user just filled in does not vanish on the next render.
    if (!findAccount(state.accounts, account)) {
      state.accounts = addAccount(state.accounts, DEFAULT_ACCOUNT.name).accounts;
    }
    state.lots = setLot(state.lots, input.dataset.symbol, account,
      Number.parseFloat(input.value));
    commitLots();
    markSynced('Manual entry');
    renderSyncPill();
    updateHoldingTotals();
    document.getElementById('holdings-hint').textContent =
      `${Object.keys(state.holdings).length} position(s) saved on this device`;
    render();
  });

  document.getElementById('add-account').addEventListener('click', () => {
    const box = document.getElementById('account-name');
    const name = box.value.trim();
    if (!name) { setStatus('Give the account a name first.', 'error'); return; }
    const result = addAccount(state.accounts, name);
    if (!result.added) {
      setStatus(`“${result.account.name}” is already on the list.`, 'error');
      return;
    }
    state.accounts = result.accounts;
    box.value = '';
    commitLots();
    renderHoldingsInputs();
    setStatus(`Added ${result.account.name}. Enter what it holds below.`, 'ok');
  });

  document.getElementById('account-name').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    document.getElementById('add-account').click();
  });

  document.getElementById('account-list').addEventListener('click', (event) => {
    const button = event.target.closest('.account-remove');
    if (!button) return;
    const account = findAccount(state.accounts, button.dataset.account);
    const held = Object.values(state.lots)
      .filter((byAccount) => Number(byAccount[button.dataset.account]) > 0).length;
    if (held && !window.confirm(
      `Remove ${account ? account.name : 'this account'} and the ${held} share `
      + 'count(s) filed under it? Other accounts are not affected.')) return;
    const next = removeAccount(state.accounts, state.lots, button.dataset.account);
    state.accounts = next.accounts;
    state.lots = next.lots;
    commitLots();
    renderHoldingsInputs();
    setStatus(`Removed ${account ? account.name : 'the account'}.`, 'ok');
    render();
  });

  document.getElementById('clear-holdings').addEventListener('click', () => {
    state.holdings = {};
    state.lots = {};
    state.accounts = [];
    state.syncMeta = { at: null, source: null };
    state.syncSources = {};
    save(HOLDINGS_KEY, state.holdings);
    save(LOTS_KEY, state.lots);
    save(ACCOUNTS_KEY, state.accounts);
    save(SYNC_META_KEY, state.syncMeta);
    save(SYNC_SOURCES_KEY, state.syncSources);
    renderHoldingsInputs();
    renderSyncPill();
    renderStaleness();
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
        // A positions export is the whole of what that institution holds, so
        // it replaces that account rather than merging into it - otherwise
        // anything sold stays on screen forever. Only the chosen account is
        // touched; the same fund held elsewhere is left alone.
        const select = document.getElementById('csv-account');
        const target = (select && select.value) || DEFAULT_ACCOUNT.id;
        const account = findAccount(state.accounts, target)
          || (state.accounts.length ? state.accounts[0] : DEFAULT_ACCOUNT);
        const result = replaceAccountLots(state.lots, account.id, found, known);
        if (result.kept === 0) {
          setStatus('No tracked tickers in that file, so nothing was changed. '
            + `Looked for ${known.join(', ')}.`, 'error');
          return;
        }
        state.accounts = addAccount(state.accounts, account.name).accounts;
        state.lots = result.lots;
        commitLots();
        markSynced(`CSV import — ${file.name}`);
        renderHoldingsInputs();
        renderSyncPill();
        setStatus(`Imported ${result.kept} position(s) into ${account.name}: `
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

/**
 * Guards every worker-backed action.
 *
 * Returning silently — which the SnapTrade and disconnect paths both used to do
 * — makes the button look broken rather than unconfigured. Say why instead.
 */
function requireWorker(what) {
  if (WORKER_BASE) return true;
  setStatus(`${what} needs the Cloudflare Worker, and none is configured. `
    + 'Deploy worker/ and set WORKER_BASE in docs/config.js.', 'error');
  return false;
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

/**
 * Files a {SYMBOL: shares} map under the account owned by `provider`, keeping
 * only tracked tickers.
 *
 * The account is created on first sight, so syncing does not require setting
 * the institution up by hand first, and it is identified by the provider - a
 * stable string this code chooses - rather than by whatever label the provider
 * happens to print. See `syncAccount` for why that matters.
 *
 * It *replaces* that account's holdings rather than merging: a position sold
 * at Fidelity arrives as an absence, and an absence cannot overwrite anything,
 * so a merge would leave the sold row on screen forever. Every other account
 * is left untouched, which is the point - syncing Fidelity must not disturb
 * the FXAIX shares held at U.S. Bank.
 *
 * Returns the number of positions kept; 0 means nothing was written at all, so
 * a CSV with the wrong column headings cannot empty a good account.
 */
function applyHoldings(holdings, source, provider) {
  const known = new Set(state.data.symbols.map((s) => s.symbol));
  const label = String(source || '').trim() || 'Manual entry';
  const resolved = syncAccount(state.accounts, provider || accountId(label), label);
  const probe = replaceAccountLots(state.lots, resolved.account.id, holdings, known);
  if (probe.kept === 0) return 0;

  const overlap = resolved.created
    ? overlappingSymbols(state.lots, resolved.account.id, holdings).filter((s) => known.has(s))
    : [];
  state.syncNote = overlap.length
    ? ` “${resolved.account.name}” is new, so its ${overlap.join(', ')} shares are being `
      + 'added to what your other accounts already hold. If that is the same money '
      + 'reported twice, remove the duplicate under Accounts.'
    : '';

  state.accounts = resolved.accounts;
  state.lots = probe.lots;
  commitLots();
  markSynced(source);
  renderHoldingsInputs();
  renderSyncPill();
  render();
  return probe.kept;
}

/**
 * Explain a sync that succeeded but changed nothing.
 *
 * "none matched configured tickers" states the outcome and hides the cause.
 * The two facts that locate the problem are what the institution reported and
 * what this page tracks: if they disagree because the account genuinely holds
 * nothing tracked, that is fine and final; if they disagree because a ticker
 * arrived spelled differently, seeing both lists side by side is the only way
 * to notice. Naming them also makes a sandbox credential obvious immediately -
 * Plaid's test banks return ACHN and BTC, never your real positions.
 */
function unmatchedMessage(holdings, source, tracked, context) {
  const found = Object.keys(holdings || {}).sort();
  const shown = found.slice(0, 6).join(', ');
  const rest = found.length > 6 ? ` and ${found.length - 6} more` : '';
  return `Synced ${source}${context ? ' ' + context : ''}, but none of its `
    + `${found.length} position(s) matched the symbols this page tracks `
    + `(${(tracked || []).join(', ') || 'none configured'}). `
    + (found.length ? `It reported: ${shown}${rest}. ` : '')
    + 'Nothing was changed.';
}

function trackedSymbols() {
  return state.data.symbols.map((s) => s.symbol);
}

async function syncFromBank() {
  if (!requireWorker('Bank sync')) return;
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
      const kept = applyHoldings(holdings, source, 'plaid');
      if (kept === 0) {
        setStatus(unmatchedMessage(holdings, source, trackedSymbols()), 'error');
      } else {
        setStatus(`Refreshed ${kept} position(s) from ${source}. No new bank sign-in needed.`
          + state.syncNote, 'ok');
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
          const kept = applyHoldings(holdings, source, 'plaid');
          if (kept === 0) {
            setStatus(unmatchedMessage(holdings, source, trackedSymbols()), 'error');
            restore();
            return;
          }
          setStatus(payload.persisted
            ? `Synced ${kept} position(s) from ${source}. Connection saved, so future syncs skip the bank sign-in.${state.syncNote}`
            : `Synced ${kept} position(s) from ${source}. Access token discarded (no KV bound).${state.syncNote}`, 'ok');
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
  if (!requireWorker('Disconnecting')) return;
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
  if (!requireWorker('SnapTrade sync')) return;
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
    const kept = applyHoldings(holdings, source, 'snaptrade');
    if (kept === 0) {
      setStatus(unmatchedMessage(holdings, source, trackedSymbols(),
        `across ${payload.accounts} account(s)`), 'error');
    } else {
      setStatus(`Synced ${kept} position(s) from ${source} across ${payload.accounts} account(s).`
        + state.syncNote, 'ok');
    }
  } catch (err) {
    setStatus('SnapTrade sync failed: ' + err.message, 'error');
  } finally {
    restore();
  }
}

/* ---------------------------------------------------------------------- init */

/* Fetches data.json, bypassing every cache between here and the server. */
async function loadData() {
  const response = await fetch('data.json?t=' + Date.now(), { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

/*
 * Re-renders everything that depends on data.json. Binds nothing, so it is safe
 * to call on every refresh - which is the whole point of keeping it separate
 * from init().
 */
function applyData() {
  // Re-read the date, not just the data. An installed app now stays open for
  // days and re-renders on every foreground, and every date comparison in
  // render() - what counts as "upcoming", the next-up highlight, the trailing
  // and forward 12-month windows, the DRIP cut-off - is made against
  // state.today. Left at its load-time value, an app open across midnight
  // would pull fresh figures and then file yesterday under "upcoming".
  state.today = startOfToday();
  renderMeta();
  renderStaleness();
  renderHoldingsInputs();
  renderNotes();
  render();
}

/* Midnight today, honouring the test clock so fixtures stay deterministic. */
function startOfToday() {
  const now = state.nowOverride instanceof Date ? new Date(state.nowOverride) : new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

/* ------------------------------------------------------ staying up to date
 *
 * An installed app has no address bar and no reload button, so without the
 * three mechanisms below the only way to pick up a new build is to force-quit
 * it. They are:
 *
 *   1. the service worker registers with updateViaCache: 'none' and is asked to
 *      re-check on load and on every foreground, so a new sw.js is noticed;
 *   2. sw.js calls skipWaiting(), so a new version claims this page at once,
 *      and controllerchange then reloads it exactly once;
 *   3. a pull-to-refresh gesture, for when the user wants to force the issue.
 *
 * sw.js is also network-first now, so even without any of this a plain reload
 * gets the current files rather than whatever was cached on install day.
 */

const AUTO_REFRESH_MIN_GAP_MS = 60 * 1000;

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

  // On a first-ever visit there is no controller yet, and the new worker
  // claiming the page is not a version change - reloading for that would be a
  // pointless flash on every fresh install.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((registration) => {
      state.swRegistration = registration;
      registration.update().catch(() => { /* offline */ });
    })
    .catch(() => { /* the offline cache is optional */ });
}

/*
 * Quietly pulls fresh figures when the app comes back to the foreground.
 * Rate-limited because switching apps is a far more frequent event than the
 * once-a-day build it is looking for.
 */
function autoRefresh() {
  const now = Date.now();
  if (state.refreshing) return;
  if (state.lastRefreshAt && now - state.lastRefreshAt < AUTO_REFRESH_MIN_GAP_MS) return;
  if (state.swRegistration) state.swRegistration.update().catch(() => {});
  refreshNow({ quiet: true });
}

/*
 * Re-fetches data.json and re-renders. Also asks the service worker to look for
 * a new build: the two reasons to pull down are "are these figures current" and
 * "did the app itself change", and the user cannot be expected to distinguish.
 */
async function refreshNow(options) {
  const quiet = !!(options && options.quiet);
  if (state.refreshing) return;
  state.refreshing = true;

  const indicator = document.getElementById('pull-indicator');
  const label = indicator && indicator.querySelector('.pull-text');
  const say = (text) => { if (label && !quiet) label.textContent = text; };
  const collapse = (delay) => {
    if (!indicator || quiet) return;
    window.setTimeout(() => { indicator.style.height = '0px'; }, delay);
  };

  say('Refreshing…');
  try {
    if (state.swRegistration) state.swRegistration.update().catch(() => {});
    state.data = await loadData();
    state.lastRefreshAt = Date.now();
    // If the very first load failed, this is the moment the page becomes
    // usable: finish the wiring before rendering, or the table appears with
    // dead controls.
    activate();
    applyData();
    say('Up to date');
    collapse(600);
  } catch (err) {
    // Leave the previous figures on screen rather than blanking the page; the
    // staleness banner is what tells the user they are looking at old numbers.
    say('Could not refresh');
    renderStaleness();
    collapse(1500);
  } finally {
    state.refreshing = false;
  }
}

/* How far the indicator travels, and how far it must travel to fire. */
const PULL_TRIGGER_PX = 64;
const PULL_MAX_PX = 96;
/*
 * How far a finger must move before the gesture commits to being a pull. Below
 * this the direction is not yet knowable, and guessing wrong steals the touch
 * from something else.
 */
const PULL_SLOP_PX = 10;

function setupPullToRefresh() {
  const indicator = document.getElementById('pull-indicator');
  const label = indicator && indicator.querySelector('.pull-text');
  if (!indicator || !label) return;

  // Bound everywhere rather than only in an installed app. Where the platform
  // has its own pull-to-refresh, `overscroll-behavior-y: contain` plus the
  // preventDefault below suppress it, so there is one gesture with one
  // behaviour instead of two that differ depending on how the page was opened.
  let startY = null;
  let startX = null;
  let pulled = 0;
  // A touch that began at the top of the page, direction not yet decided.
  let tracking = false;
  // ...and one that has since proved to be a downward pull.
  let claimed = false;

  const release = () => {
    tracking = false;
    claimed = false;
    startY = null;
    startX = null;
    pulled = 0;
    indicator.style.height = '0px';
  };

  document.addEventListener('touchstart', (event) => {
    if (state.refreshing || event.touches.length !== 1 || window.scrollY > 0) return;
    startY = event.touches[0].clientY;
    startX = event.touches[0].clientX;
    pulled = 0;
    tracking = true;
    claimed = false;
  }, { passive: true });

  document.addEventListener('touchmove', (event) => {
    if (!tracking) return;
    // A second finger means a pinch or a zoom, not a pull.
    if (event.touches.length !== 1) { release(); return; }

    const dy = event.touches[0].clientY - startY;
    const dx = event.touches[0].clientX - startX;

    if (!claimed) {
      // Say nothing until the finger has moved far enough to have an obvious
      // direction. preventDefault on the first touchmove of a gesture cancels
      // scrolling for the whole gesture, so claiming early on a stray pixel of
      // downward drift makes the table impossible to pan sideways - and it is
      // genuinely side-scrollable in landscape, above the fold breakpoint.
      if (Math.abs(dy) < PULL_SLOP_PX && Math.abs(dx) < PULL_SLOP_PX) return;
      if (dy <= 0 || Math.abs(dx) >= dy) { release(); return; }
      claimed = true;
    }

    if (window.scrollY > 0) { release(); return; }
    // Damped, so it feels like pulling against a spring instead of dragging a
    // sheet: the finger travels twice as far as the indicator. The slop is
    // subtracted so the indicator opens from zero rather than jumping.
    pulled = Math.min(PULL_MAX_PX, (dy - PULL_SLOP_PX) * 0.5);
    indicator.style.height = pulled + 'px';
    label.textContent = pulled >= PULL_TRIGGER_PX ? 'Release to refresh' : 'Pull to refresh';
    event.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!tracking) return;
    const fire = claimed && pulled >= PULL_TRIGGER_PX;
    tracking = false;
    claimed = false;
    startY = null;
    startX = null;
    if (!fire) { release(); return; }
    indicator.style.height = PULL_TRIGGER_PX + 'px';
    refreshNow();
  }, { passive: true });

  document.addEventListener('touchcancel', release, { passive: true });
}

async function init() {
  state.today = startOfToday();
  state.holdings = load(HOLDINGS_KEY, {});
  state.prefs = load(PREFS_KEY, state.prefs);
  state.syncMeta = load(SYNC_META_KEY, { at: null, source: null });
  state.syncSources = migrateSyncMeta(state.syncMeta, load(SYNC_SOURCES_KEY, {}));
  save(SYNC_SOURCES_KEY, state.syncSources);

  state.accounts = loadArray(ACCOUNTS_KEY);
  state.lots = load(LOTS_KEY, {});
  // Gate on the key being *absent*, not on it being empty. An empty object is
  // a real state - the user pressed Clear - and re-running the migration would
  // resurrect whatever an older build left behind in the flat map.
  const migrated = hasStored(LOTS_KEY)
    ? null
    : migrateHoldings(state.holdings, state.syncMeta);
  if (migrated) {
    // Union rather than choose: an account list can already exist without any
    // lots, and dropping the migrated account would leave its shares filed
    // under an id with no input box - counted in the totals but impossible to
    // edit or remove.
    state.accounts = migrated.accounts.reduce(
      (list, account) => addAccount(list, account.name).accounts, state.accounts);
    state.lots = migrated.lots;
    commitLots();
  } else {
    // Pick up anything an older build wrote straight into the flat map, then
    // refresh that map from the lots so the rollback copy never goes stale.
    if (hasStored(HOLDINGS_KEY)) {
      const fallback = (state.accounts[0] || DEFAULT_ACCOUNT).id;
      const reconciled = reconcileFlatHoldings(state.lots, state.holdings, fallback);
      if (reconciled.changed) {
        state.lots = reconciled.lots;
        state.accounts = addAccount(state.accounts,
          (state.accounts[0] || DEFAULT_ACCOUNT).name).accounts;
      }
    }
    if (hasStored(LOTS_KEY) || Object.keys(state.lots).length) commitLots();
    else state.holdings = totalsFromLots(state.lots);
  }

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

  // Everything that can recover from a failed first load has to be wired up
  // *before* that load is attempted. A first visit that fails - offline, or a
  // bad deploy - is precisely when the user needs a way to retry, and leaving
  // these until afterwards left them staring at an error with no gesture, no
  // foreground refresh and no offline cache: the very dead end this is meant
  // to remove.
  registerServiceWorker();
  setupPullToRefresh();

  // An installed PWA is resumed far more often than it is loaded. Re-check on
  // resume so a session left open for days doesn't sit on a load-time verdict,
  // and quietly pick up both new figures and a new build while we are at it.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    renderStaleness();
    autoRefresh();
  });

  // Rotating the phone crosses the breakpoint, and the footer's colspan is
  // baked into the markup at render time, so the table has to be rebuilt.
  if (typeof window.matchMedia === 'function') {
    window.matchMedia(COMPACT_QUERY).addEventListener('change', () => render());
  }

  try {
    state.data = await loadData();
  } catch (err) {
    document.getElementById('meta').textContent =
      'Could not load data.json (' + err.message + '). Pull down to retry.';
    // A failed fetch is exactly when a staleness warning matters most: the
    // service worker may serve an old cached copy and look perfectly normal.
    renderStaleness();
    return;
  }

  activate();
  applyData();
}

/*
 * The one-time setup that needs data.json in hand. Split out of init() so that
 * a refresh which succeeds after a failed first load still finishes wiring the
 * page up, rather than rendering a table whose controls do nothing.
 */
function activate() {
  if (state.activated) return;
  state.activated = true;

  document.getElementById('hide-projected').checked = !!state.prefs.hideProjected;
  document.getElementById('drip-toggle').checked = !!state.prefs.drip;
  document.querySelectorAll('.segmented button').forEach((button) => {
    button.classList.toggle('active', button.dataset.range === state.prefs.range);
  });
  bindEvents();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

// Exported so the CSV import and staleness logic can be unit tested under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseCsv,
    extractHoldings,
    parseDate,
    quarterOf,
    portraitDates,
    classifyFreshness,
    worstLevel,
    isConcerning,
    migrateSyncMeta,
    parseGeneratedAt,
    describeAgeHours,
    latestSource,
    accountId,
    findAccount,
    addAccount,
    syncAccount,
    uniqueAccountId,
    overlappingSymbols,
    unmatchedMessage,
    reconcileFlatHoldings,
    removeAccount,
    totalsFromLots,
    setLot,
    replaceAccountLots,
    migrateHoldings,
  };
}
