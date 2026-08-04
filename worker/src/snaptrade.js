/*
 * SnapTrade client for divtracker.
 *
 * An alternative to Plaid for pulling share counts. Both reach Fidelity over
 * the same rail - Fidelity Access, Fidelity's own OAuth consent program - so
 * neither is fundamentally more reliable at the brokerage boundary. SnapTrade
 * wins on terms rather than plumbing:
 *
 *   - Its Personal tier is free and is meant for exactly this (an individual
 *     connecting their own accounts), so there is no equivalent of Plaid's
 *     10-Items-for-the-lifetime-of-the-account Trial cap.
 *   - It is brokerage-first, where Plaid is bank-first with investments bolted
 *     on, so positions are a primary object rather than an add-on product.
 *
 * PERSONAL KEY AUTHENTICATION
 * ---------------------------
 * With a Personal client ID + consumer key the key itself identifies the user:
 *
 *   "Do not create a SnapTrade user [...] Do not store or send a userSecret.
 *    Omit userId and userSecret when making API requests; SnapTrade resolves
 *    the user from the Personal API key."
 *   - docs.snaptrade.com/docs/personal-vs-commercial
 *
 * So this module deliberately never registers a user and never sends userId or
 * userSecret. Sending them would be a Commercial-integration pattern.
 *
 * REQUEST SIGNING
 * ---------------
 * Per docs.snaptrade.com/docs/request-signatures:
 *   1. clientId and timestamp go in the query string.
 *   2. Build { content, path, query }; content is null when there is no body.
 *   3. Serialize to canonical JSON - keys sorted at every level, no whitespace.
 *   4. HMAC-SHA256 with the consumerKey, base64-encoded, in a Signature header.
 *
 * The signature covers the exact query string that is sent, so the string used
 * to build the URL and the string that is signed must be byte-identical. This
 * module builds it once and reuses it rather than re-serializing.
 */

const SNAPTRADE_HOST = "https://api.snaptrade.com";
const API_PREFIX = "/api/v1";

/**
 * Canonical JSON: object keys sorted at every level, no insignificant space.
 *
 * JSON.stringify does not sort keys, so a plain stringify of the same logical
 * payload can produce a different byte string and therefore a signature that
 * SnapTrade rejects.
 */
