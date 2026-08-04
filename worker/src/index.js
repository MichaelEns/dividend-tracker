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
 */

const TOKEN_KEY = "plaid:item:default";

const PLAID_HOSTS = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

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
        return json(await createLinkToken(env), 200, cors);
      }
      if (url.pathname === "/link/token/exchange" && request.method === "POST") {
        const body = await safeJson(request);
        const publicToken = body && body.public_token;
        if (!publicToken) return json({ error: "missing public_token" }, 400, cors);
        return json(await exchangeAndFetch(env, publicToken), 200, cors);
      }
      if (url.pathname === "/holdings/refresh" && request.method === "POST") {
        return json(await refreshHoldings(env), 200, cors);
      }
      if (url.pathname === "/item/disconnect" && request.method === "POST") {
        return json(await disconnectItem(env), 200, cors);
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

/**
 * Fail closed.
 *
 * An unset ALLOWED_ORIGINS must not mean "allow everything": this worker mints
 * Plaid Link tokens against a real (billable) Plaid account and drives bank
 * sign-in flows, so an open worker is abusable by any other site. Requests are
 * only permitted from an explicitly configured origin.
 */
function originAllowed(origin, env) {
  if (!origin) return false;
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(String(origin).trim().replace(/\/+$/, ""));
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

/**
 * Constant-time string comparison.
 *
 * A plain === leaks how many leading characters matched via its return time,
 * which lets an attacker recover the passphrase one character at a time. This
 * always inspects every byte of the expected value.
 */
function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a == null ? "" : a));
  const y = new TextEncoder().encode(String(b == null ? "" : b));
  // Length is not itself secret, but bail without a short-circuit on content.
  let diff = x.length ^ y.length;
  for (let i = 0; i < y.length; i += 1) {
    diff |= (x[i % (x.length || 1)] || 0) ^ y[i];
  }
  return diff === 0;
}

/**
 * Fail closed, exactly like originAllowed.
 *
 * An unset SYNC_PASSPHRASE must not mean "no auth required", or a deployment
 * that simply forgot the secret would publish its holdings to the internet.
 */
function authorized(presented, env) {
  const expected = String(env.SYNC_PASSPHRASE || "");
  if (!expected) return false;
  if (!presented) return false;
  return timingSafeEqual(presented, expected);
}

function tokenStore(env) {
  return env.TOKENS || null;
}

