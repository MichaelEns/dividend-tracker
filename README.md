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
- Distributions colour-coded by quarter, and a table that folds to three
  columns in portrait so dates and dollar amounts stay side by side.
- Staleness warnings that call out a stalled daily build or stale share counts,
  because a broken build renders identically to a healthy one.

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

## Reading the table

### Quarter colour bands

Each row is striped and labelled by the calendar quarter of its **ex-date**.
Ex-date rather than pay date for two reasons: it is how dividends are
conventionally named (*"the Q1 dividend"*), and it is the column the table sorts
by — keying off the pay date would scatter the bands, because a late-March
ex-date often pays in April and would land in a different quarter from the rows
it sits between.

Hues run cool → warm through the year (Q1 blue, Q2 green, Q3 gold, Q4 rust) so
the sequence reads as time passing rather than as four unrelated states. The
same quarter in different years shares a hue by design; the label carries the
year, and the key is `YYYY-Qn` so consecutive years never merge into one band.

The label appears once at the top of each run rather than on every row, which
would be noisy — the fixture data averages about two and a half rows per
quarter. Rows further down the run still carry the label in a visually-hidden
span, so **colour is never the only cue**: a screen reader announces the quarter
on every row, and anyone who can't distinguish the hues still gets the text.

### Portrait layout

Seven columns do not fit on a phone. The old behaviour was a horizontally
scrolling table, which meant you could never see a payment's date and its dollar
amount at the same time — the two things you actually want to compare.

Under 560px the table folds to three columns — **Symbol · Ex-date · Your
amount** — and the rest is folded into those cells rather than dropped:

| Hidden column | Where it goes |
| ------------- | ------------- |
| Pay date      | *"pays Sep 10"* under the ex-date (year omitted; the ex-date above supplies it) |
| Per share     | *"$0.9100 × 100 sh"* under the amount |
| Shares        | same line as per share |
| Status        | a small pill inline beside the symbol |

Two non-obvious details:

- **`display: none` really removes a cell from its row**, so the footer's
  `colspan` has to shrink to match. Left at 5 it forces the table to keep six
  columns and the whole thing scrolls sideways again — which defeats the point.
  `colspan` is an HTML attribute that CSS cannot touch, so `renderTable` reads
  the breakpoint via `matchMedia` and re-renders when it is crossed.
- **Without share counts the dollar column is all em dashes.** In portrait the
  per-share column is gone, so the folded cell falls back to showing the
  per-share rate instead of an empty-looking dash.

### Freshness pill

The pill next to "Last updated" starts at day 0 = green
(`hsl(120,60%,42%)`), and interpolates through amber to red
(`hsl(0,78%,36%)`) at 92 days. That's one quarter — the natural cadence of the
dividends in this tracker — so a red pill means it's plausible your share count
is now stale.

### Staleness warnings
The pill above answers "how old are my share counts?" It does not cover the
failure that actually misleads you: **`data.json` going stale**.

Share counts are typed in by hand, so their age is self-evident. `data.json` is
rebuilt by a scheduled GitHub Action, so when that breaks — an expired token, a
Yahoo schema change, a workflow error — the page keeps rendering confident,
plausible, wrong numbers with no visible difference. Prices and "next payment"
dates simply stop advancing. A silent failure deserves a loud warning, so a
banner appears above the summary cards when anything is overdue.

Staleness is judged as a **ratio of age to the cadence that source is expected
to keep**, not as an absolute age. That lets one classifier cover both an
hour-scale source and a quarter-scale one:

| Ratio (age ÷ expected cadence) | Level      | Shown? |
| ------------------------------ | ---------- | ------ |
| < 0.5                          | `fresh`    | no     |
| 0.5 – 1                        | `aging`    | no     |
| 1 – 3                          | `stale`    | amber  |
| ≥ 3                            | `critical` | red    |
| no timestamp / unparseable     | `broken`   | red    |

