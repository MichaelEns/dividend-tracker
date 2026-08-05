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
- **A pay date on every row** — from Nasdaq for equities, estimated as the next
  business day after the ex-date for funds, which no free feed covers. The
  table, the portrait fold and the "Next payment" card all lead with it, because
  the ex-date says which dividend you qualified for and the pay date says when
  the money arrives.
- Static output (`docs/data.json`) rebuilt daily via GitHub Actions.
- PWA: works offline once opened; installable on iOS/Android home screen.
- **Refreshes itself** — rates on every open, resume and pull; share counts on
  every pull and on open/resume once six hours old. See
  [Refreshing without pressing Sync](#refreshing-without-pressing-sync).
- Federated share counts via **SnapTrade** (free Personal tier, covers Fidelity,
  Robinhood, U.S. Bank) or Plaid. Nothing is published — counts live only in
  your browser's localStorage.
- **Only spendable accounts count** by default: dividends inside a 401(k), IRA,
  Roth or HSA are reinvested behind a tax wrapper and never reach a spendable
  balance. A checkbox includes them as separate accounts.
- CSV import fallback for anyone who doesn't want to run the worker.
- Per-account share counts, so a fund split between two institutions is tracked
  properly and syncing one can't wipe the other — see
  [Holdings across several institutions](#holdings-across-several-institutions).
- Distributions colour-coded by quarter, and a table that folds to three
  columns in portrait so dates and dollar amounts stay side by side.
- Staleness warnings that call out a stalled daily build or stale share counts,
  because a broken build renders identically to a healthy one.
- **A separate bank balances page** for Canadian chequing, savings and card
  balances (TD, Scotiabank, RBC, Meridian) — see
  [Bank balances](#bank-balances-a-separate-page).

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

### Where each date comes from

| Field | Source |
| --- | --- |
| Ex-date, amount (history) | Yahoo Finance |
| Ex-date, amount (declared) | Nasdaq, plus `config/announced.json` |
| **Pay date** (equities) | Nasdaq |
| **Pay date** (funds) | estimated — next business day after the ex-date |

Yahoo's dividend history carries an ex-date and an amount and nothing else, so
every paid row arrives with no pay date. Nasdaq publishes pay dates for the
same dividends, going back over a decade, and the pipeline was already
fetching them: `fetch_nasdaq_declared` requested the full table and then
discarded every row whose ex-date had passed, on the grounds that Yahoo is the
authority for historical *amounts*. It is not the authority for pay dates,
because it has none. Those rows are now kept for their pay dates alone and
merged onto the matching ex-date, which took MSFT from 12 of 60 rows carrying a
pay date to 60 of 60.

Only blanks are filled: a pay date already present came from a source naming
that specific dividend, which beats a lookup. This also feeds `_pay_lag`, so
projected dividends inherit a lag measured over years of real history instead
of over whatever single announcement happened to be in flight.

Mutual funds get nothing from either feed, so theirs are **estimated as the next
business day after the ex-date**. Fidelity pays its index funds on that
schedule, and that regularity is what makes an estimate defensible here and not
for an equity, where the gap is about three weeks and varies. Estimates carry a
`pay_date_estimated` flag and the fund says so in its notes; a `pay_date` in
`config/announced.json` always beats the estimate.

Weekends are skipped, US market holidays are not. A holiday pushes a payment one
further day, and carrying a holiday calendar to shave a day off an approximation
is more machinery than the accuracy is worth.

The same weekend rule now applies to *projected* equity pay dates. A projected
ex-date plus a median 23-day lag lands wherever the arithmetic puts it, which
had put four MSFT projections on a Saturday. That was invisible while the table
led with the ex-date and became wrong on screen the moment the pay date was
promoted to the prominent line.

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

> **Sandbox credentials never return your real holdings.** Plaid's Sandbox is a
> closed set of fake institutions — First Platypus Bank, Tartan Bank — reached
> with `user_good` / `pass_good`. It cannot reach Fidelity or any other real
> bank, by design, no matter what you type. A sandbox sync returns holdings
> like `ACHN`, `EWZ` and `BTC`, so the page will correctly report that nothing
> it tracks came back. That is the plumbing working, not failing. Sandbox is
> for proving the wiring; only `PLAID_ENV=production` with a production secret
> touches real money.

> **Fidelity via Plaid is doubtful.** Plaid's own docs say Pay-as-you-go
> customers must request Fidelity access by support ticket, and several
> third-party reports say the integration is no longer available at all. This
> could not be confirmed either way from public sources. If Fidelity is the
> reason you are here, prefer SnapTrade — see
> [Alternative sync provider](#alternative-sync-provider-snaptrade) — which
> connects to both Fidelity and U.S. Bank over Fidelity Access OAuth, is free
> for personal use, and issues API keys immediately with no approval queue.

### 2. Deploy the Worker

```powershell
cd worker
npm install
node setup.mjs
```

`setup.mjs` logs in, creates the KV namespace and writes its id into
`wrangler.toml`, uploads every secret, deploys, and prints the URL to paste
into `docs/config.js`. It reuses anything already in `.dev.vars`, so the values
you tested locally are the ones that get deployed.

**Signing in from a phone.** `wrangler login` redirects to
`http://localhost:8976`, a listener that only exists on the machine running
wrangler, so the browser completing it must be that machine. To authenticate
from a phone instead, create an API token — no callback, so any device works:
dash.cloudflare.com → My Profile → API Tokens → Create Token → **Edit
Cloudflare Workers** template (it covers Workers Scripts *and* Workers KV).
Then:

```powershell
$env:CLOUDFLARE_API_TOKEN = "<token>"
node setup.mjs
```

<details>
<summary>The same thing by hand</summary>

```powershell
npx wrangler login
npx wrangler kv namespace create TOKENS
# paste the printed id into wrangler.toml, uncomment [[kv_namespaces]], then:
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
npx wrangler secret put PLAID_ENV             # sandbox | production
npx wrangler secret put ALLOWED_ORIGINS       # https://<you>.github.io
npx wrangler secret put SYNC_PASSPHRASE       # long random string; required
npx wrangler deploy
```

Generate a passphrase with
`python -c "import secrets; print(secrets.token_urlsafe(32))"`.
</details>

If you skip the KV namespace the Worker still runs, but falls back to the old
one-off remove-after-read behaviour — which is capped at 10 syncs forever on a
Trial plan.

Wrangler prints the Worker URL, e.g. `https://divtracker-plaid.<you>.workers.dev`.

#### Testing it without deploying

`.dev.vars` (gitignored) holds the same keys for local runs:

```powershell
cd worker
npx wrangler dev --port 8787 --local
```

### The sync passphrase

The worker is on a public URL, so every endpoint that can disclose holdings
requires a shared passphrase, compared in constant time. It may be a sentence
rather than a random string, because both sides fold it before comparing:
everything that is not a letter or a digit is dropped and the rest is
lowercased. `It's a lovely day, isn't it?` and
`itsalovelydayisntit` are the same passphrase.

That is not cosmetic. iOS autocorrects a straight apostrophe into a curly one
(U+2019), so the same sentence typed on a phone and on a laptop is not the same
string — and worse, **an HTTP header value is a byte string**, so `fetch`
throws outright on any character above U+00FF. Sending the raw phrase failed in
the browser before the request was even made, with an error about ByteStrings
that mentioned nothing about passphrases. Folding on the page makes the header
ASCII by construction; folding again on the worker means the stored secret may
be spelled differently from what is typed.

The two implementations — `worker/src/auth.js` and `docs/app.js` — must agree
exactly, or every sync returns 401 with no clue why. `tests/worker.test.mjs`
asserts that they do, rather than trusting it.

Folding costs a little entropy, so a normalised passphrase shorter than eight
characters is refused outright. The check runs *after* folding: `...` folds to
the empty string, and so would any punctuation a caller sends, which without a
floor would authorise everyone.

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
| `POST /link/token/create` | Start Plaid Link (`{ scope }`) | No |
| `POST /link/token/exchange` | Finish Link, store token, read holdings | **Yes** |
| `POST /holdings/refresh` | Re-read holdings via stored token | No |
| `POST /balances` | Read every account balance via stored tokens | No |
| `POST /item/disconnect` | `/item/remove` + forget the token | No |

`scope` is `"holdings"` (the default) or `"balances"` — see
[Why a link has a scope](#why-a-link-has-a-scope). Both link endpoints take it,
and they must agree.

All of the above require `X-Sync-Key`. Only `/` and `/health` are unauthenticated.

## Syncing more than one institution

FXAIX sits at both Fidelity and U.S. Bank, so the sync layer has to be able to
hold two connections at once. It could not, in two different ways:

- **Plaid** stored one access token under a fixed key, and linking a second
  institution called `/item/remove` on the first. Linking U.S. Bank
  *disconnected* Fidelity.
- **SnapTrade** merged every linked brokerage into a single map with a combined
  name like "Fidelity + U.S. Bank", so both landed in one account holding the
  summed shares — defeating the per-account split entirely.

Both now report **one entry per institution**, and the page files each under its
own account. The account is pinned to `plaid:<institution_id>` — the stable id
the provider assigns — never to the display name, because providers re-word
those and a re-wording would fork the bucket and double the position.

Two consequences worth knowing:

- **"Sync from bank" refreshes; "Add an institution" links.** The main button
  short-circuits to a refresh as soon as anything is connected, which is what
  keeps a Plaid Trial plan alive — but it also meant that once Fidelity was
  linked there was no way left to reach the Link flow. Adding a second bank
  needs its own button.
- **Disconnect is per-institution.** "Disconnect bank" was unambiguous with one
  connection and is not with two, so each connection has its own × and the bare
  button still means all of them.

One press then refreshes every institution, and a failure at one does not stop
the others: a stale login at U.S. Bank should not prevent Fidelity reporting.

## Only spendable accounts are counted

A brokerage login exposes far more than a taxable brokerage account. One real
Fidelity consent returned nine accounts and one Robinhood consent five: 401(k),
deferred compensation, traditional IRA, Roth IRA, ESPP, HSA, individual
brokerage, cash management, chequing, savings, crypto and two credit cards.

Summing all of them answers the wrong question. A dividend paid inside a Roth
IRA or an HSA is real money, but it is reinvested behind a tax wrapper — it does
not arrive anywhere it can be spent, and it cannot be withdrawn without a
penalty or a taxable event. For a page whose stated purpose is *when does money
hit my account*, counting it overstates the answer. In one real portfolio it
inflated projected income by about $1,350 a year.

`worker/src/accounts.js` classifies every account as **spendable**,
**sheltered**, **credit** or **deposit**, and only spendable accounts count.
The rule is shared by both providers, because Plaid has the same flaw —
`/investments/holdings/get` returns holdings for every account behind the Item,
retirement included, and the old code summed them blindly.

Three things make this safe rather than merely convenient:

- **It fails open.** An account is excluded only when positively identified as
  sheltered; an unrecognised type is kept. A brokerage this code has never seen
  would otherwise vanish silently and leave the user short some shares with
  nothing on screen to explain it. Over-counting is visible and removable;
  under-counting is not.
- **It says what it left out.** "Not counted: ROTH IRA, Health Savings
  Account — dividends there are reinvested…". An unexplained shortfall reads as
  a bug; a named one reads as a decision. Cards and chequing accounts are not
  mentioned, because they hold no positions to begin with.
- **It distinguishes "nothing tracked" from "nothing spendable".** Plaid's own
  sandbox holds everything in an IRA and a 401(k), so after filtering there is
  nothing to import. Reporting that as "0 positions matched" would send the
  reader hunting for a broken sync instead of a working filter.

Matching is on a normalised type code first (`401K`, `ROTH`, `IRA`, `HSA`,
`NONP`, `RRSP`, `SIPP`…) and on the account name second, because `raw_type` is
whatever the brokerage chose to send — Fidelity returns clean codes but also
free text like "Fidelity Credit Card". Name matching uses word boundaries: a
bare substring test for `ira` matches "spiral".

### Seeing them anyway

The retirement holdings are still fetched — a checkbox in the holdings panel,
**Include retirement accounts**, files them as *separate* accounts named
"<Institution> retirement" rather than merging them in. Separate rather than
merged so the spendable total stays legible beside them, and so unticking the
box can remove exactly those buckets.

Unticking works offline and immediately. The user is saying "stop counting
these", and making them sync first in order to see a *smaller* number would be
backwards. Ticking it on does need a sync, because those holdings were never
filed.

Two details that would otherwise mislead:

- With the box ticked, the "Not counted:" note is suppressed. Naming accounts
  as excluded while their shares are on screen would be a lie about the very
  number being shown.
- The "is this the same money reported twice?" warning is suppressed for
  retirement buckets. That warning catches an aggregator reporting known
  holdings under an unfamiliar name; a retirement bucket overlapping its own
  institution is the entire point, and advising the user to "remove the
  duplicate" would tell them to delete what they just asked for.

Sheltered accounts are identified by a `:sheltered` suffix on the provider key,
never by the display name — the name is the user's to change, and renaming an
account must not change whether its dividends count as spendable.

Skipping non-investment accounts also saves the requests. A 14-account read
became a 5-account read.

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

Under 560px the table folds to three columns — **Symbol · Pay date · Your
amount** — and the rest is folded into those cells rather than dropped:

| Hidden column | Where it goes |
| ------------- | ------------- |
| Ex-date       | *"ex Aug 20"* under the pay date (year omitted; the pay date above supplies it) |
| Per share     | *"$0.9100"* then *"× 100 sh"* on a second line under the amount |
| Shares        | the second of those two lines |
| Status        | a small pill inline beside the symbol |

**The folded column leads with the pay date, not the ex-date.** Which one is
prominent is not a style choice: the ex-date only says which dividend you
qualified for, while the pay date says when the cash actually lands, and on a
phone that is the thing worth reading at a glance. The wide table keeps both as
separate columns, so this only applies to the fold — and the heading switches
with it, because a column headed "Ex-date" showing pay dates would be worse
than either arrangement.

Not every row could once answer it. Yahoo publishes no pay dates at all, and
Nasdaq — which does — covers no open-end mutual funds. That is now handled
upstream: fund pay dates are estimated as the next business day after the
ex-date, so **every** row carries one. A row falls back to showing its ex-date
only if a feed returns nothing at all, which no longer happens for any tracked
symbol.

The "Next payment" card picks by pay date too, which fixed two things that
picking by ex-date got wrong: a dividend that had gone ex but not yet paid was
skipped entirely for the three weeks in between, and a fund going ex *later* can
still pay *sooner* than an equity going ex earlier.

Two non-obvious details:

- **`display: none` really removes a cell from its row**, so the footer's
  `colspan` has to shrink to match. Left at 5 it forces the table to keep six
  columns and the whole thing scrolls sideways again — which defeats the point.
  `colspan` is an HTML attribute that CSS cannot touch, so `renderTable` reads
  the breakpoint via `matchMedia` and re-renders when it is crossed.
- **Without share counts the dollar column is all em dashes.** In portrait the
  per-share column is gone, so the folded cell falls back to showing the
  per-share rate instead of an empty-looking dash.

Splitting the multiplication onto two lines was not enough on its own: it only
recovered about 4px, because `th, td { white-space: nowrap }` meant the columns
physically could not shrink no matter what was inside them. The fold breakpoint
now lets cells wrap (with `.date-main`, `.sym` and `.amt` opting back out) and
pins the three column widths with `table-layout: fixed`.

The smoke test missed the original overflow for an instructive reason: it seeded
no holdings, so the amount cell only ever contained `$0.9100 / share`. It now
sweeps 320–430px with six-figure share counts. **Any layout measurement of that
column has to seed realistic share counts or it measures nothing.**

### Refreshing without pressing Sync

Two different things go stale, on two different clocks:

| | What | When it refreshes |
| --- | --- | --- |
| `data.json` | dividend rates, ex-dates, pay dates | every open, every resume, every pull |
| Share counts | how much you hold | every pull; on open/resume once **6 hours** old |

They are separated deliberately. `data.json` is a single static fetch, cheap
enough to do on every resume. Share counts are a brokerage round trip that takes
seconds and costs API calls, and they only change when a trade settles — so
opening the app forty times in an afternoon should not mean forty syncs.

Six hours is short enough that a position bought this morning shows up by the
evening, and long enough that ordinary use never triggers a round trip. Pulling
down overrides it: an explicit gesture means *now*, and is already rate-limited
by human effort, so it skips the minimum-gap check that exists to stop resume
storms.

Four rules keep this from becoming a nuisance:

- **It never prompts for the passphrase.** A modal appearing because an app was
  brought back to the foreground would be indefensible. Without a stored
  passphrase, background sync simply does nothing and the button still works.
- **It is silent, including on failure.** This runs when the user has not asked
  for anything and cannot act on an error, so a red banner would be noise. The
  freshness pill is the honest channel — if syncing keeps failing, the pill ages
  and turns amber by itself.
- **It never interrupts typing.** Applying a sync re-renders the holdings panel,
  which would destroy the input being typed into and take the caret with it. A
  focused share-count box suppresses the sync until focus leaves.
- **It does not block first paint.** The table renders from the stored counts
  immediately; the sync lands afterwards and updates the figures in place.

An absent or unreadable sync timestamp counts as stale, so a fresh install pulls
holdings on first open. A timestamp in the *future* counts as fresh, so clock
skew between devices cannot cause a sync storm.

`tests/auto-sync.cjs` drives all three moments against a real brokerage.

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

## Holdings across several institutions

The same fund is often held in more than one place — FXAIX split between
Fidelity and U.S. Bank, say. A single share count per symbol cannot represent
that, and it makes every sync quietly destructive: Fidelity reporting its own
FXAIX overwrites the U.S. Bank shares with a smaller number that looks entirely
plausible on screen.

So share counts are stored per account:

```
divtracker.accounts.v1      [{ id, name }]              defined once, shared by every symbol
divtracker.holdingLots.v1   { SYMBOL: { id: shares } }  one cell per symbol per account
divtracker.holdings.v1      { SYMBOL: total }           derived; still written for rollback
```

`state.holdings` remains the plain symbol → total map, so nothing downstream of
it — the table, the projections, DRIP, the empty-state checks — knows accounts
exist. Only the holdings panel does.

Points worth knowing:

- **A sync replaces its account's holdings; it does not merge into them.** A
  position sold at Fidelity arrives as an *absence*, and an absence cannot
  overwrite anything, so merging would leave the sold row on screen forever.
  Replacement is the only reading under which the number means "what that
  institution holds today". Other accounts are never touched.
- **An import matching zero tracked tickers writes nothing at all**, so a CSV
  with unexpected column headings can't empty a good account. `applyHoldings`
  and `replaceAccountLots` both return the number of positions kept, and 0 is
  treated as a refusal rather than as an empty result.
- **A sync's account is chosen by *provider*, not by the label the provider
  prints.** SnapTrade reports the brokerage name for one connection and a
  combined name once a second is linked; the Plaid institution lookup is
  best-effort and falls back to `Bank sync` whenever it fails. Keying storage
  off that string forked the bucket on a re-wording, and because buckets are
  replaced independently the stale one was never reconciled — so the position
  silently *doubled*. The label is now only a display name, updated in place.
- **A sync adopts an existing account of the same name**, whoever created it.
  Two rails onto the same brokerage are reporting the same shares, so one
  bucket is right; forking would double-count them.
- **When a sync does create a genuinely new account that overlaps what other
  accounts hold, it says so.** An aggregator reporting `Fidelity + U.S. Bank`
  against hand-made `Fidelity` and `U.S. Bank` accounts is indistinguishable
  from a real third institution, so the status line names the affected symbols
  instead of guessing.
- **Account ids are derived from the name** (`U.S. Bank` → `u-s-bank`), and
  collisions between two genuinely different names get a `-2` suffix.
- **Accounts are created on first sight**, so syncing an institution does not
  require setting it up by hand first.
- **Existing share counts migrate automatically**: on the first run of this
  build, the flat map is folded into a single account named after whatever last
  wrote it. That is all the old model recorded, so it is all that can honestly
  be recovered; split it by hand from there. The migration is gated on
  `holdingLots.v1` being *absent* rather than empty — an empty map is a real
  state (the user pressed Clear) and re-migrating would resurrect the flat map.
- **An edit made by an older build is recovered, not discarded.** `holdings.v1`
  is written as a mirror so a rollback still shows the right numbers, but an
  older build will happily write *to* it, and then the lots are the stale copy.
  On boot, exactly the symbols whose totals disagree are folded back in; every
  untouched split is left alone. A recovered symbol collapses to one account,
  because the flat map has no way to say which account changed — the share
  count survives, and a split is far easier to re-enter than a number is to
  remember.
- The CSV target picker only appears once there are two or more accounts —
  before that an import can only mean one thing.
- Typing patches the "Total" line in place rather than re-rendering the panel,
  which would drop focus mid-number.

## Staying up to date

An installed PWA has no address bar and no reload button. Combined with a
cache-first service worker that meant the only way to pick up a new build was to
force-quit the app — and twice, shipped features sat on the server for days
without ever reaching the phone. Four things now prevent that:

1. **`docs/sw.js` is network-first**, not cache-first. The cache is a fallback
   for when the network is absent or slower than `NETWORK_TIMEOUT_MS` (3.5 s),
   not the primary source. A plain reload always gets the current files. This
   costs a little warm-start latency and buys correctness of what is on screen,
   which on an app about money is the better trade.
2. **The worker is registered with `updateViaCache: 'none'`** and asked to
   re-check on load, so the browser cannot serve a stale `sw.js` from its own
   HTTP cache for up to 24 hours.
3. **`skipWaiting()` + a one-shot reload on `controllerchange`.** A new version
   claims the page immediately and the page reloads itself once — guarded so
   that the *first* install, where there was no previous controller, doesn't
   cause a pointless flash.
4. **Pull down to refresh.** Re-fetches `data.json` and asks the worker to look
   for a new build at the same time; the two reasons to pull are "are these
   figures current" and "did the app change", and no user should have to tell
   them apart. Returning to the foreground does the same thing quietly, at most
   once a minute.

The gesture is bound in tabs as well as installed apps. `overscroll-behavior-y:
contain` plus `preventDefault()` on the drag suppress the platform's own
pull-to-refresh, so there is one gesture with one behaviour rather than two that
differ depending on how the page was opened.

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
| Hard limit | **10 Items, lifetime, non-refundable** | none documented for Personal |
| Getting keys | Trial plan application, identity verification | Sign up, verify email, enable 2FA — immediate |
| Built for | Banks; investments is a secondary product | Brokerages |
| Fidelity | Doubtful; support ticket at best | Supported, Fidelity Access OAuth |
| U.S. Bank | Supported | Supported (marked Beta) |
| Token to store | Yes — an access token per Item | **None** |

The last row is why the SnapTrade path is simpler: a Personal API key
identifies the user, so there is no per-connection token for the worker to
hold, no KV namespace, and nothing to disconnect.

**This is the recommended path for this repo**, because it is the only one of
the two confirmed to reach both institutions this tracker cares about, and the
only one that hands an individual working keys in about five minutes.

1. Sign up at <https://dashboard.snaptrade.com/signup>.
2. Verify your email and turn on two-factor authentication (required before a
   key is issued).
3. Create a **Personal** key on the API Key page — not a Commercial one.
   Personal means "reading my own accounts" and is free; Commercial is billed
   per connected user and needs KYC for a production key.

```powershell
cd worker
npx wrangler secret put SNAPTRADE_CLIENT_ID      # Personal client ID
npx wrangler secret put SNAPTRADE_CONSUMER_KEY   # Personal consumer key
npx wrangler deploy
```

A **Sync via SnapTrade** button then appears; the first click opens SnapTrade's
Connection Portal in a new tab, and after linking your brokerage you press it
again. Both integrations are read-only — neither can place a trade.

One caveat worth knowing before you build on it: SnapTrade's developer FAQ
lists Fidelity among brokers that "require an application to enable the
integration". That FAQ entry is written for Commercial keys and appears not to
apply to Personal ones, but it could not be confirmed from the public docs.
Link Fidelity through the portal early, before relying on it.

**In practice it works.** A Personal key connects to Fidelity through the
Fidelity Access OAuth flow and reads every account behind that one login — 401(k),
deferred comp, traditional IRA, Roth IRA, ESPP, HSA, individual brokerage, cash
management, even a credit card. All of them share one
`brokerage_authorization`, so they collapse into a single **Fidelity** account
here, with the same fund summed across them. That is the right grouping for this
app: the question it answers is "how much FXAIX is at Fidelity versus U.S. Bank",
not "which sub-account holds it".

Two things fall out of a real login that a test account never shows:

- **Cash sweep positions are holdings too.** SPAXX, FCASH and FDRXX come back
  as positions with large unit counts. They are money-market funds, not tracked
  tickers, so they are filtered out — but only because the filter is a
  whitelist of configured symbols rather than a blacklist of known cash tickers.
- **401(k) plan lots have no real ticker.** Fidelity reports commingled pools
  under opaque codes like `TGK1` or `O7M4`. Nothing can match those to a public
  symbol, so a 401(k) invested in an S&P 500 pool contributes nothing here even
  though it economically holds the same thing.

Nine accounts means nine position requests, which took about nine seconds
sequentially, so they are issued concurrently. One account that answers neither
`/positions` nor `/holdings` is reported and skipped rather than failing the
whole sync — a credit card should not stop a brokerage account from reporting.

Requests are signed per
[SnapTrade's spec](https://docs.snaptrade.com/docs/request-signatures):
HMAC-SHA256 over canonical JSON (`{content, path, query}`, keys sorted, no
whitespace), base64, in a `Signature` header. `tests/snaptrade.test.mjs`
verifies this against Node's own HMAC implementation.

### Credit cards: investigated, not built

Researched 2026-08-04 and deliberately dropped. The wanted feature was a live
total of outstanding charges across every card. It cannot be honest today:

| Issuer | Balance + posted txns | Pending txns |
| --- | --- | --- |
| Fidelity, Robinhood, U.S. Bank, Chase, Wells Fargo | SnapTrade (already wired) | no |
| **Capital One** | Plaid Trial — free, OAuth, self-serve | **no** ([Plaid support](https://support.plaid.com/hc/en-us/articles/25286986638231)) |
| **First Tech FCU** | Plaid Trial — credential-based | unconfirmed |
| **Apple Card** | **nothing** | **nothing** |

Three reasons it was dropped rather than half-built:

1. **A partial total is a wrong total.** A figure labelled "across all cards"
   that silently omits the Apple Card is worse than no figure — it invites a
   decision based on a number that is quietly too small.
2. **Apple Card has no path for an individual.** It is absent from Plaid's
   institution list entirely. Apple's FinanceKit (iOS 17.4+) is the only
   sanctioned API, and it requires an organisation developer account, a Finance
   category App Store app and Apple's approval — and it is an *on-device* iOS
   framework, so a web page or a Worker could not call it even with approval.
   Manual per-statement CSV export from Wallet is the only individual option.
   Goldman Sachs still operates the card; the announced move to Chase is not
   expected to complete until roughly 2028, and nothing has been said about
   data sharing changing.
3. **Pending charges — the actual request — are unavailable at Capital One**
   even via Plaid, which is where the largest balance sits.

SnapTrade *can* read cards at the brokerages it supports, and that code was
written, verified against five real cards, then removed. For whenever the
coverage picture changes, the mechanics were:

- Identify with `account_category === "LOC"`.
- Balance in `account.balance.total`; SnapTrade reports a debt as a **negative**
  amount, so it needs negating before display.
- Transactions at `GET /accounts/{id}/activities`. Note `/accounts/{id}/transactions`
  returns 404 and the top-level `/activities` returns 410 — only the per-account
  `activities` path works.

See git history around `c36b7b8` for the implementation.

### Dead ends, so you don't chase them

- **OFX Direct Connect** (`ofx.fidelity.com`) — the classic no-third-party
  route. Fidelity **shut it off in December 2025**.
- **Akoya** — the most direct rail, and ironically spun out of Fidelity's own
  parent. B2B only: requires a company and signed data-access agreements.

## Bank balances: a separate page

`docs/balances.html` is a second page, linked from the top of the main one. It
answers a different question — *how much money is actually in my accounts right
now* — so it deliberately shares nothing with the dividend table but the sync
worker, the passphrase and the stylesheet.

It is built around Canadian banks, which SnapTrade does not reach: SnapTrade
covers TD **Direct Investing** (the brokerage) but not TD Canada Trust, and
none of Scotiabank, RBC or Meridian at all. So this page is Plaid-only.

### What it shows

Accounts are grouped into **Cash** (chequing, savings), **Owed** (cards and
loans), **Investments** and **Other**, per institution, with a summary strip
across the top and a **Net** figure with everything owed subtracted.

Two conventions are worth stating because they are easy to get backwards:

- **Money owed is stored negative.** Plaid reports a card balance as a positive
  number, which would make a $5,000 card debt read as $5,000 of assets in any
  total. `describeAccount` negates `credit` and `loan` balances so that a sum
  across mixed account types means something.
- **Under a heading that already says "Owed", the minus sign is dropped.**
  "Owed −$253,988.12" reads as though the bank owes *you*. Rows, group headings
  and the summary card all show the magnitude; only **Net** keeps the sign,
  because there the sign is the entire point.

Totals are kept **per currency** and never added together. A page that mixed a
CAD chequing account into a USD one would produce a confident, wrong number.

### The four banks

All four were confirmed against the live Plaid institutions API:

| Institution | Plaid id | `balance` | `investments` | Sign-in |
| --- | --- | --- | --- | --- |
| TD Canada Trust | `ins_42` | yes | **no** | credentials |
| Scotiabank | `ins_38` | yes | yes | credentials |
| RBC Royal Bank | `ins_39` | yes | **no** | credentials |
| Meridian Credit Union | `ins_118297` | yes | **no** | credentials |

None of them use OAuth, so Plaid takes the banking username and password rather
than handing off to the bank's own sign-in page. TD and RBC have direct API
agreements with Plaid; **Scotiabank and Meridian are more likely screen-scraped
and correspondingly more fragile** — expect those two to need re-linking.

`balance` cannot be an `initial_products` value. Initialise the Item with
`auth` or `transactions`, then call `/accounts/balance/get`.

### Why a link has a scope

That `investments` column is the reason `/link/token/create` and
`/link/token/exchange` take a `scope`. **Three of the four banks do not support
the investments product at all**, and asking Link for it does not merely return
less — it removes those institutions from Link's search entirely, so TD Canada
Trust simply looks unsupported. The exchange then compounds it: it used to call
`/investments/holdings/get` unconditionally and discard any token that failed,
on the sound principle of never keeping a token it could not use. For a
chequing account that principle needs a different definition of "use".

So each stored connection records which page linked it:

- `scope: "holdings"` (or absent, for anything linked before this existed) —
  linked from the dividend page, US, `investments`, read for share counts.
- `scope: "balances"` — linked from the balances page, CA, `transactions`,
  read via `/accounts/balance/get`.

`/holdings/refresh` skips the balances-scoped ones. Otherwise a chequing
account would surface on the dividend page as a permanently failing connection,
indistinguishable from a stale login that the user could actually fix.

`/balances` deliberately reads **all** of them: cash sitting at a brokerage is
still cash.

### Getting a real (free) Plaid account

The sandbox will not touch a real bank. The **Trial plan** will, and it is free:

> Trial plan is available to developers who are located in the United States or
> Canada […] US and Canadian institutions are available on Trial plans.

No company, no security questionnaire, no contract.

1. Sign up at <https://dashboard.plaid.com/signup>, verify the email.
2. Go to <https://dashboard.plaid.com/trial-plan> and request the Trial plan.
3. Complete identity verification. Usually automatic; 2–3 business days if
   flagged for review.
4. Copy the **production** `client_id` and secret into the Worker
   (`wrangler secret put PLAID_SECRET`) and set `PLAID_ENV=production`,
   `PLAID_COUNTRY_CODES=CA`.

**The real ceiling is 10 Production Items for the lifetime of the account, and
they are not refundable.** Four banks is four slots; the other six are your
entire budget for re-links after a connection breaks. That is the reason to be
wary of the two fragile institutions above, not the plan's price.

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
node --test tests/sw.test.cjs              # service worker fetch strategy + cache lifecycle
node --test tests/accounts.test.cjs        # per-account share counts + migration
node --test tests/paydates.test.cjs        # the folded portrait date column
node --test tests/balances.test.mjs       # bank balances: grouping, currency, credit signs
```

There is also an end-to-end smoke test that loads the real page in headless Edge
and asserts the table, filters, dollar maths, the staleness banner, the quarter
colour bands, the portrait layout, pull-to-refresh and the per-account holdings
panel:

```powershell
cd docs; Start-Process python -ArgumentList '-m','http.server','8765'
cd ..; node tests\smoke.cjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
```

### Auto-refresh verification

`tests/auto-sync.cjs` drives the three moments share counts refresh on their
own — opening the app, resuming a backgrounded tab, and pulling down — plus the
two cases that must *not* sync: a reopen while the counts are still fresh, and a
focused share-count input. Needs a local worker and real credentials, so it sits
outside CI like the others.

```powershell
cd worker; npx wrangler dev --port 8787 --local
node tests\auto-sync.cjs "<edge path>" <passphrase>
```

### Live sync verification

`tests/live-sync.cjs` drives the whole chain for real — real button, real
`fetch`, real worker, real Plaid API — and is the only test that proves the
page and the worker agree. It is deliberately outside CI because it needs live
credentials. The one thing it stubs is `window.Plaid`: that widget is Plaid's
hosted UI, and automating its iframe would test their code, not this repo.
Everything from `onSuccess` onward is genuine.

```powershell
cd worker; npx wrangler dev --port 8787 --local     # reads .dev.vars
# then, in another shell:
$env:PLAID_CLIENT_ID="..."; $env:PLAID_SECRET="..."
node tests\live-sync.cjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" <passphrase>
```

It runs three scenarios against Plaid Sandbox. The first uses the stock test
user, whose holdings deliberately match nothing this page tracks, and asserts
the page says so clearly and writes nothing. The second builds a
[custom Sandbox user](https://plaid.com/docs/sandbox/user-custom/) holding
MSFT, FXAIX and an untracked NVDA, against a hand-entered U.S. Bank position,
and asserts the flagship guarantee end to end: the broker's shares land, NVDA
is ignored, and the U.S. Bank shares are still there afterwards. The third
presses sync again and asserts the worker refreshed through the stored token
rather than reopening Plaid Link — the behaviour the KV binding exists for,
and the reason the free tier survives more than ten syncs.

Because a bound KV namespace makes the worker remember its connection, the
test disconnects between scenarios and again at the end, so it neither
inherits state nor leaves a live token behind.

Pass the deployed site as a fourth argument to test production instead. No
local worker is needed then — the page uses whatever `WORKER_BASE` it was
published with, and that origin must be in the worker's `ALLOWED_ORIGINS`:

```powershell
node tests\live-sync.cjs "<edge path>" <passphrase> https://michaelens.github.io/dividend-tracker/index.html
```

### Bank balances verification

`tests/balances.cjs` does the same for the balances page: it links two real
Sandbox institutions through the real worker, loads the real page, and asserts
on what actually rendered. It exists because the interesting failures on that
page are all in the wiring rather than in any single function — a credit
balance shown as an asset, a heading contradicting the rows beneath it, or a
blank page on a cold open because nothing was cached.

```powershell
cd worker; npx wrangler dev --port 8787 --local
# then, in another shell:
$env:PLAID_CLIENT_ID="..."; $env:PLAID_SECRET="..."
node tests\balances.cjs "<edge path>" <passphrase>
```

`tests/balances-scope.cjs` covers the scope contract, which the unit tests can
only half-check: they assert the page *asks* for the balances scope, not that
the worker honours it. It links a sandbox institution that genuinely lacks the
investments product — `ins_130358`, standing in for TD Canada Trust — and
asserts it links, gets named, reports accounts, and does **not** turn into a
failing connection on the dividend page.

The stock sandbox bank cannot demonstrate any of this: `ins_109508` supports
investments, so the pre-fix code passes against it. Picking an institution that
reproduces the production shape was the difference between a test that proves
the fix and one that just runs.

```powershell
$env:PLAID_CLIENT_ID="..."; $env:PLAID_SECRET="..."; $env:SYNC_KEY="<folded passphrase>"
node tests\balances-scope.cjs
```

The unit tests alongside it include one that is worth calling out: it asserts
that **every class name used by `balances.html` and `balances.js` is actually
styled in `styles.css`**. Inventing a class name fails silently — the markup
renders, just unstyled, and it looks plausible enough in a screenshot to miss.
That test caught this page shipping `card-label` when the stylesheet had always
called it `label`.

## Privacy

- Share counts (per account), the account list, sync source, per-source
  freshness records, and last-synced timestamp are stored **only** in your
  browser's localStorage (`divtracker.*.v1` keys). Use "Clear" in the Your
  holdings panel to wipe them.
- The Cloudflare Worker stores one Plaid access token in your own Cloudflare KV
  so repeat syncs stay free. It is never sent to the browser, every endpoint
  that can read it requires `SYNC_PASSPHRASE`, and **Disconnect bank** deletes
  it. Skip the KV binding to keep the older token-less behaviour instead.
- The public GitHub Pages site contains only per-share amounts — no
  account-linkable data.
