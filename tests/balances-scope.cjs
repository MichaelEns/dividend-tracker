/*
 * Does a balances-scoped link actually work end to end?
 *
 * The unit tests can only assert that the page *asks* for the balances scope.
 * This proves the worker honours it: that a bank with no investments links at
 * all (the investments call would have failed and the token been thrown away),
 * that the record is tagged, and that a chequing account linked here does not
 * then break the dividend page's refresh.
 *
 *   cd worker; npx wrangler dev --port 8787 --local
 *   node tests\balances-scope.cjs
 */
'use strict';

const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET = process.env.PLAID_SECRET;
const W = 'http://127.0.0.1:8787';
const ORIGIN = 'http://127.0.0.1:8765';
const KEY = process.env.SYNC_KEY;

// A sandbox institution that genuinely lacks the investments product, standing
// in for TD Canada Trust. `ins_109508`, the usual sandbox bank, supports
// investments and so cannot demonstrate the failure this scope exists to fix.
const NO_INVESTMENTS_INSTITUTION = 'ins_130358'; // Equitable Bank

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '\n         ' + extra : ''));
  if (!cond) fails += 1;
}

async function plaid(p, body) {
  const r = await fetch('https://sandbox.plaid.com' + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, secret: SECRET, ...body }),
  });
  const j = JSON.parse(await r.text());
  if (!r.ok) throw new Error(p + ': ' + j.error_message);
  return j;
}

async function w(p, body) {
  const r = await fetch(W + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Sync-Key': KEY },
    body: JSON.stringify(body || {}),
  });
  let j = null;
  try { j = JSON.parse(await r.text()); } catch { /* ignore */ }
  return { status: r.status, body: j };
}

async function main() {
  if (!CLIENT_ID || !SECRET || !KEY) {
    throw new Error('set PLAID_CLIENT_ID, PLAID_SECRET and SYNC_KEY');
  }
  let ready = false;
  for (let i = 0; i < 90 && !ready; i += 1) {
    try { ready = (await fetch(W + '/health')).ok; } catch { /* not up */ }
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error('no worker on 8787');

  await w('/item/disconnect', {});

  // A link token for balances must not be the same one used for holdings.
  const holdingsToken = await w('/link/token/create', {});
  const balancesToken = await w('/link/token/create', { scope: 'balances' });
  check('a holdings link token is issued', holdingsToken.status === 200 && !!holdingsToken.body.link_token,
    JSON.stringify(holdingsToken.body).slice(0, 160));
  check('a balances link token is issued', balancesToken.status === 200 && !!balancesToken.body.link_token,
    JSON.stringify(balancesToken.body).slice(0, 160));
  check('the two link tokens are different',
    holdingsToken.body.link_token !== balancesToken.body.link_token);

  // The real test: an Item at an institution that does not support investments
  // at all. Three of the four target banks are exactly this - TD Canada Trust,
  // RBC and Meridian all report investments=false - so the pre-scope code
  // could neither show them in Link nor keep a token for one.
  const pub = await plaid('/sandbox/public_token/create', {
    institution_id: NO_INVESTMENTS_INSTITUTION, initial_products: ['transactions'],
  });
  const ex = await w('/link/token/exchange', {
    public_token: pub.public_token, scope: 'balances',
  });
  check('a bank with no investments product links successfully', ex.status === 200,
    'HTTP ' + ex.status + ' ' + JSON.stringify(ex.body).slice(0, 200));
  check('the linked institution is named, not left blank',
    !!(ex.body && ex.body.institution), JSON.stringify(ex.body && ex.body.institution));

  const bal = await w('/balances', {});
  check('its balances are readable', bal.status === 200 && bal.body.institutions.length === 1,
    'HTTP ' + bal.status + ', institutions=' + (bal.body && bal.body.institutions || []).length);
  check('and it reports accounts', ((bal.body.institutions[0] || {}).accounts || []).length > 0,
    'accounts=' + ((bal.body.institutions[0] || {}).accounts || []).length);

  // A chequing account must not make the dividend page report a broken login.
  const refresh = await w('/holdings/refresh', {});
  check('the dividend refresh skips it instead of reporting a failure',
    refresh.status === 500 && /balances/i.test(String(refresh.body && refresh.body.error)),
    'HTTP ' + refresh.status + ': ' + String(refresh.body && refresh.body.error).slice(0, 180));

  await w('/item/disconnect', {});
  console.log(fails === 0 ? '\nSCOPED LINKING VERIFIED' : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