function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** HMAC-SHA256(consumerKey, canonicalJson({content, path, query})) -> base64. */
async function signRequest(consumerKey, { content, path, query }) {
  const payload = canonicalJson({
    content: content === undefined ? null : content,
    path,
    query,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(consumerKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64FromBuffer(sig);
}

/**
 * Builds the query string. Order matters: this exact string is both signed and
 * sent, and SnapTrade says not to sort or re-encode it.
 */
function buildQuery(clientId, timestamp, extra) {
  const parts = [
    `clientId=${encodeURIComponent(clientId)}`,
    `timestamp=${timestamp}`,
  ];
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join("&");
}

function snaptradeConfigured(env) {
  return Boolean(env && env.SNAPTRADE_CLIENT_ID && env.SNAPTRADE_CONSUMER_KEY);
}

async function snaptrade(env, method, endpoint, body, extraQuery) {
  if (!snaptradeConfigured(env)) {
    throw new Error(
      "SnapTrade is not configured. Set SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY."
    );
  }
  const path = `${API_PREFIX}${endpoint}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const query = buildQuery(env.SNAPTRADE_CLIENT_ID, timestamp, extraQuery);
  const hasBody = body !== undefined && body !== null;
  const signature = await signRequest(env.SNAPTRADE_CONSUMER_KEY, {
    content: hasBody ? body : null,
    path,
    query,
  });

  const resp = await fetch(`${SNAPTRADE_HOST}${path}?${query}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Signature: signature,
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* leave null */ }
  if (!resp.ok) {
    const detail =
      (payload && (payload.detail || payload.message || payload.error)) ||
      text ||
      `HTTP ${resp.status}`;
    throw new Error(`SnapTrade ${endpoint}: ${detail}`);
  }
  return payload;
}

/**
 * Pulls a ticker out of a position.
 *
 * SnapTrade nests the symbol differently across account types and API
 * versions - sometimes a bare string, sometimes one or two UniversalSymbol
 * wrappers deep, and options use raw_symbol. Rather than guess one shape and
 * silently return {} when it changes, walk the known shapes in order.
 */
function extractTicker(position) {
  if (!position || typeof position !== "object") return "";
  const candidates = [
    position.symbol,
    position.symbol && position.symbol.symbol,
    position.symbol && position.symbol.symbol && position.symbol.symbol.symbol,
    position.symbol && position.symbol.raw_symbol,
    position.symbol && position.symbol.symbol && position.symbol.symbol.raw_symbol,
    position.universal_symbol && position.universal_symbol.symbol,
    position.ticker,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().toUpperCase();
  }
  return "";
}

function extractUnits(position) {
  if (!position || typeof position !== "object") return NaN;
  const raw = position.units !== undefined && position.units !== null
    ? position.units
    : position.quantity;
  return Number(raw);
}

/** Aggregates SnapTrade positions into {SYMBOL: shares}, matching Plaid's shape. */
function aggregatePositions(positions) {
  const out = {};
  for (const p of positions || []) {
    const ticker = extractTicker(p);
    if (!ticker) continue;
    const units = extractUnits(p);
    if (!Number.isFinite(units) || units <= 0) continue;
    out[ticker] = (out[ticker] || 0) + units;
  }
  return out;
}

/** Connection Portal URL. Personal keys omit userId/userSecret by design. */
async function createPortalUrl(env) {
  const payload = await snaptrade(env, "POST", "/snapTrade/login", null);
  const url = payload && (payload.redirectURI || payload.redirect_uri || payload.redirectUri);
  if (!url) throw new Error("SnapTrade did not return a Connection Portal URL.");
  return url;
}

async function listAccounts(env) {
  const accounts = await snaptrade(env, "GET", "/accounts", null);
  return Array.isArray(accounts) ? accounts : [];
}

/**
 * Reads positions across every connected account and merges them.
 *
 * One brokerage login can expose several accounts (brokerage, Roth, HSA), and
 * the same fund is often held in more than one, so totals must sum rather than
 * overwrite - the same reason the Plaid path aggregates.
 */
async function fetchSnaptradeHoldings(env) {
  const accounts = await listAccounts(env);
  if (accounts.length === 0) {
    return { holdings: {}, institution: null, accounts: 0, connected: false };
  }

  const merged = {};
  const institutions = new Set();
  for (const account of accounts) {
    const id = account && (account.id || account.account_id);
    if (!id) continue;
    const name = account && (account.institution_name || account.brokerage_authorization_name);
    if (name) institutions.add(String(name));

    let positions = [];
    try {
      positions = await snaptrade(env, "GET", `/accounts/${encodeURIComponent(id)}/positions`, null);
    } catch (err) {
      // Older deployments and some account types still answer on /holdings.
      const wrapper = await snaptrade(env, "GET", `/accounts/${encodeURIComponent(id)}/holdings`, null);
      positions = (wrapper && wrapper.positions) || [];
    }
    const partial = aggregatePositions(Array.isArray(positions) ? positions : []);
    for (const [sym, qty] of Object.entries(partial)) {
      merged[sym] = (merged[sym] || 0) + qty;
    }
  }

  // Name every linked brokerage rather than counting them. The front end no
  // longer keys storage off this string, but it is still what the user reads,
  // and "2 accounts" tells them nothing about which two.
  const named = [...institutions];
  const institution = named.length === 0 ? null
    : named.length <= 3 ? named.join(" + ")
      : `${named.slice(0, 2).join(" + ")} +${named.length - 2} more`;

  return {
    holdings: merged,
    institution,
    accounts: accounts.length,
    connected: true,
  };
}

export {
  canonicalJson,
  signRequest,
  buildQuery,
  snaptradeConfigured,
  aggregatePositions,
  extractTicker,
  extractUnits,
  createPortalUrl,
  listAccounts,
  fetchSnaptradeHoldings,
};