Expected cadences: `data.json` = 24 h (the workflow's daily cron); holdings =
92 days (one dividend quarter). So a three-day-old build is `critical` while
three-day-old share counts are still `fresh` — the same age, correctly judged
differently.

Two details worth knowing:

- **Future timestamps are clamped to zero age**, not treated as extremely
  fresh. Clock skew between your device and the build runner shouldn't be able
  to suppress a warning.
- **A failed `data.json` fetch still renders the banner.** That is precisely
  when it matters most, because the service worker may serve an old cached copy
  that looks perfectly normal.

A `generatedAt` that is *present but unreadable* is reported as `broken`, not
treated as missing. A missing timestamp and an unparseable one are easy to
conflate in code, and conflating them means a format change in `build.py` would
render as perfectly healthy — the exact failure this feature exists to catch.

Share counts are judged on the **most recent** sync source, not each source
individually. `docs/app.js` merges every source into one flat symbol → shares
map, so there is no per-institution partition to age separately; warning about a
CSV imported once in March would be a permanent false positive when the numbers
on screen were typed in an hour ago. Every source is still recorded in
`divtracker.syncSources.v1` so the banner can name which one, and the legacy
single-source `divtracker.syncMeta.v1` is migrated in on first load and never
moved backwards in time.

The clock is read on every render, and the banner re-renders when a hidden tab
becomes visible again — an installed PWA is resumed far more often than it is
loaded, so a load-time verdict would go stale along with the data.

## Alternative sync provider: SnapTrade

SnapTrade is supported alongside Plaid. Configure either, or both.

**It is not more reliable at the brokerage boundary.** Both Plaid and SnapTrade
reach Fidelity through **Fidelity Access**, Fidelity's own OAuth consent
program — SnapTrade's connect flow literally includes *"Agree to the Fidelity
Access User Agreement."* Consent still expires (~12 months is the industry
norm) and still breaks on password or MFA changes, whichever you use.

What differs is the terms:

| | Plaid Trial | SnapTrade Personal |
| --- | --- | --- |
| Cost | Free | Free |
| Hard limit | **10 Items, lifetime, non-refundable** | ~20 connections |
| Built for | Banks; investments is a secondary product | Brokerages |
| Token to store | Yes — an access token per Item | **None** |

The last row is why the SnapTrade path is simpler: a Personal API key
identifies the user, so there is no per-connection token for the worker to
hold, no KV namespace, and nothing to disconnect.

```powershell
cd worker
npx wrangler secret put SNAPTRADE_CLIENT_ID      # Personal client ID
npx wrangler secret put SNAPTRADE_CONSUMER_KEY   # Personal consumer key
npx wrangler deploy
```

Get both from <https://snaptrade.com/personal> → Dashboard. A **Sync via
SnapTrade** button then appears; the first click opens SnapTrade's Connection
Portal in a new tab, and after linking your brokerage you press it again.

Requests are signed per
[SnapTrade's spec](https://docs.snaptrade.com/docs/request-signatures):
HMAC-SHA256 over canonical JSON (`{content, path, query}`, keys sorted, no
whitespace), base64, in a `Signature` header. `tests/snaptrade.test.mjs`
verifies this against Node's own HMAC implementation.

### Dead ends, so you don't chase them

- **OFX Direct Connect** (`ofx.fidelity.com`) — the classic no-third-party
  route. Fidelity **shut it off in December 2025**.
- **Akoya** — the most direct rail, and ironically spun out of Fidelity's own
  parent. B2B only: requires a company and signed data-access agreements.

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
node --test tests/worker.test.mjs           # Plaid worker auth + origin checks + aggregation
node --test tests/snaptrade.test.mjs        # SnapTrade request signing + position parsing
node --test tests/freshness.test.cjs       # staleness classification + syncMeta migration
node --test tests/quarters.test.cjs        # quarter bucketing for the colour bands
```

There is also an end-to-end smoke test that loads the real page in headless Edge
and asserts the table, filters, dollar maths, the staleness banner, the quarter
colour bands and the portrait layout:

```powershell
cd docs; Start-Process python -ArgumentList '-m','http.server','8765'
cd ..; node tests\smoke.cjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
```

## Privacy

- Share counts, sync source, per-source freshness records, and last-synced
  timestamp are stored **only** in your browser's localStorage
  (`divtracker.*.v1` keys). Use "Clear" in the Your holdings panel to wipe them.
- The Cloudflare Worker stores one Plaid access token in your own Cloudflare KV
  so repeat syncs stay free. It is never sent to the browser, every endpoint
  that can read it requires `SYNC_PASSPHRASE`, and **Disconnect bank** deletes
  it. Skip the KV binding to keep the older token-less behaviour instead.
- The public GitHub Pages site contains only per-share amounts — no
  account-linkable data.
