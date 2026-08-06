/*
 * Tests for the two apps running against separate Plaid developer accounts.
 *
 * A Plaid access token belongs to the client_id/secret pair that created it.
 * If a stored connection is later read back with the *other* account's
 * credentials, Plaid rejects it — and the page reports it as a failed bank
 * connection, which looks exactly like a password change the user could fix.
 * They cannot. So every call that touches a stored token has to use the
 * credentials that created it.
 *
 * Rather than trust that each call site was updated, these drive the real
 * worker with a stubbed fetch and assert on the credentials that actually went
 * out. A missed call site fails here.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../worker/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = 'https://example.github.io';
const PASS = 'correct-horse-battery-staple';

const HOLDINGS = { id: 'holdings-client', secret: 'holdings-secret' };
const BALANCES = { id: 'balances-client', secret: 'balances-secret' };

/** A KV namespace that keeps everything in a Map. */
function fakeKv(seed) {
  const store = new Map(Object.entries(seed || {}));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

function makeEnv(extra) {
  return {
    ALLOWED_ORIGINS: SITE,
    SYNC_PASSPHRASE: PASS,
    PLAID_CLIENT_ID: HOLDINGS.id,
    PLAID_SECRET: HOLDINGS.secret,
    PLAID_ENV: 'sandbox',
    PLAID_BALANCE_CLIENT_ID: BALANCES.id,
    PLAID_BALANCE_SECRET: BALANCES.secret,
    PLAID_BALANCE_ENV: 'production',
    TOKENS: fakeKv(),
    ...extra,
  };
}

/**
 * Records every Plaid request and answers it plausibly. Returns the calls so a
 * test can assert which account each one was billed to.
 */
function stubPlaid(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const path = new URL(url).pathname;
    calls.push({
      path,
      host: new URL(url).host,
      clientId: body.client_id,
      secret: body.secret,
      accessToken: body.access_token,
    });
    const payload = (responses && responses[path]) || {};
    return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

function post(path, body, env) {
  return worker.fetch(new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: SITE, 'X-Sync-Key': PASS },
    body: JSON.stringify(body || {}),
  }), env);
}

const forPath = (calls, path) => calls.filter((c) => c.path === path);

/* --------------------------------------------------------------- linking */

test('a balances link uses the balances account, a holdings link the other', async () => {
  const env = makeEnv();
  const stub = stubPlaid({ '/link/token/create': { link_token: 'lt' } });
  try {
    await post('/link/token/create', {}, env);
    await post('/link/token/create', { scope: 'balances' }, env);
  } finally { stub.restore(); }

  const [holdings, balances] = forPath(stub.calls, '/link/token/create');
  assert.strictEqual(holdings.clientId, HOLDINGS.id);
  assert.strictEqual(balances.clientId, BALANCES.id, 'the balances app used the wrong account');
  assert.strictEqual(balances.secret, BALANCES.secret);
});

test('each account keeps its own Plaid environment', async () => {
  // One app can stay on sandbox while the other runs against real banks.
  const env = makeEnv();
  const stub = stubPlaid({ '/link/token/create': { link_token: 'lt' } });
  try {
    await post('/link/token/create', {}, env);
    await post('/link/token/create', { scope: 'balances' }, env);
  } finally { stub.restore(); }

  const [holdings, balances] = forPath(stub.calls, '/link/token/create');
  assert.match(holdings.host, /sandbox/);
  assert.match(balances.host, /production/,
    'the balances account was pointed at the wrong Plaid environment');
});

test('the whole exchange runs on one account, not a mixture', async () => {
  const env = makeEnv();
  const stub = stubPlaid({
    '/item/public_token/exchange': { access_token: 'tok-b', item_id: 'item-b' },
    '/accounts/get': { accounts: [], item: { institution_id: 'ins_42' } },
    '/institutions/get_by_id': { institution: { name: 'TD Canada Trust' } },
  });
  try {
    await post('/link/token/exchange', { public_token: 'pub', scope: 'balances' }, env);
  } finally { stub.restore(); }

  assert.ok(stub.calls.length >= 3, 'expected exchange, accounts and institution lookup');
  for (const call of stub.calls) {
    assert.strictEqual(call.clientId, BALANCES.id,
      `${call.path} was sent to the wrong Plaid account`);
  }
});

