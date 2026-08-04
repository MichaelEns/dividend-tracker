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
 *     that to the browser. The access_token is used only within this request
 *     and is intentionally NOT persisted or returned - the sync is one-off.
 *
 * Secrets are read from Worker env at request time. Configure via wrangler:
 *   wrangler secret put PLAID_CLIENT_ID
 *   wrangler secret put PLAID_SECRET
 *   wrangler secret put PLAID_ENV           (sandbox | development | production)
 *   wrangler secret put ALLOWED_ORIGINS     (https://<you>.github.io, ...)
 */

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

      if (url.pathname === "/link/token/create" && request.method === "POST") {
        return json(await createLinkToken(env), 200, cors);
      }
      if (url.pathname === "/link/token/exchange" && request.method === "POST") {
        const body = await safeJson(request);
        const publicToken = body && body.public_token;
        if (!publicToken) return json({ error: "missing public_token" }, 400, cors);
        return json(await exchangeAndFetch(env, publicToken), 200, cors);
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
    "Access-Control-Allow-Headers": "Content-Type",
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
  // A per-user id is required by Plaid but has no meaning here because we
  // never store the access_token; a random one per session is fine.
  const clientUserId = crypto.randomUUID();
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

  let institutionName = null;
  let holdings = {};
  try {
    const investments = await plaid(env, "/investments/holdings/get", {
      access_token: accessToken,
    });
    holdings = aggregateHoldings(investments);

    // Best-effort institution lookup for UI display.
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
  } finally {
    // "One-off" contract: destroy the access token before responding.
    try {
      await plaid(env, "/item/remove", { access_token: accessToken });
    } catch { /* worst case, we just leave an orphan token with Plaid */ }
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
export { aggregateHoldings, originAllowed };
