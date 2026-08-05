/*
 * Tests for the Plaid worker's pure logic.
 *
 * The origin check is security-critical: this worker holds a Plaid secret and
 * can start bank sign-in flows, so it must fail closed when misconfigured.
 */
import test from 'node:test';
import assert from 'node:assert';

import { aggregateHoldings, connectionKey, mergeHoldings } from '../worker/src/index.js';
// The passphrase and origin gates live in their own module: a Worker entry
// module may only export functions, so a constant like MIN_PASSPHRASE cannot
// be exported from index.js at all.
import {
  originAllowed, authorized, timingSafeEqual, normalizePassphrase, MIN_PASSPHRASE,
} from '../worker/src/auth.js';
// Which accounts count toward spendable income - shared by both providers,
// because Plaid aggregates across every account behind the Item too.
import { classifyAccount, isSpendableAccount } from '../worker/src/accounts.js';

const SITE = 'https://example.github.io';
const PASS = 'correct-horse-battery-staple';

test('origin check fails closed when ALLOWED_ORIGINS is unset', () => {
  assert.strictEqual(originAllowed(SITE, {}), false);
  assert.strictEqual(originAllowed(SITE, { ALLOWED_ORIGINS: '' }), false);
  assert.strictEqual(originAllowed(SITE, { ALLOWED_ORIGINS: '   ' }), false);
});

test('origin check allows only configured origins', () => {
  const env = { ALLOWED_ORIGINS: `${SITE}, https://other.example` };
  assert.strictEqual(originAllowed(SITE, env), true);
  assert.strictEqual(originAllowed('https://other.example', env), true);
  assert.strictEqual(originAllowed('https://evil.example', env), false);
});

test('origin check ignores a trailing slash mismatch', () => {
  assert.strictEqual(originAllowed(SITE + '/', { ALLOWED_ORIGINS: SITE }), true);
  assert.strictEqual(originAllowed(SITE, { ALLOWED_ORIGINS: SITE + '/' }), true);
});

test('origin check rejects a missing Origin header', () => {
  assert.strictEqual(originAllowed('', { ALLOWED_ORIGINS: SITE }), false);
  assert.strictEqual(originAllowed(null, { ALLOWED_ORIGINS: SITE }), false);
});

test('origin check is not fooled by a substring prefix', () => {
  const env = { ALLOWED_ORIGINS: SITE };
  assert.strictEqual(originAllowed('https://example.github.io.evil.com', env), false);
});

test('holdings aggregate across accounts and skip untickered securities', () => {
  const investments = {
    securities: [
      { security_id: 'a', ticker_symbol: 'MSFT' },
      { security_id: 'b', ticker_symbol: 'fxaix' },
      { security_id: 'c', ticker_symbol: '' },
    ],
    holdings: [
      { security_id: 'a', quantity: 100 },
      { security_id: 'a', quantity: 40.5 },
      { security_id: 'b', quantity: 250.123 },
      { security_id: 'c', quantity: 999 },
      { security_id: 'missing', quantity: 5 },
      { security_id: 'a', quantity: 0 },
    ],
  };
  assert.deepStrictEqual(aggregateHoldings(investments).holdings, {
    MSFT: 140.5,
    FXAIX: 250.123,
  });
});

test('holdings tolerate an empty payload', () => {
  assert.deepStrictEqual(aggregateHoldings({}), { holdings: {}, skipped: [] });
});

/* -------------------------------------------------- spendable accounts only
 *
 * A dividend paid inside a Roth IRA or an HSA is real money that cannot be
 * spent when it lands, so counting it overstates "when does money hit my
 * account". Plaid returns every account behind the Item in one holdings list,
 * so without this the retirement shares were simply summed in.
 */

test('a retirement account is not counted toward spendable income', () => {
  const investments = {
    accounts: [
      { account_id: 'tax', type: 'investment', subtype: 'brokerage', name: 'Individual' },
      { account_id: 'roth', type: 'investment', subtype: 'roth', name: 'ROTH IRA' },
      { account_id: 'hsa', type: 'investment', subtype: 'hsa', name: 'Health Savings Account' },
      { account_id: 'k', type: 'investment', subtype: '401k', name: 'SAVINGS PLUS 401(K) PLAN' },
    ],
    securities: [{ security_id: 'f', ticker_symbol: 'FXAIX' }],
    holdings: [
      { account_id: 'tax', security_id: 'f', quantity: 1234.567 },
      { account_id: 'roth', security_id: 'f', quantity: 111.111 },
      { account_id: 'hsa', security_id: 'f', quantity: 222.222 },
      { account_id: 'k', security_id: 'f', quantity: 1000 },
    ],
  };
  const { holdings, skipped } = aggregateHoldings(investments);
  assert.deepStrictEqual(holdings, { FXAIX: 1234.567 },
    'sheltered shares were counted as spendable');
  assert.strictEqual(skipped.length, 3, 'the skipped accounts must be reported, not silent');
  assert.ok(skipped.every((s) => s.kind === 'sheltered'), JSON.stringify(skipped));
});

