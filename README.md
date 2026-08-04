# Dividend & Distribution Tracker

Static, mobile-friendly page that shows historical, announced, and projected
dividends & distributions for the tickers you configure — MSFT, FXAIX, FSKAX
out of the box. Deployed to GitHub Pages so it's reachable from your phone or
any personal machine, with **no** corporate-network dependency.

Optional: a Cloudflare Worker + Plaid Link lets you **federate your share
counts** from Fidelity, US Bank, or any Plaid-supported brokerage. Nothing
about your accounts is ever published — share counts live only in your
browser's localStorage.

## Features

- Historical dividends + capital-gain distributions (Yahoo Finance).
- Officially announced but unpaid dividends (Nasdaq API).
- Projected future dividends for anything not yet declared, tagged
  `status="projected"` with confidence + basis strings.
- Static output (`docs/data.json`) rebuilt daily via GitHub Actions.
- PWA: works offline once opened; installable on iOS/Android home screen.
- Optional Plaid federated sync → shares cached in localStorage, freshness pill
  interpolates **green → red over one quarter** (92 days) so you know when to
  refresh.
- CSV import fallback for anyone who doesn't want to run the worker.

## Repo layout

```
divtracker/          Python data pipeline (stdlib only)
config/              symbols.json + announced.json
docs/                static site (GitHub Pages root)
worker/              Cloudflare Worker for Plaid Link (optional)
tests/               unit tests
.github/workflows/   daily refresh + Pages deploy
build.py             `python build.py` entry point
```

## Running the pipeline locally

```powershell
python build.py --verbose
# writes docs\data.json
```

The pipeline uses only the Python standard library, so no `pip install` is
needed on a clean CI runner.

## Deploying the public page (GitHub Pages)

1. Create a public GitHub repo, push this tree to it.
2. In Settings → Pages, set "Source" to "GitHub Actions".
3. The included workflow (`.github/workflows/build.yml`) runs `build.py` daily
   at 12:15 UTC, commits any updated `docs/data.json`, and publishes.
4. Once green, your page is at
   `https://<you>.github.io/<repo>/` — bookmark it on your phone.

## Optional: federated sync from Fidelity / US Bank via Plaid

Because a static site cannot hold API secrets, holdings sync uses a small
Cloudflare Worker. The Worker exchanges the Plaid `public_token`, calls
`/investments/holdings/get`, aggregates `{symbol: shares}`, and stores the
access token in Cloudflare KV so later syncs reuse it. The browser only ever
sees the share counts — never the Plaid token.

### Why the token is stored (and why it must be)

Plaid's free **Trial plan** has no expiry date, includes Investments, and allows
**10 Production Items for the lifetime of the account**. Crucially, removing an
Item does *not* give the slot back:

> Removing Items created on a Trial plan (using `/item/remove`) will **not**
> allow you to create more Items.
> — <https://plaid.com/docs/account/billing/>

So a connect → read → remove cycle burns one of the ten slots on *every* sync
and dies permanently on the eleventh. Linking once and refreshing through the
stored token keeps this free indefinitely.

Note the tradeoff inverts on a paid plan: Investments is a **subscription-fee**
product billed monthly for as long as a valid access token exists, so there
`/item/remove` saves money. Use **Disconnect bank** if you upgrade and want
billing to stop.

### A stored token requires a passphrase

With no stored token, producing holdings required completing Plaid Link with
your own bank credentials, so an `Origin` check was enough. Once a token is
stored, `/holdings/refresh` would hand real positions to any caller — and the
`Origin` header is trivially forged outside a browser (`curl -H "Origin: ..."`),
while this site is public, so the Worker URL is public too.

Every sensitive endpoint therefore requires `SYNC_PASSPHRASE`, sent as the
`X-Sync-Key` header and compared in constant time. It **fails closed**: if the
secret is unset, every request is rejected rather than allowed.

### 1. Register a Plaid app

