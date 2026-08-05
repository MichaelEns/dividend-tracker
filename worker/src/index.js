/*
 * Cloudflare Worker: Plaid federated sync for divtracker.
 *
 * Two endpoints, both CORS-protected against ALLOWED_ORIGINS:
 *
 *   POST /link/token/create
 *     -> Plaid /link/token/create with products=investments.
 *     Returns { link_token } to the browser so it can open Plaid Link.
 *
 *   POST /link/token/exchange   body: { public_token }
 *     -> Plaid /item/public_token/exchange -> access_token
 *     -> Plaid /investments/holdings/get   -> holdings + securities
 *     Aggregates {SYMBOL: shares}, plus the institution name, and returns
 *     that to the browser. The access_token is never returned to the browser.
 *
 *   POST /holdings/refresh
 *     Re-reads holdings using the stored access_token. No Plaid Link flow and
 *     no new Item, so this is free and unlimited on a Plaid Trial plan.
 *
 *   POST /item/disconnect
 *     Plaid /item/remove, then forgets the stored token.
 *
 *   POST /status  -> { connected, institution, connectedAt }
 *
 * TOKEN PERSISTENCE
 * -----------------
 * Plaid's Trial plan (free, no expiry) allows 10 Production Items *for the
 * lifetime of the account*, and removing an Item does NOT give the slot back:
 *
 *   "Removing Items created on a Trial plan (using /item/remove) will not
 *    allow you to create more Items."  - plaid.com/docs/account/billing
 *
 * So a connect-read-remove cycle burns one of the ten slots on every sync and
 * dies permanently on the eleventh. To stay free indefinitely we link ONCE and
 * keep the access_token in KV, refreshing through it thereafter.
 *
 * If the TOKENS KV namespace is not bound, the worker falls back to the old
 * one-off remove-after-read behaviour, so an existing deployment keeps working.
 *
 * WHY A PASSPHRASE IS REQUIRED
 * ----------------------------
 * With no stored token, an attacker had nothing to steal: producing holdings
 * required completing Plaid Link with the user's own bank credentials, so an
 * Origin check was enough. A stored token removes that barrier - /holdings/
 * refresh would hand real brokerage positions to any caller. The Origin header
 * is trivially forged outside a browser (curl -H "Origin: ..."), and the site
 * is public, so the worker URL is public too. Every sensitive endpoint
 * therefore requires a shared passphrase, compared in constant time.
 *
 * Secrets are read from Worker env at request time. Configure via wrangler:
 *   wrangler secret put PLAID_CLIENT_ID
 *   wrangler secret put PLAID_SECRET
 *   wrangler secret put PLAID_ENV           (sandbox | development | production)
 *   wrangler secret put ALLOWED_ORIGINS     (https://<you>.github.io, ...)
 *   wrangler secret put SYNC_PASSPHRASE     (a long random string)
 *   wrangler kv namespace create TOKENS     (then paste the id into wrangler.toml)
 *
 * SnapTrade is an optional alternative provider (see snaptrade.js). Configure
 * it instead of, or alongside, Plaid:
 *   wrangler secret put SNAPTRADE_CLIENT_ID
 *   wrangler secret put SNAPTRADE_CONSUMER_KEY
 *
 *   POST /snaptrade/portal   -> { url } to open the Connection Portal
 *   POST /snaptrade/holdings -> { holdings, institution }
 *
 * SnapTrade needs no token storage here: its Personal key identifies the user,
 * so there is nothing per-connection to persist and no Item quota to exhaust.
 */

import {
  snaptradeConfigured,
  createPortalUrl,
  fetchSnaptradeHoldings,
} from "./snaptrade.js";
import { authorized, originAllowed } from "./auth.js";
import { classifyAccount } from "./accounts.js";

const ITEMS_KEY = "plaid:items";
// Pre-multi-institution deployments stored a single Item here. Read once at
// startup and folded into the list, so an existing connection is not dropped.
const LEGACY_TOKEN_KEY = "plaid:item:default";
const PLAID_HOSTS = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