test('a credit card behind the same login contributes nothing', () => {
  const investments = {
    accounts: [
      { account_id: 'tax', type: 'investment', subtype: 'brokerage', name: 'Individual' },
      { account_id: 'card', type: 'credit', subtype: 'credit card', name: 'Rewards Visa' },
    ],
    securities: [{ security_id: 'm', ticker_symbol: 'MSFT' }],
    holdings: [
      { account_id: 'tax', security_id: 'm', quantity: 100 },
      { account_id: 'card', security_id: 'm', quantity: 999 },
    ],
  };
  const { holdings } = aggregateHoldings(investments);
  assert.deepStrictEqual(holdings, { MSFT: 100 });
});

test('a holding whose account is unknown is kept, not dropped', () => {
  // Fail open: the holding is real, and dropping it for missing metadata would
  // lose shares with nothing on screen to explain the shortfall.
  const investments = {
    accounts: [],
    securities: [{ security_id: 'm', ticker_symbol: 'MSFT' }],
    holdings: [{ account_id: 'nowhere', security_id: 'm', quantity: 100 }],
  };
  assert.deepStrictEqual(aggregateHoldings(investments).holdings, { MSFT: 100 });
});

test('an unrecognised account type is treated as spendable', () => {
  const investments = {
    accounts: [{ account_id: 'x', type: 'investment', subtype: 'some new thing', name: 'Whatever' }],
    securities: [{ security_id: 'm', ticker_symbol: 'MSFT' }],
    holdings: [{ account_id: 'x', security_id: 'm', quantity: 7 }],
  };
  assert.deepStrictEqual(aggregateHoldings(investments).holdings, { MSFT: 7 });
});

test('the classifier handles the real Fidelity and Robinhood type codes', () => {
  // Verbatim from a live SnapTrade read of one Fidelity and one Robinhood
  // consent: raw_type is whatever the brokerage chose to send, so both a clean
  // code (ROTH) and free text ("Fidelity Credit Card") have to work.
  const cases = [
    [{ category: 'INVESTMENT', type: 'TODI', name: 'Individual' }, 'spendable'],
    [{ category: 'INVESTMENT', type: 'INDIVIDUAL', name: 'Robinhood Individual' }, 'spendable'],
    [{ category: 'INVESTMENT', type: 'ESPP', name: 'ESPP PLAN' }, 'spendable'],
    [{ category: 'INVESTMENT', type: 'TODI', name: 'Cash Management' }, 'spendable'],
    [{ category: 'INVESTMENT', type: '401K', name: 'SAVINGS PLUS 401(K) PLAN' }, 'sheltered'],
    [{ category: 'INVESTMENT', type: 'ROTH', name: 'ROTH IRA' }, 'sheltered'],
    [{ category: 'INVESTMENT', type: 'IRA', name: 'Traditional IRA' }, 'sheltered'],
    [{ category: 'INVESTMENT', type: 'HSA', name: 'Health Savings Account' }, 'sheltered'],
    [{ category: 'INVESTMENT', type: 'NONP', name: 'DEFERRED COMPENSATION PLAN' }, 'sheltered'],
    [{ category: 'LOC', type: 'CREDITCARD', name: 'Robinhood Credit Card' }, 'credit'],
    [{ category: 'LOC', type: 'Fidelity Credit Card', name: 'Rewards Visa Signature Card' }, 'credit'],
    [{ category: 'DEPOSIT', type: 'CHECKING', name: 'Robinhood Checking' }, 'deposit'],
    [{ category: 'DEPOSIT', type: 'SAVINGS', name: 'Robinhood Savings' }, 'deposit'],
    [{ category: 'INVESTMENT', type: 'DIGITALASSET', name: 'Robinhood Crypto' }, 'spendable'],
  ];
  for (const [account, expected] of cases) {
    assert.strictEqual(classifyAccount(account), expected,
      `${account.name} (${account.type}) should be ${expected}`);
  }
});

test('a bare substring cannot misclassify a spendable account', () => {
  // "ira" appears inside "spiral"; a careless substring test would shelter it.
  assert.strictEqual(classifyAccount({ type: 'BROKERAGE', name: 'Spiral Growth Fund' }), 'spendable');
  assert.strictEqual(classifyAccount({ type: 'BROKERAGE', name: 'Admiral Shares' }), 'spendable');
  assert.strictEqual(classifyAccount({ type: 'BROKERAGE', name: 'My IRA' }), 'sheltered');
});