- Sign up at <https://dashboard.plaid.com>.
- Enable the **Investments** product.
- Apply for the free [Trial plan](https://dashboard.plaid.com/trial-plan)
  (US/CA, teams created on or after 2026-04-15) to use real data at no cost.
- In "Team Settings → Allowed redirect URIs", add
  `https://<you>.github.io/<repo>/` (only if using OAuth institutions like
  Fidelity's flow that requires a redirect).
- Grab `client_id` + the secret for your chosen environment
  (`sandbox`, `development`, or `production`). Sandbox is free with fake
  credentials; production requires Plaid approval for individuals.

> **Fidelity / Charles Schwab:** Plaid calls these out as needing explicit
> institution access approval once you move to a paid plan. Trial covers "most
> OAuth institutions" but not guaranteed. Confirm your broker actually links
> before relying on this path.

### 2. Deploy the Worker

```powershell
cd worker
npm install
npx wrangler login

# Storage for the Plaid access token, so syncing never burns a Trial slot.
npx wrangler kv namespace create TOKENS
# Paste the printed id into worker/wrangler.toml and uncomment the
# [[kv_namespaces]] block, then continue:

npx wrangler secret put PLAID_CLIENT_ID       # paste your client_id
npx wrangler secret put PLAID_SECRET          # paste the secret for the env you use
npx wrangler secret put PLAID_ENV             # sandbox | development | production
npx wrangler secret put ALLOWED_ORIGINS       # https://<you>.github.io  (comma-separate to add more)
npx wrangler secret put SYNC_PASSPHRASE       # long random string; required
npx wrangler deploy
```

Generate a passphrase with:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

If you skip the KV namespace the Worker still runs, but falls back to the old
one-off remove-after-read behaviour — which is capped at 10 syncs forever on a
Trial plan.

Wrangler will print the Worker URL, e.g. `https://divtracker-plaid.<you>.workers.dev`.

### 3. Point the page at the Worker

Edit `docs/config.js`:

```js
window.DIVTRACKER_CONFIG = {
  WORKER_BASE: "https://divtracker-plaid.<you>.workers.dev",
  QUARTER_DAYS: 92,
};
```

Commit; the workflow republishes. The "Sync from bank" button now appears in
the **Your holdings** panel. The first click prompts for your passphrase (kept
in localStorage) and opens Plaid Link to sign in to Fidelity or US Bank. Every
click after that reuses the saved connection — no bank sign-in, no new Plaid
Item, no cost. **Disconnect bank** removes the stored token.

### Worker endpoints

| Endpoint | Purpose | Creates a Plaid Item? |
| --- | --- | --- |
| `POST /status` | Is a connection stored? | No |
| `POST /link/token/create` | Start Plaid Link | No |
| `POST /link/token/exchange` | Finish Link, store token, read holdings | **Yes** |
| `POST /holdings/refresh` | Re-read holdings via stored token | No |
| `POST /item/disconnect` | `/item/remove` + forget the token | No |

All of the above require `X-Sync-Key`. Only `/` and `/health` are unauthenticated.

### Freshness pill

The pill next to "Last updated" starts at day 0 = green
(`hsl(120,60%,42%)`), and interpolates through amber to red
(`hsl(0,78%,36%)`) at 92 days. That's one quarter — the natural cadence of the
dividends in this tracker — so a red pill means it's plausible your share count
is now stale.

## Adding more tickers

Edit `config/symbols.json`:

```json
{
  "symbols": [
    { "symbol": "AAPL", "name": "Apple Inc.", "kind": "equity", "expected_cadence": "quarterly" }
  ]
}
```

`kind` is either `equity` (uses Nasdaq for announced-but-unpaid dividends) or
`fund` (Yahoo history only; manual announcements go in `config/announced.json`).

## Testing

```powershell
python -m unittest discover -s tests -v     # projection engine + pipeline
node --test tests/csv.test.cjs              # brokerage CSV import
node --test tests/worker.test.mjs           # Plaid worker origin checks + aggregation
```

There is also an end-to-end smoke test that loads the real page in headless Edge
and asserts the table, filters and dollar maths:

```powershell
cd docs; Start-Process python -ArgumentList '-m','http.server','8765'
cd ..; node tests\smoke.cjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
```

## Privacy

- Share counts, sync source, and last-synced timestamp are stored **only** in
  your browser's localStorage (`divtracker.*.v1` keys). Use "Clear" in the
  Your holdings panel to wipe them.
- The Cloudflare Worker stores one Plaid access token in your own Cloudflare KV
  so repeat syncs stay free. It is never sent to the browser, every endpoint
  that can read it requires `SYNC_PASSPHRASE`, and **Disconnect bank** deletes
  it. Skip the KV binding to keep the older token-less behaviour instead.
- The public GitHub Pages site contains only per-share amounts — no
  account-linkable data.