// What a stored connection is for. The dividend page wants investments at a US
// broker; the balances page wants a Canadian chequing account. Those need
// different Plaid products and different country codes, and polling one for
// the other's data only ever produces an error, so each token records which
// page linked it.
const SCOPE_HOLDINGS = "holdings";
const SCOPE_BALANCES = "balances";

/** Only ever the two known scopes, defaulting to the original behaviour. */
function linkScope(value) {
  return value === SCOPE_BALANCES ? SCOPE_BALANCES : SCOPE_HOLDINGS;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true, service: "divtracker-plaid" }, 200, cors);
      }

      // Reject disallowed callers *before* touching Plaid, so an unauthorised
      // site cannot burn API calls or start bank sign-in flows. CORS headers
      // alone would not stop a non-browser client.
      if (!originAllowed(origin, env)) {
        return json(
          {
            error:
              "Origin not allowed. Set the ALLOWED_ORIGINS secret on this worker " +
              "to your site's origin, e.g. https://<you>.github.io",
          },
          403,
          cors
        );
      }

      // The Origin header is advisory: any non-browser client can set it. Once
      // an access_token is stored server-side the endpoints below can disclose
      // real holdings, so they need a real credential rather than a header.
      if (!authorized(request.headers.get("X-Sync-Key"), env)) {
        return json(
          {
            error:
              "Unauthorized. Set the SYNC_PASSPHRASE secret on this worker and " +
              "enter the same passphrase in the page.",
          },
          401,
          cors
        );
      }

      if (url.pathname === "/status" && request.method === "POST") {
        return json(await readStatus(env), 200, cors);
      }
      if (url.pathname === "/link/token/create" && request.method === "POST") {
        const body = await safeJson(request);
        return json(await createLinkToken(env, linkScope(body && body.scope)), 200, cors);
      }
      if (url.pathname === "/link/token/update" && request.method === "POST") {
        const body = await safeJson(request);
        return json(await createUpdateToken(env, body && body.key), 200, cors);
      }
      if (url.pathname === "/link/token/exchange" && request.method === "POST") {
        const body = await safeJson(request);
        const publicToken = body && body.public_token;
        if (!publicToken) return json({ error: "missing public_token" }, 400, cors);
        return json(
          await exchangeAndFetch(env, publicToken, linkScope(body && body.scope)), 200, cors,
        );
      }
      if (url.pathname === "/holdings/refresh" && request.method === "POST") {
        return json(await refreshHoldings(env), 200, cors);
      }
      if (url.pathname === "/balances" && request.method === "POST") {
        return json(await readBalances(env), 200, cors);
      }
      if (url.pathname === "/item/disconnect" && request.method === "POST") {
        const body = await safeJson(request);
        return json(await disconnectItem(env, body && body.key), 200, cors);
      }
      if (url.pathname === "/snaptrade/portal" && request.method === "POST") {
        return json({ url: await createPortalUrl(env) }, 200, cors);
      }
      if (url.pathname === "/snaptrade/holdings" && request.method === "POST") {
        return json(await fetchSnaptradeHoldings(env), 200, cors);
      }
      return json({ error: "not found" }, 404, cors);
    } catch (err) {
      return json({ error: (err && err.message) || "internal error" }, 500, cors);
    }
  },
};