test('the bank consent screen names the app doing the asking', async () => {
  // client_name is what the bank shows the user while they decide whether to
  // hand over their banking login. "Dividend Tracker" asking for a chequing
  // account reads like the wrong app got hold of it.
  const env = makeEnv();
  const stub = stubPlaid({ '/link/token/create': { link_token: 'lt' } });
  const names = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    names.push(JSON.parse(opts.body).client_name);
    return original ? { ok: true, status: 200, async text() { return '{"link_token":"lt"}'; } } : null;
  };
  try {
    await post('/link/token/create', {}, env);
    await post('/link/token/create', { scope: 'balances' }, env);
  } finally { globalThis.fetch = original; stub.restore(); }

  assert.strictEqual(names[0], 'Dividend Tracker');
  assert.notStrictEqual(names[1], 'Dividend Tracker',
    'a bank balances consent screen should not be branded as the dividend app');
  assert.ok(names[1] && names[1].length > 0);
});

/* ------------------------------------------------------ protecting slots */

test('a link whose first read fails is kept, not thrown away', async () => {
  // The exchange already succeeded, so a Trial slot is spent and /item/remove
  // does not refund it. Discarding the token would leave a live Item nothing
  // can ever read, refresh or disconnect: the slot gone for nothing.
  const env = makeEnv();
  const stub = stubPlaid({
    '/item/public_token/exchange': { access_token: 'tok-x', item_id: 'item-x' },
    '/item/get': { item: { institution_id: 'ins_42' } },
    '/institutions/get_by_id': { institution: { name: 'TD Canada Trust' } },
  });
  // The first read is the one that fails.
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (new URL(url).pathname === '/accounts/get') {
      return { ok: false, status: 400, async text() {
        return JSON.stringify({ error_code: 'PRODUCT_NOT_READY', error_message: 'not ready' });
      } };
    }
    return inner(url, opts);
  };

  let res;
  try {
    res = await post('/link/token/exchange', { public_token: 'pub', scope: 'balances' }, env);
  } finally { globalThis.fetch = inner; stub.restore(); }

  assert.strictEqual(res.status, 500, 'the failure should still be reported');
  const stored = JSON.parse(env.TOKENS.store.get('plaid:items') || '[]');
  assert.strictEqual(stored.length, 1, 'the connection was discarded and its slot lost');
  assert.strictEqual(stored[0].access_token, 'tok-x');
  assert.strictEqual(stored[0].scope, 'balances');

  const removes = forPath(stub.calls, '/item/remove');
  assert.strictEqual(removes.length, 0,
    'the Item was removed, which does not refund the slot and only loses access');
});

test('the error explains that re-linking would waste a connection', async () => {
  const env = makeEnv();
  const stub = stubPlaid({
    '/item/public_token/exchange': { access_token: 'tok-x', item_id: 'item-x' },
    '/item/get': { item: { institution_id: 'ins_42' } },
  });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (new URL(url).pathname === '/accounts/get') {
      return { ok: false, status: 400, async text() {
        return JSON.stringify({ error_code: 'X', error_message: 'boom' });
      } };
    }
    return inner(url, opts);
  };
  let res;
  try {
    res = await post('/link/token/exchange', { public_token: 'pub', scope: 'balances' }, env);
  } finally { globalThis.fetch = inner; stub.restore(); }

  const body = await res.json();
  assert.match(body.error, /Refresh/i, `should point at Refresh, got: ${body.error}`);
  assert.match(body.error, /consume another|re-link/i);
});