/* The passphrase gate matters more than the origin check once an access_token
 * is stored: /holdings/refresh can then disclose real positions, and an Origin
 * header is trivially forged by any non-browser client. */

test('auth fails closed when SYNC_PASSPHRASE is unset', () => {
  assert.strictEqual(authorized(PASS, {}), false);
  assert.strictEqual(authorized(PASS, { SYNC_PASSPHRASE: '' }), false);
  assert.strictEqual(authorized('', { SYNC_PASSPHRASE: '' }), false);
});

test('auth rejects a missing or wrong passphrase', () => {
  const env = { SYNC_PASSPHRASE: PASS };
  assert.strictEqual(authorized(null, env), false);
  assert.strictEqual(authorized(undefined, env), false);
  assert.strictEqual(authorized('', env), false);
  assert.strictEqual(authorized('wrong', env), false);
  // Case is deliberately NOT a difference: the passphrase is normalised so a
  // phone keyboard's capitalisation cannot lock the owner out. Content is.
  assert.strictEqual(authorized(PASS.replace('horse', 'zebra'), env), false);
});

test('auth accepts the exact passphrase', () => {
  assert.strictEqual(authorized(PASS, { SYNC_PASSPHRASE: PASS }), true);
});

test('auth is not fooled by a prefix or a repeated key', () => {
  const env = { SYNC_PASSPHRASE: PASS };
  assert.strictEqual(authorized(PASS.slice(0, -1), env), false);
  assert.strictEqual(authorized(PASS + 'x', env), false);
  // A short key must not pass by wrapping around the expected value.
  assert.strictEqual(authorized('c', env), false);
  assert.strictEqual(authorized('ab', { SYNC_PASSPHRASE: 'abab' }), false);
});

test('constant-time compare still returns correct results', () => {
  assert.strictEqual(timingSafeEqual('abc', 'abc'), true);
  assert.strictEqual(timingSafeEqual('abc', 'abd'), false);
  assert.strictEqual(timingSafeEqual('', ''), true);
  assert.strictEqual(timingSafeEqual('a', ''), false);
  assert.strictEqual(timingSafeEqual('', 'a'), false);
  assert.strictEqual(timingSafeEqual('abc', 'abcabc'), false);
});

/* ------------------------------------------------- passphrase normalisation
 *
 * The owner's passphrase is a sentence, and a sentence has to survive being
 * typed on a phone. iOS silently rewrites a straight apostrophe into a curly
 * one, so "I'm" from the phone and "I'm" from a laptop are different bytes and
 * would never match without folding.
 */

const PHRASE = "It's a lovely day, isn't it?";
const PHRASE_ENV = { SYNC_PASSPHRASE: PHRASE };

test('the exact phrase authorises', () => {
  assert.strictEqual(authorized(PHRASE, PHRASE_ENV), true);
});

test('an iOS curly apostrophe still authorises', () => {
  // U+2019, which is what an iPhone actually inserts.
  const curly = "It\u2019s a lovely day, isn\u2019t it?";
  assert.notStrictEqual(curly, PHRASE, 'the fixture must differ in bytes to be a real test');
  assert.strictEqual(authorized(curly, PHRASE_ENV), true);
});

test('punctuation, case and spacing do not matter', () => {
  for (const variant of [
    'itsalovelydayisntit',
    "It's a lovely day, isn't it",
    "IT'S A LOVELY DAY, ISN'T IT?",
    "  It's   a lovely day,  isn't it?  ",
    "It\u2018s a lovely day, isn\u2018t it\u2026",
    'Its; a lovely day - isnt it!',
  ]) {
    assert.strictEqual(authorized(variant, PHRASE_ENV), true, 'rejected: ' + variant);
  }
});

test('the stored secret may be spelled differently from what is typed', () => {
  // Normalisation applies to both sides, so re-setting the secret with a curly
  // apostrophe does not lock out a laptop typing a straight one.
  const stored = { SYNC_PASSPHRASE: "It\u2019s a lovely day, isn\u2019t it?" };
  assert.strictEqual(authorized(PHRASE, stored), true);
});

test('the words themselves still matter', () => {
  for (const wrong of [
    "It's a dreadful day, isn't it?",
    "It's a lovely day, isnt",
    'its a lovely day',
    'lovely',
    '',
  ]) {
    assert.strictEqual(authorized(wrong, PHRASE_ENV), false, 'accepted: ' + wrong);
  }
});

test('normalisation cannot open a hole when the secret is punctuation', () => {
  // "..." folds to the empty string, and so would any punctuation a caller
  // sends, which without a floor would authorise everyone.
  for (const weak of ['...', "'", '!!!', '   ', '-', 'ab.c']) {
    assert.strictEqual(authorized(weak, { SYNC_PASSPHRASE: weak }), false,
      'a passphrase that folds to almost nothing was accepted: ' + weak);
    assert.strictEqual(authorized('anything at all', { SYNC_PASSPHRASE: weak }), false);
  }
});

