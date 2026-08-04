# Dividend & Distribution Tracker

Static, mobile-friendly page that shows historical, announced, and projected
dividends & distributions for the tickers you configure — MSFT, FXAIX, FSKAX
out of the box. Deployed to GitHub Pages so it's reachable from your phone or
any personal machine, with **no** corporate-network dependency.

Optional: a Cloudflare Worker + Plaid Link lets you do a **one-off federated
sync** of your share counts from Fidelity, US Bank, or any Plaid-supported
brokerage. Nothing about your accounts is ever published — share counts live
only in your browser's localStorage.

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
Cloudflare Worker. The Worker never persists tokens — it exchanges the Plaid
`public_token`, calls `/investments/holdings/get`, aggregates
`{symbol: shares}`, then calls `/item/remove` to discard the access token
before responding. The browser only ever sees the share counts.

### 1. Register a Plaid app

- Sign up at <https://dashboard.plaid.com>.
- Enable the **Investments** product.
- In "Team Settings → Allowed redirect URIs", add
  `https://<you>.github.io/<repo>/` (only if using OAuth institutions like
  Fidelity's flow that requires a redirect).
- Grab `client_id` + the secret for your chosen environment
  (`sandbox`, `development`, or `production`). Sandbox is free with fake
  credentials; production requires Plaid approval for individuals.

### 2. Deploy the Worker

```powershell
cd worker
npm install
npx wrangler login
npx wrangler secret put PLAID_CLIENT_ID       # paste your client_id
npx wrangler secret put PLAID_SECRET          # paste the secret for the env you use
npx wrangler secret put PLAID_ENV             # sandbox | development | production
npx wrangler secret put ALLOWED_ORIGINS       # https://<you>.github.io  (comma-separate to add more)
npx wrangler deploy
```

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
the **Your holdings** panel. Click it → Plaid Link opens → sign in to Fidelity
or US Bank → the page caches your shares and shows a fresh, green pill.

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
- The Cloudflare Worker never persists Plaid tokens; each sync is one-off.
- The public GitHub Pages site contains only per-share amounts — no
  account-linkable data.