async function readStoredItem(env) {
  const kv = tokenStore(env);
  if (!kv) return null;
  try {
    const raw = await kv.get(TOKEN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeStoredItem(env, record) {
  const kv = tokenStore(env);
  if (!kv) return false;
  await kv.put(TOKEN_KEY, JSON.stringify(record));
  return true;
}

async function clearStoredItem(env) {
  const kv = tokenStore(env);
  if (!kv) return;
  try { await kv.delete(TOKEN_KEY); } catch { /* non-fatal */ }
}

async function readStatus(env) {
  const stored = await readStoredItem(env);
  return {
    connected: Boolean(stored && stored.access_token),
    institution: (stored && stored.institution) || null,
    connectedAt: (stored && stored.connectedAt) || null,
    persistence: tokenStore(env) ? "kv" : "none",
  };
}
async function safeJson(req) {
  try { return await req.json(); } catch { return null; }
}

function plaidBase(env) {
  return PLAID_HOSTS[(env.PLAID_ENV || "production").toLowerCase()] || PLAID_HOSTS.production;
}

async function plaid(env, path, body) {
  const resp = await fetch(`${plaidBase(env)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
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

async function createLinkToken(env) {
  // A per-user id is required by Plaid. Keep it stable across re-links so the
  // same end user is not counted as a brand new one on every connect.
  const clientUserId = "divtracker-owner";
  const products = (env.PLAID_PRODUCTS || "investments")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const countryCodes = (env.PLAID_COUNTRY_CODES || "US")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const payload = await plaid(env, "/link/token/create", {
    user: { client_user_id: clientUserId },
    client_name: env.PLAID_CLIENT_NAME || "Dividend Tracker",
    products,
    country_codes: countryCodes,
    language: "en",
  });
  return { link_token: payload.link_token };
}

async function exchangeAndFetch(env, publicToken) {
  const exchange = await plaid(env, "/item/public_token/exchange", {
    public_token: publicToken,
  });
  const accessToken = exchange.access_token;
  if (!accessToken) throw new Error("Plaid returned no access_token.");

  const canPersist = Boolean(tokenStore(env));

  // A previously linked Item would otherwise be orphaned: still subscribed and
  // still billable on a paid plan, with its token no longer known to us.
  if (canPersist) {
    const previous = await readStoredItem(env);
    if (previous && previous.access_token && previous.access_token !== accessToken) {
      try {
        await plaid(env, "/item/remove", { access_token: previous.access_token });
      } catch { /* non-fatal: the new token is what matters */ }
    }
  }

  let result;
  try {
    result = await fetchHoldings(env, accessToken);
  } catch (err) {
    // Never keep a token we could not actually use.
    if (!canPersist) {
      try { await plaid(env, "/item/remove", { access_token: accessToken }); } catch { /* ignore */ }
    }
    throw err;
  }

  if (canPersist) {
    await writeStoredItem(env, {
      access_token: accessToken,
      institution: result.institution,
      connectedAt: new Date().toISOString(),
    });
  } else {
    // No KV bound: keep the original one-off contract rather than silently
    // leaving a live token behind that nothing can ever remove.
    try {
      await plaid(env, "/item/remove", { access_token: accessToken });
    } catch { /* worst case, we just leave an orphan token with Plaid */ }
  }

  return { ...result, persisted: canPersist };
}

async function refreshHoldings(env) {
  if (!tokenStore(env)) {
    throw new Error(
      "No TOKENS KV namespace is bound, so no connection was stored. " +
        "Bind one in wrangler.toml to enable free unlimited refreshes."
    );
  }
  const stored = await readStoredItem(env);
  if (!stored || !stored.access_token) {
    throw new Error("Not connected yet. Use \u201cSync from bank\u201d once first.");
  }
  const result = await fetchHoldings(env, stored.access_token);
  if (result.institution && result.institution !== stored.institution) {
    await writeStoredItem(env, { ...stored, institution: result.institution });
  }
  return { ...result, persisted: true, connectedAt: stored.connectedAt || null };
}

async function disconnectItem(env) {
  const stored = await readStoredItem(env);
  if (stored && stored.access_token) {
    // Ends the Investments subscription on a paid plan. Note this does NOT
    // return the consumed slot on a Trial plan - that quota is permanent.
    try {
      await plaid(env, "/item/remove", { access_token: stored.access_token });
    } catch { /* still forget it locally */ }
  }
  await clearStoredItem(env);
  return { connected: false, removed: Boolean(stored && stored.access_token) };
}

async function fetchHoldings(env, accessToken) {
  const investments = await plaid(env, "/investments/holdings/get", {
    access_token: accessToken,
  });
  const holdings = aggregateHoldings(investments);

  // Best-effort institution lookup for UI display.
  let institutionName = null;
  if (investments.item && investments.item.institution_id) {
    try {
      const inst = await plaid(env, "/institutions/get_by_id", {
        institution_id: investments.item.institution_id,
        country_codes: (env.PLAID_COUNTRY_CODES || "US").split(",").map((s) => s.trim()),
      });
      if (inst && inst.institution && inst.institution.name) {
        institutionName = inst.institution.name;
      }
    } catch { /* non-fatal */ }
  }
  return { holdings, institution: institutionName };
}

function aggregateHoldings(investments) {
  const byId = new Map();
  for (const s of (investments.securities || [])) {
    byId.set(s.security_id, s);
  }
  const out = {};
  for (const h of (investments.holdings || [])) {
    const sec = byId.get(h.security_id);
    if (!sec) continue;
    const ticker = (sec.ticker_symbol || "").toUpperCase().trim();
    if (!ticker) continue;
    const qty = Number(h.quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    out[ticker] = (out[ticker] || 0) + qty;
  }
  return out;
}

// Exported for unit testing; the Worker runtime only uses the default export.
export { aggregateHoldings, originAllowed, authorized, timingSafeEqual };