test('a passphrase at the length floor still works', () => {
  const eight = 'abcd1234';
  assert.strictEqual(normalizePassphrase(eight).length, MIN_PASSPHRASE);
  assert.strictEqual(authorized(eight, { SYNC_PASSPHRASE: eight }), true);
  assert.strictEqual(authorized('abcd123', { SYNC_PASSPHRASE: 'abcd123' }), false,
    'one character under the floor must fail closed');
});

test('normalizePassphrase strips everything that is not a letter or digit', () => {
  assert.strictEqual(normalizePassphrase("It's a lovely day."), 'itsalovelyday');
  assert.strictEqual(normalizePassphrase('Caf\u00e9 99'), 'cafe99');
  assert.strictEqual(normalizePassphrase(null), '');
  assert.strictEqual(normalizePassphrase(undefined), '');
});

/* ------------------------------------------ more than one institution at once */

test('a connection is identified by institution id, not by its name', () => {
  // Plaid re-words institution names; a re-wording must not look like a new
  // institution, or the same holdings get stored twice and counted twice.
  assert.strictEqual(connectionKey({ institutionId: 'ins_1', institution: 'Fidelity' }), 'ins_1');
  assert.strictEqual(connectionKey({ institutionId: 'ins_1', institution: 'Fidelity Investments' }), 'ins_1');
  assert.notStrictEqual(connectionKey({ institutionId: 'ins_1' }), connectionKey({ institutionId: 'ins_2' }));
});

test('a connection with no institution id falls back to its item id', () => {
  assert.strictEqual(connectionKey({ item_id: 'itm_9' }), 'itm_9');
  assert.strictEqual(connectionKey({}), 'default');
});

test('merging across institutions sums rather than overwrites', () => {
  const merged = mergeHoldings([
    { institution: 'Fidelity', holdings: { FXAIX: 900.512, MSFT: 100 } },
    { institution: 'U.S. Bank', holdings: { FXAIX: 100 } },
  ]);
  assert.deepStrictEqual(merged, { FXAIX: 1000.512, MSFT: 100 },
    'the U.S. Bank FXAIX was lost to the Fidelity FXAIX');
});

/* ------------------------------- the page and the worker must agree exactly
 *
 * Two copies of normalizePassphrase exist: one in the worker, one in the page
 * (which cannot import the worker). If they ever disagree, every sync returns
 * 401 with no clue why, so their agreement is asserted rather than assumed.
 */

import { createRequire } from 'node:module';
const pageNormalize = createRequire(import.meta.url)('../docs/app.js').normalizePassphrase;

const SAMPLES = [
  "It's a lovely day, isn't it?",
  "It\u2019s a lovely day, isn\u2019t it?",
  'itsalovelydayisntit',
  '  MiXeD   CaSe, and punctuation!!  ',
  'Caf\u00e9 na\u00efve 42',
  'correct-horse-battery-staple',
  '',
  '...',
  '\u4e2d\u6587 test 7',
];

test('the page folds passphrases exactly as the worker does', () => {
  for (const s of SAMPLES) {
    assert.strictEqual(pageNormalize(s), normalizePassphrase(s),
      'page and worker disagree on: ' + JSON.stringify(s));
  }
});

test('a folded passphrase is always safe to put in an HTTP header', () => {
  // Found the hard way: an HTTP header value is a byte string, so fetch throws
  // on any character above U+00FF - and iOS's curly apostrophe is U+2019. The
  // request failed in the browser before it was ever sent, with an error about
  // ByteStrings that mentioned nothing about passphrases. Folding on the page
  // makes the header ASCII by construction.
  for (const s of SAMPLES) {
    const folded = pageNormalize(s);
    assert.match(folded, /^[a-z0-9]*$/, 'not header-safe: ' + JSON.stringify(folded));
    for (const ch of folded) {
      assert.ok(ch.codePointAt(0) < 256,
        'character above U+00FF would make fetch throw: ' + JSON.stringify(ch));
    }
    // The property that actually matters, stated the way the browser states it.
    assert.doesNotThrow(() => new Headers({ 'X-Sync-Key': folded }),
      'fetch would reject this header value: ' + JSON.stringify(s));
  }
});

test('the raw phrase really would break a header, so folding is load-bearing', () => {
  assert.throws(() => new Headers({ 'X-Sync-Key': "I\u2019m a lovely." }),
    'if this stops throwing, the page-side fold is no longer needed');
});

test('folding is idempotent, so the worker can fold an already-folded value', () => {
  for (const s of SAMPLES) {
    const once = normalizePassphrase(s);
    assert.strictEqual(normalizePassphrase(once), once, 'not idempotent: ' + JSON.stringify(s));
  }
});