test('with no storage a failed read does release the Item', async () => {
  // The opposite case: nothing can persist the token, so the Item would be
  // unreachable forever. Releasing it is then the only responsible thing.
  const env = makeEnv({ TOKENS: undefined });
  const stub = stubPlaid({
    '/item/public_token/exchange': { access_token: 'tok-y', item_id: 'item-y' },
  });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (new URL(url).pathname === '/accounts/get') {
      return { ok: false, status: 400, async text() {
        return JSON.stringify({ error_code: 'X', error_message: 'boom' });
      } };
    }
    return inner(url, opts);
  };
  try {
    await post('/link/token/exchange', { public_token: 'pub', scope: 'balances' }, env);
  } finally { globalThis.fetch = inner; stub.restore(); }

  const removes = forPath(stub.calls, '/item/remove');
  assert.strictEqual(removes.length, 1, 'an unreachable Item should have been released');
  assert.strictEqual(removes[0].accessToken, 'tok-y');
});

/* ----------------------------------------------------------- update mode */

test('adding accounts reuses the connection instead of spending a slot', async () => {
  const env = seededEnv();
  const stub = stubPlaid({ '/link/token/create': { link_token: 'lt-update' } });
  try {
    await post('/link/token/update', { key: 'ins_42' }, env);
  } finally { stub.restore(); }

  const call = stub.calls.find((c) => c.path === '/link/token/create');
  assert.ok(call, 'no link token was created');
  assert.strictEqual(call.accessToken, 'tok-balances',
    'update mode must pass the existing access token, or it creates a new Item');
});

test('an update may narrow products, which is how hidden accounts surface', async () => {
  // An earlier version of this test asserted the opposite - that Plaid rejects
  // products alongside an access_token. Probed against the real production API,
  // it accepts them, and that matters: Link only offers accounts supporting
  // every product asked for, so the Item's original product list is often the
  // reason an account never appeared.
  const env = seededEnv();
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, async text() { return '{"link_token":"lt"}'; } };
  };
  try {
    await post('/link/token/update', { key: 'ins_42', products: ['auth'] }, env);
  } finally { globalThis.fetch = original; }

  const body = bodies[0];
  assert.deepStrictEqual(body.products, ['auth']);
  assert.ok(body.access_token, 'update mode must still reuse the existing Item');
  assert.deepStrictEqual(body.update, { account_selection_enabled: true },
    'without account_selection_enabled the user is never offered the choice');
});

test('an update with no products asked for sends none at all', async () => {
  // Sending an empty products array is not the same as omitting the field, and
  // Plaid rejects the empty one.
  const env = seededEnv();
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, async text() { return '{"link_token":"lt"}'; } };
  };
  try {
    await post('/link/token/update', { key: 'ins_42' }, env);
  } finally { globalThis.fetch = original; }

  assert.ok(!('products' in bodies[0]), 'an empty products array is rejected by Plaid');
});

test('an unrecognised product is dropped rather than sent to Plaid', async () => {
  // The value arrives in a request body. Plaid rejects an unknown product
  // outright, which on screen looks like the bank refusing the connection.
  const env = seededEnv();
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, async text() { return '{"link_token":"lt"}'; } };
  };
  try {
    await post('/link/token/update',
      { key: 'ins_42', products: ['auth', 'not-a-product', 'DROP TABLE'] }, env);
  } finally { globalThis.fetch = original; }

  assert.deepStrictEqual(bodies[0].products, ['auth']);
});

test('an update reopens the right connection with its own credentials', async () => {
  const env = seededEnv();
  const stub = stubPlaid({ '/link/token/create': { link_token: 'lt' } });
  try {
    await post('/link/token/update', { key: 'ins_1' }, env);
  } finally { stub.restore(); }

  const call = stub.calls.find((c) => c.path === '/link/token/create');
  assert.strictEqual(call.accessToken, 'tok-holdings');
  assert.strictEqual(call.clientId, HOLDINGS.id,
    'a token can only be updated by the account that created it');
});

