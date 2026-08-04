/*
 * Runtime config for the static site.
 *
 * Everything here is public-safe: no secrets. Committing this file is fine.
 *
 * WORKER_BASE: URL of the Cloudflare Worker that performs the Plaid token
 *   exchange (see worker/). Leave empty to hide the "Sync from bank" button;
 *   the CSV import and manual entry paths still work with no worker deployed.
 *   Example: "https://divtracker.<you>.workers.dev"
 *
 * QUARTER_DAYS: how long before the freshness pill turns fully red. One quarter
 *   is a natural threshold because that is the cadence of most dividends here.
 */
window.DIVTRACKER_CONFIG = {
  WORKER_BASE: "",
  QUARTER_DAYS: 92,
};