function corsHeaders(origin, env) {
  return {
    "Access-Control-Allow-Origin": originAllowed(origin, env) ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Sync-Key",
    "Vary": "Origin",
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function tokenStore(env) {
  return env.TOKENS || null;
}

/**
 * Every stored Plaid Item, oldest first.
 *
 * A list rather than a single record because holdings genuinely live at more
 * than one institution - the whole reason this app tracks shares per account.
 * Storing one Item meant linking U.S. Bank silently removed Fidelity, so the
 * two could never be synced together no matter what the front end did.
 *
 * A single KV record holds the whole list: it is a handful of entries at most,
 * and one read beats fanning out over an index.
 */
async function readItems(env) {
  const kv = tokenStore(env);
  if (!kv) return [];
  let items = [];
  try {
    const raw = await kv.get(ITEMS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) items = parsed.filter((it) => it && it.access_token);
  } catch { /* treat unreadable storage as empty rather than failing the sync */ }

  // Fold in a connection made by a single-Item deployment. Done on read so no
  // migration step has to run, and idempotent because the legacy key is
  // deleted once its token is safely in the list.
  try {
    const legacyRaw = await kv.get(LEGACY_TOKEN_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      if (legacy && legacy.access_token
        && !items.some((it) => it.access_token === legacy.access_token)) {
        items.push({ ...legacy, key: legacy.key || connectionKey(legacy) });
        await kv.put(ITEMS_KEY, JSON.stringify(items));
      }
      await kv.delete(LEGACY_TOKEN_KEY);
    }
  } catch { /* non-fatal: worst case the old connection needs re-linking */ }

  return items;
}

/**
 * The stable identity of a connection.
 *
 * Never the institution's display name: Plaid re-words those, and a re-worded
 * label would look like a brand new institution, so the same holdings would be
 * stored twice and counted twice. institution_id is assigned by Plaid and does
 * not change; item_id is the fallback when a lookup failed.
 */
function connectionKey(item) {
  return String((item && (item.institutionId || item.item_id)) || "default");
}

async function writeItems(env, items) {
  const kv = tokenStore(env);
  if (!kv) return false;
  await kv.put(ITEMS_KEY, JSON.stringify(items));
  return true;
}

async function clearStoredItems(env) {
  const kv = tokenStore(env);
  if (!kv) return;
  try { await kv.delete(ITEMS_KEY); } catch { /* non-fatal */ }
  try { await kv.delete(LEGACY_TOKEN_KEY); } catch { /* non-fatal */ }
}

async function readStatus(env) {
  const items = await readItems(env);
  return {
    connected: items.length > 0,
    connections: items.map((it) => ({
      key: it.key || connectionKey(it),
      institution: it.institution || null,
      connectedAt: it.connectedAt || null,
    })),
    // Kept so an older cached page still renders something sensible: it reads
    // a single institution name and a single timestamp.
    institution: items.length ? (items[0].institution || null) : null,
    connectedAt: items.length ? (items[0].connectedAt || null) : null,
    persistence: tokenStore(env) ? "kv" : "none",
    plaidConfigured: Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET),
    snaptradeConfigured: snaptradeConfigured(env),
  };
}
async function safeJson(req) {
  try { return await req.json(); } catch { return null; }
}

/**
 * Which Plaid developer account to use for a given kind of connection.
 *
 * The two apps can run against entirely separate Plaid accounts. That matters
 * because the free Trial plan grants 10 Production Items for the *lifetime of
 * the account*, so a second account gives the balances app its own budget:
 * re-linking a flaky Canadian bank then cannot consume slots the brokerage
 * needs. It also lets one app stay on sandbox while the other runs production.
 *
 * Everything falls back to the shared credentials, so a single-account setup
 * keeps working with nothing configured.
 */
function plaidCreds(env, scope) {
  const shared = {
    clientId: env.PLAID_CLIENT_ID,
    secret: env.PLAID_SECRET,
    host: PLAID_HOSTS[String(env.PLAID_ENV || "production").toLowerCase()]
      || PLAID_HOSTS.production,
  };
  if (scope !== SCOPE_BALANCES) return shared;

  // The override is a credential *set*, taken whole or not at all. Falling back
  // field by field would pair one account's client id with the other's secret,
  // which authenticates as neither - and Plaid reports that as a plain
  // credentials error, so it reads like the bank link broke rather than like a
  // typo in the worker's configuration.
  const parts = [
    env.PLAID_BALANCE_CLIENT_ID, env.PLAID_BALANCE_SECRET, env.PLAID_BALANCE_ENV,
  ];
  if (!parts.some(Boolean)) return shared;

  const missing = [];
  if (!env.PLAID_BALANCE_CLIENT_ID) missing.push("PLAID_BALANCE_CLIENT_ID");
  if (!env.PLAID_BALANCE_SECRET) missing.push("PLAID_BALANCE_SECRET");
  if (missing.length) {
    throw new Error(
      `The balances app is partly configured for its own Plaid account but ${missing.join(" and ")} ` +
      "is missing. A Plaid secret is specific to one account and one environment, so the client id " +
      "and secret must be set together. Unset every PLAID_BALANCE_* variable to share one account."
    );
  }

  return {
    clientId: env.PLAID_BALANCE_CLIENT_ID,
    secret: env.PLAID_BALANCE_SECRET,
    host: PLAID_HOSTS[String(env.PLAID_BALANCE_ENV || env.PLAID_ENV || "production").toLowerCase()]
      || PLAID_HOSTS.production,
  };
}

/**
 * A Plaid access token belongs to the credential pair that created it, so a
 * stored connection has to be read back with the same account that linked it.
 * Passing the item rather than a scope makes that hard to get wrong.
 */
function plaidCredsFor(env, item) {
  return plaidCreds(env, (item && item.scope) === SCOPE_BALANCES
    ? SCOPE_BALANCES : SCOPE_HOLDINGS);
}

async function plaid(env, path, body, scope) {
  const creds = typeof scope === "object" && scope !== null
    ? scope
    : plaidCreds(env, scope);
  const resp = await fetch(`${creds.host}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: creds.clientId,
      secret: creds.secret,
      ...body,
    }),
  });
  const text = await resp.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* leave null */ }
  if (!resp.ok) {
    const msg = payload && (payload.error_message || payload.error_code) || text || `HTTP ${resp.status}`;
    throw new Error(`Plaid ${path}: ${msg}`);
  }
  return payload || {};
}

async function createLinkToken(env, scope) {
  // A per-user id is required by Plaid. Keep it stable across re-links so the
  // same end user is not counted as a brand new one on every connect.
  const clientUserId = "divtracker-owner";
  const balances = scope === SCOPE_BALANCES;

  // A chequing account has no holdings and a Canadian bank is not in the US
  // institution list, so the two pages cannot share one link token. Asking for
  // `investments` in Canada does not merely return less - it hides TD Canada
  // Trust from Link's search entirely, and the bank simply looks unsupported.
  const products = (
    balances
      ? (env.PLAID_BALANCE_PRODUCTS || "transactions")
      : (env.PLAID_PRODUCTS || "investments")
  ).split(",").map((s) => s.trim()).filter(Boolean);
  const countryCodes = (
    balances
      ? (env.PLAID_BALANCE_COUNTRY_CODES || "CA")
      : (env.PLAID_COUNTRY_CODES || "US")
  ).split(",").map((s) => s.trim()).filter(Boolean);

  const payload = await plaid(env, "/link/token/create", {
    user: { client_user_id: clientUserId },
    // Shown on the bank's own consent screen. "Dividend Tracker" asking for a
    // chequing account reads like the wrong app got hold of the login, at the
    // exact moment the user is deciding whether to trust it.
    client_name: (balances && env.PLAID_BALANCE_CLIENT_NAME)
      || (balances ? "Bank Balances" : null)
      || env.PLAID_CLIENT_NAME
      || "Dividend Tracker",
    products,
    country_codes: countryCodes,
    language: "en",
  }, scope);
  return { link_token: payload.link_token };
}

/**
 * A link token that reopens an EXISTING connection to change which accounts it
 * shares.
 *
 * Plaid asks which accounts to share during sign-in, and a bank that offered
 * only a credit card leaves the rest invisible with no way back - short of
 * re-linking, which permanently consumes another of the ten Trial slots.
 *
 * Update mode reuses the Item, so it costs nothing. `products` must be omitted
 * entirely: Plaid rejects a token that specifies both an access_token and
 * products.
 */
async function createUpdateToken(env, key) {
  const items = await readItems(env);
  const item = key
    ? items.find((it) => (it.key || connectionKey(it)) === key)
    : items[0];
  if (!item) {
    throw new Error(
      key ? `No connection is stored for ${key}.` : "No connection is stored yet."
    );
  }
  const scope = (item.scope === SCOPE_BALANCES) ? SCOPE_BALANCES : SCOPE_HOLDINGS;
  const balances = scope === SCOPE_BALANCES;

  const payload = await plaid(env, "/link/token/create", {
    user: { client_user_id: "divtracker-owner" },
    client_name: (balances && env.PLAID_BALANCE_CLIENT_NAME)
      || (balances ? "Bank Balances" : null)
      || env.PLAID_CLIENT_NAME
      || "Dividend Tracker",
    country_codes: (
      balances
        ? (env.PLAID_BALANCE_COUNTRY_CODES || "CA")
        : (env.PLAID_COUNTRY_CODES || "US")
    ).split(",").map((s) => s.trim()).filter(Boolean),
    language: "en",
    access_token: item.access_token,
    update: { account_selection_enabled: true },
  }, plaidCredsFor(env, item));

  return {
    link_token: payload.link_token,
    institution: item.institution || null,
    key: item.key || connectionKey(item),
  };
}

async function exchangeAndFetch(env, publicToken, scope) {
  const exchange = await plaid(env, "/item/public_token/exchange", {
    public_token: publicToken,
  }, scope);
  const accessToken = exchange.access_token;
  if (!accessToken) throw new Error("Plaid returned no access_token.");

  const canPersist = Boolean(tokenStore(env));
  const balances = scope === SCOPE_BALANCES;

  let result;
  try {
    // A chequing account genuinely has no holdings, so asking for them would
    // fail and the bank would never link at all. "A token we could not use"
    // has to mean something different depending on what it was linked for.
    result = balances
      ? await fetchAccountSummary(env, accessToken, scope)
      : await fetchHoldings(env, accessToken, scope);
  } catch (err) {
    if (!canPersist) {
      // Nowhere to keep the token, so it could never be used again. Releasing
      // the Item is the only way not to leave a live connection behind.
      try {
        await plaid(env, "/item/remove", { access_token: accessToken }, scope);
      } catch { /* ignore */ }
      throw err;
    }

    // We CAN persist, so keep it. The exchange already succeeded, which means
    // a Trial Item is already spent and /item/remove does NOT refund it.
    // Discarding the token here would leave a live Item that nothing can ever
    // read, refresh or disconnect - a slot gone with nothing to show for it.
    // Storing it means the read can simply be retried.
    await rememberPartialLink(env, exchange, accessToken, scope);
    throw new Error(
      `${(err && err.message) || "The first read failed"}. The bank is linked and ` +
      "has been saved, so press Refresh to try reading it again - re-linking would " +
      "consume another connection for nothing."
    );
  }

  // Computed before the persistence branch because the browser needs it either
  // way: it files the shares under this key, and if the link response omitted
  // it the page would fall back to slugging the display name - which is the
  // one thing that must never identify a connection, since a later refresh
  // reports the stable id and the two would not match.
  const key = connectionKey({ institutionId: result.institutionId, item_id: exchange.item_id });

  if (canPersist) {
    const items = await readItems(env);
    const record = {
      key,
      item_id: exchange.item_id || null,
      institutionId: result.institutionId || null,
      access_token: accessToken,
      institution: result.institution,
      // Which page linked this. A chequing account polled for holdings just
      // produces a permanent error on the dividend page, so the reader has to
      // know what each token is for. Absent means holdings: everything stored
      // before this existed was linked from the dividend page.
      scope: balances ? SCOPE_BALANCES : SCOPE_HOLDINGS,
      connectedAt: new Date().toISOString(),
    };

    // Replace only the SAME institution - re-linking Fidelity after a password
    // change should not leave two Fidelity tokens - and leave every other
    // institution alone, which is the entire point of storing a list.
    const existing = items.findIndex((it) => (it.key || connectionKey(it)) === record.key);
    if (existing >= 0) {
      const previous = items[existing];
      if (previous.access_token && previous.access_token !== accessToken) {
        // Otherwise the superseded Item stays subscribed and billable with its
        // token no longer known to us. Removed with the credentials that
        // created it, which need not be the ones linking the replacement.
        try {
          await plaid(env, "/item/remove", { access_token: previous.access_token },
            plaidCredsFor(env, previous));
        } catch { /* non-fatal: the new token is what matters */ }
      }
      items[existing] = record;
    } else {
      items.push(record);
    }
    await writeItems(env, items);
  } else {
    // No KV bound: keep the original one-off contract rather than silently
    // leaving a live token behind that nothing can ever remove.
    try {
      await plaid(env, "/item/remove", { access_token: accessToken }, scope);
    } catch { /* worst case, we just leave an orphan token with Plaid */ }
  }

  return {
    ...result,
    connections: [{ key, institution: result.institution, holdings: result.holdings }],
    persisted: canPersist,
  };
}

/**
 * Re-read every connected institution through its stored token.
 *
 * Returns one entry per institution rather than a merged map. Merging would
 * throw away which shares came from where, and the page files shares per
 * account precisely so that syncing Fidelity cannot disturb U.S. Bank.
 *
 * One institution failing does not fail the sync: a stale login at one
 * brokerage should not stop the others reporting.
 */
async function refreshHoldings(env) {
  if (!tokenStore(env)) {
    throw new Error(
      "No TOKENS KV namespace is bound, so no connection was stored. " +
        "Bind one in wrangler.toml to enable free unlimited refreshes."
    );
  }
  const items = await readItems(env);
  if (items.length === 0) {
    throw new Error("Not connected yet. Use \u201cSync from bank\u201d once first.");
  }

  // A chequing account linked from the balances page has no holdings, and
  // asking it for some yields a permanent, unfixable error on this page. It is
  // not a stale login, so it must not be reported as one.
  const holdingItems = items.filter((item) => item.scope !== SCOPE_BALANCES);
  if (holdingItems.length === 0) {
    throw new Error(
      "The only connections stored are bank accounts linked for balances. " +
        "Use \u201cAdd an institution\u201d to connect a brokerage."
    );
  }
  const connections = [];
  const errors = [];
  let mutated = false;
  for (const item of holdingItems) {
    try {
      const result = await fetchHoldings(env, item.access_token, plaidCredsFor(env, item));
      if (result.institution && result.institution !== item.institution) {
        item.institution = result.institution;
        mutated = true;
      }
      connections.push({
        key: item.key || connectionKey(item),
        institution: result.institution || item.institution || null,
        holdings: result.holdings,
        connectedAt: item.connectedAt || null,
      });
    } catch (err) {
      errors.push(`${item.institution || "A connection"}: ${(err && err.message) || "failed"}`);
    }
  }
  if (mutated) await writeItems(env, items);
  if (connections.length === 0) {
    throw new Error(errors.join("; ") || "No connection could be refreshed.");
  }

  return {
    connections,
    errors,
    // A single-institution view for older cached pages.
    holdings: connections.length === 1 ? connections[0].holdings : mergeHoldings(connections),
    institution: connections.map((c) => c.institution).filter(Boolean).join(" + ") || null,
    persisted: true,
    connectedAt: items[0].connectedAt || null,
  };
}

function mergeHoldings(connections) {
  const out = {};
  for (const conn of connections) {
    for (const [sym, qty] of Object.entries(conn.holdings || {})) {
      out[sym] = (out[sym] || 0) + qty;
    }
  }
  return out;
}

/**
 * Forget one institution, or all of them.
 *
 * Defaults to all so the button labelled "Disconnect bank" keeps meaning what
 * it says; pass a key to drop a single institution and keep the rest.
 */
async function disconnectItem(env, key) {
  const items = await readItems(env);
  const targets = key ? items.filter((it) => (it.key || connectionKey(it)) === key) : items;
  for (const item of targets) {
    // Ends the Investments subscription on a paid plan. Note this does NOT
    // return the consumed slot on a Trial plan - that quota is permanent.
    try {
      await plaid(env, "/item/remove", { access_token: item.access_token },
        plaidCredsFor(env, item));
    } catch { /* still forget it locally */ }
  }

  const remaining = key
    ? items.filter((it) => (it.key || connectionKey(it)) !== key)
    : [];
  if (remaining.length) await writeItems(env, remaining);
  else await clearStoredItems(env);

  return {
    connected: remaining.length > 0,
    removed: targets.length,
    remaining: remaining.map((it) => it.institution || null),
  };
}

/**
 * Cash balances across every linked institution.
 *
 * Separate from /holdings/refresh because it answers a different question and
 * reads a different endpoint. Holdings are share counts feeding a dividend
 * projection; this is "what is in my accounts right now", which for a chequing
 * account is the only thing there is to read.
 *
 * Uses the same stored Items - one link per institution serves both. A bank
 * with no investment accounts simply reports no holdings, and a brokerage with
 * no cash reports no balances; neither is an error.
 *
 * Reads /accounts/balance/get rather than /accounts/get. The latter returns a
 * balance cached at the last update, which for a page whose entire purpose is
 * showing current balances would be quietly wrong. On a Trial plan both are
 * free, so there is nothing to trade off.
 *
 * One institution failing does not fail the request: a stale login at one bank
 * must not blank the other three.
 */
async function readBalances(env) {
  if (!tokenStore(env)) {
    throw new Error(
      "No TOKENS KV namespace is bound, so no connection was stored. " +
        "Bind one in wrangler.toml first."
    );
  }
  const items = await readItems(env);
  if (items.length === 0) {
    return { institutions: [], errors: [], connected: false };
  }

  const settled = await Promise.all(items.map(async (item) => {
    const key = item.key || connectionKey(item);
    try {
      const payload = await plaid(env, "/accounts/balance/get", {
        access_token: item.access_token,
      }, plaidCredsFor(env, item));
      return {
        key,
        institution: item.institution || null,
        accounts: (payload.accounts || []).map(describeAccount),
        readAt: new Date().toISOString(),
      };
    } catch (err) {
      return { key, institution: item.institution || null, accounts: [], readAt: null,
        error: `${item.institution || "A connection"}: ${(err && err.message) || "failed"}` };
    }
  }));

  const errors = settled.filter((s) => s.error).map((s) => s.error);
  return {
    institutions: settled.map(({ error, ...rest }) => rest),
    errors,
    connected: true,
  };
}

/**
 * One account, reduced to what a balances page shows.
 *
 * `current` and `available` differ and both matter: a chequing account's
 * available balance excludes holds, so it is what you can actually spend, while
 * current includes them. Passing both through lets the page show the honest one
 * and explain the gap rather than silently picking.
 *
 * A credit card reports what is owed as a positive `current`, which is the
 * opposite sign convention to SnapTrade. Normalised here rather than on the
 * page, so the page never has to know which provider a number came from.
 */
function describeAccount(account) {
  const b = (account && account.balances) || {};
  const isCredit = account && (account.type === "credit" || account.type === "loan");
  const current = typeof b.current === "number" ? b.current : null;
  return {
    id: account.account_id,
    name: account.official_name || account.name || "Account",
    shortName: account.name || null,
    mask: account.mask || null,
    type: account.type || null,
    subtype: account.subtype || null,
    // Positive means "money you have"; negative means "money you owe", so a
    // total across mixed account types is meaningful rather than nonsense.
    current: current === null ? null : (isCredit ? -current : current),
    available: typeof b.available === "number"
      ? (isCredit ? -b.available : b.available) : null,
    limit: typeof b.limit === "number" ? b.limit : null,
    currency: b.iso_currency_code || b.unofficial_currency_code || null,
  };
}

/**
 * Store a connection whose first read failed.
 *
 * The Item exists and its Trial slot is already spent either way, so the only
 * question is whether anything can ever reach it again. Looks the institution
 * up separately because the call that would have reported it is the one that
 * just failed; an unnamed connection is still far better than a lost one.
 */
async function rememberPartialLink(env, exchange, accessToken, scope) {
  let institutionId = null;
  let institution = null;
  try {
    const item = await plaid(env, "/item/get", { access_token: accessToken }, scope);
    institutionId = (item && item.item && item.item.institution_id) || null;
    institution = await lookupInstitutionName(env, institutionId, scope);
  } catch { /* the point is to keep the token, not to label it */ }

  const record = {
    key: connectionKey({ institutionId, item_id: exchange.item_id }),
    item_id: exchange.item_id || null,
    institutionId,
    access_token: accessToken,
    institution,
    scope: scope === SCOPE_BALANCES ? SCOPE_BALANCES : SCOPE_HOLDINGS,
    connectedAt: new Date().toISOString(),
  };

  const items = await readItems(env);
  const existing = items.findIndex((it) => (it.key || connectionKey(it)) === record.key);
  if (existing >= 0) items[existing] = record;
  else items.push(record);
  await writeItems(env, items);
}

async function fetchHoldings(env, accessToken, scope) {
  const investments = await plaid(env, "/investments/holdings/get", {
    access_token: accessToken,
  }, scope);
  const { holdings, skipped } = aggregateHoldings(investments);

  // The id is what identifies the connection in storage; the name is only for
  // display, because Plaid re-words those and a re-wording must not fork the
  // stored connection into a second one holding the same shares.
  const institutionId = (investments.item && investments.item.institution_id) || null;
  const institutionName = await lookupInstitutionName(env, institutionId, scope);
  return { holdings, institution: institutionName, institutionId, skipped };
}

/**
 * The same identifying information as fetchHoldings, for a bank account.
 *
 * A chequing account has no holdings, so linking one from the balances page
 * cannot go through the investments product at all. This proves the token
 * works, and gets the institution name, without asking for anything a Canadian
 * retail bank does not have.
 */
async function fetchAccountSummary(env, accessToken, scope) {
  const payload = await plaid(env, "/accounts/get", { access_token: accessToken }, scope);
  const institutionId = (payload.item && payload.item.institution_id) || null;
  const institutionName = await lookupInstitutionName(env, institutionId, scope);
  return {
    holdings: {},
    institution: institutionName,
    institutionId,
    skipped: [],
    accounts: (payload.accounts || []).map(describeAccount),
  };
}

/**
 * Plaid's institution lookup is scoped by country, and a lookup that omits the
 * institution's own country returns nothing rather than erroring - so a
 * Canadian bank would simply show up unnamed. Both country lists are searched
 * because the two pages deliberately use different ones.
 */
async function lookupInstitutionName(env, institutionId, scope) {
  if (!institutionId) return null;
  const codes = [
    ...(env.PLAID_COUNTRY_CODES || "US").split(","),
    ...(env.PLAID_BALANCE_COUNTRY_CODES || "CA").split(","),
  ].map((s) => s.trim()).filter(Boolean);
  try {
    const inst = await plaid(env, "/institutions/get_by_id", {
      institution_id: institutionId,
      country_codes: [...new Set(codes)],
    }, scope);
    return (inst && inst.institution && inst.institution.name) || null;
  } catch {
    return null; // non-fatal: the connection still works, it is just unnamed
  }
}

/**
 * Sums holdings into {SYMBOL: shares}, counting only spendable accounts.
 *
 * Plaid returns holdings for every account behind the Item and tags each with
 * an account_id, so a 401(k) and a taxable brokerage arrive in one list. Summed
 * blindly, a Roth IRA's shares inflate the projected income by money that
 * cannot actually be spent when it lands.
 *
 * An account_id with no matching account entry is kept: the holding is real,
 * and dropping it because the metadata is missing would lose shares silently.
 */
function aggregateHoldings(investments) {
  const byId = new Map();
  for (const s of (investments.securities || [])) {
    byId.set(s.security_id, s);
  }

  const excluded = new Set();
  const skipped = [];
  for (const a of (investments.accounts || [])) {
    const kind = classifyAccount({ category: a.type, type: a.subtype, name: a.name });
    if (kind !== "spendable") {
      excluded.add(a.account_id);
      skipped.push({ name: a.name || a.official_name || "an account", kind });
    }
  }

  const out = {};
  for (const h of (investments.holdings || [])) {
    if (excluded.has(h.account_id)) continue;
    const sec = byId.get(h.security_id);
    if (!sec) continue;
    const ticker = (sec.ticker_symbol || "").toUpperCase().trim();
    if (!ticker) continue;
    const qty = Number(h.quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    out[ticker] = (out[ticker] || 0) + qty;
  }
  return { holdings: out, skipped };
}

// Exported for unit testing; the Worker runtime only uses the default export.
// Only functions may be exported from a Worker entry module - the runtime
// treats named exports as entrypoints. Passphrase and origin helpers live in
// auth.js, which tests import directly.
export { aggregateHoldings, connectionKey, mergeHoldings, describeAccount, linkScope };