test('asking to update a connection that does not exist says so', async () => {
  const env = seededEnv();
  const stub = stubPlaid({});
  let res;
  try {
    res = await post('/link/token/update', { key: 'ins_nope' }, env);
  } finally { stub.restore(); }
  assert.strictEqual(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /No connection is stored/);
  assert.strictEqual(stub.calls.length, 0, 'nothing should have been sent to Plaid');
});

test('the balances app asks for the least it can, not transaction history', () => {
  // The page only ever calls /accounts/balance/get. `balance` cannot be named
  // as an initial product - Plaid initialises it automatically - so some other
  // product has to be, and `transactions` consented to every purchase at the
  // bank in order to read one number. On an app whose stated pitch is that
  // nothing leaves the device, asking for data it never reads is the wrong
  // default even when nothing goes wrong.
  const toml = fs.readFileSync(
    path.join(__dirname, '..', 'worker', 'wrangler.toml'), 'utf8',
  );
  const m = toml.match(/^PLAID_BALANCE_PRODUCTS\s*=\s*"([^"]+)"/m);
  assert.ok(m, 'PLAID_BALANCE_PRODUCTS is not configured');
  const products = m[1].split(',').map((s) => s.trim());
  assert.ok(!products.includes('transactions'),
    'the balances app requests transaction history it never reads');
  assert.ok(!products.includes('auth'),
    'auth excludes credit cards, which would hide a card-only bank entirely');
  assert.strictEqual(products.length, 1, 'one product is enough to create the Item');
});

/* ------------------------------------------------- reading stored tokens */
/** Two stored connections, one from each account. */
function seededEnv() {
  return makeEnv({
    TOKENS: fakeKv({
      'plaid:items': JSON.stringify([
        {
          key: 'ins_1', institutionId: 'ins_1', access_token: 'tok-holdings',
          institution: 'Fidelity', scope: 'holdings',
        },
        {
          key: 'ins_42', institutionId: 'ins_42', access_token: 'tok-balances',
          institution: 'TD Canada Trust', scope: 'balances',
        },
      ]),
    }),
  });
}

test('every balance read uses the account that linked that connection', async () => {
  const env = seededEnv();
  const stub = stubPlaid({ '/accounts/balance/get': { accounts: [] } });
  try {
    await post('/balances', {}, env);
  } finally { stub.restore(); }

  const calls = forPath(stub.calls, '/accounts/balance/get');
  assert.strictEqual(calls.length, 2, 'both connections should have been read');
  const byToken = Object.fromEntries(calls.map((c) => [c.accessToken, c.clientId]));
  assert.strictEqual(byToken['tok-holdings'], HOLDINGS.id);
  assert.strictEqual(byToken['tok-balances'], BALANCES.id,
    'a token was read back with the account that did not create it');
});

test('a holdings refresh never reaches for the balances account', async () => {
  const env = seededEnv();
  const stub = stubPlaid({
    '/investments/holdings/get': { holdings: [], securities: [], accounts: [], item: {} },
  });
  try {
    await post('/holdings/refresh', {}, env);
  } finally { stub.restore(); }

  for (const call of stub.calls) {
    assert.strictEqual(call.clientId, HOLDINGS.id, `${call.path} used the balances account`);
    assert.notStrictEqual(call.accessToken, 'tok-balances',
      'the balances connection was polled for holdings');
  }
});

test('disconnecting removes each Item through its own account', async () => {
  // Getting this wrong is expensive and invisible: the remove call fails, the
  // connection is forgotten locally, and the Item stays live having permanently
  // consumed one of the ten lifetime slots.
  const env = seededEnv();
  const stub = stubPlaid({ '/item/remove': { removed: true } });
  try {
    await post('/item/disconnect', {}, env);
  } finally { stub.restore(); }

  const calls = forPath(stub.calls, '/item/remove');
  assert.strictEqual(calls.length, 2);
  const byToken = Object.fromEntries(calls.map((c) => [c.accessToken, c.clientId]));
  assert.strictEqual(byToken['tok-holdings'], HOLDINGS.id);
  assert.strictEqual(byToken['tok-balances'], BALANCES.id,
    'an Item would have been orphaned, still billed against a permanent slot');
});

/* ------------------------------------------------------------- fallback */

test('one account still works when no second one is configured', async () => {
  // The overwhelmingly common setup, and the one that existed before this.
  const env = makeEnv({
    PLAID_BALANCE_CLIENT_ID: undefined,
    PLAID_BALANCE_SECRET: undefined,
    PLAID_BALANCE_ENV: undefined,
  });
  const stub = stubPlaid({ '/link/token/create': { link_token: 'lt' } });
  try {
    await post('/link/token/create', { scope: 'balances' }, env);
  } finally { stub.restore(); }

  const call = forPath(stub.calls, '/link/token/create')[0];
  assert.strictEqual(call.clientId, HOLDINGS.id, 'the shared account should be the fallback');
  assert.strictEqual(call.secret, HOLDINGS.secret);
  assert.match(call.host, /sandbox/, 'the shared environment should be the fallback');
});

test('a half-configured second account is refused, not quietly mixed', async () => {
  // A client id from one account with the secret from another authenticates as
  // neither, and Plaid reports that as an ordinary credentials error — so it
  // reads like the bank connection broke rather than like a typo in the
  // worker's own configuration. Refusing up front says which.
  const env = makeEnv({ PLAID_BALANCE_SECRET: undefined });
  const stub = stubPlaid({ '/link/token/create': { link_token: 'lt' } });
  let res;
  try {
    res = await post('/link/token/create', { scope: 'balances' }, env);
  } finally { stub.restore(); }

  assert.strictEqual(stub.calls.length, 0, 'a request went out with mixed credentials');
  const body = await res.json();
  assert.match(body.error, /PLAID_BALANCE_SECRET/,
    `the error should name the missing variable, got: ${body.error}`);
});

test('setting only the balance environment is refused too', async () => {
  // A Plaid secret is specific to one environment, so switching environment
  // without switching secret cannot work; it just fails as bad credentials.
  const env = makeEnv({
    PLAID_BALANCE_CLIENT_ID: undefined,
    PLAID_BALANCE_SECRET: undefined,
    PLAID_BALANCE_ENV: 'production',
  });
  const stub = stubPlaid({ '/link/token/create': { link_token: 'lt' } });
  let res;
  try {
    res = await post('/link/token/create', { scope: 'balances' }, env);
  } finally { stub.restore(); }

  assert.strictEqual(stub.calls.length, 0);
  const body = await res.json();
  assert.match(body.error, /PLAID_BALANCE_CLIENT_ID/);
});

test('the dividend app is unaffected by a broken balances configuration', async () => {
  // A misconfigured second account must not take down the app that was
  // already working.
  const env = makeEnv({ PLAID_BALANCE_SECRET: undefined });
  const stub = stubPlaid({ '/link/token/create': { link_token: 'lt' } });
  try {
    await post('/link/token/create', {}, env);
  } finally { stub.restore(); }

  const call = forPath(stub.calls, '/link/token/create')[0];
  assert.ok(call, 'the dividend app could not start a link');
  assert.strictEqual(call.clientId, HOLDINGS.id);
});

/* ---------------------------------------------------------- legacy items */

test('a connection stored before scopes existed uses the original account', async () => {
  const env = makeEnv({
    TOKENS: fakeKv({
      'plaid:items': JSON.stringify([
        { key: 'ins_1', institutionId: 'ins_1', access_token: 'tok-old', institution: 'Fidelity' },
      ]),
    }),
  });
  const stub = stubPlaid({ '/accounts/balance/get': { accounts: [] } });
  try {
    await post('/balances', {}, env);
  } finally { stub.restore(); }

  const call = forPath(stub.calls, '/accounts/balance/get')[0];
  assert.strictEqual(call.clientId, HOLDINGS.id,
    'an item with no scope must not be read with the newer account');
});
