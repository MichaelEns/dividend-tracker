/*
 * Tests for per-account share counts.
 *
 * The same fund can be held at several institutions - FXAIX sits at both
 * Fidelity and U.S. Bank - and each is synced independently. Under the old
 * flat symbol -> shares map, syncing either institution silently overwrote the
 * other's shares, which looks exactly like a legitimate update and is
 * impossible to notice on screen. These tests pin the two properties that stop
 * that: a sync replaces only its own account's numbers, and the displayed
 * total is always the sum of every account.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  accountId,
  findAccount,
  addAccount,
  syncAccount,
  uniqueAccountId,
  overlappingSymbols,
  unmatchedMessage,
  describeSync,
  describeSkipped,
  skippedFrom,
  connectionsFrom,
  reconcileFlatHoldings,
  removeAccount,
  totalsFromLots,
  setLot,
  replaceAccountLots,
  migrateHoldings,
} = require(path.join(__dirname, '..', 'docs', 'app.js'));

/* ------------------------------------------------------------------- naming */

test('account ids ignore case, spacing and punctuation', () => {
  assert.strictEqual(accountId('Fidelity'), 'fidelity');
  assert.strictEqual(accountId('fidelity'), 'fidelity');
  assert.strictEqual(accountId('U.S. Bank'), 'u-s-bank');
  assert.strictEqual(accountId('  U.S. Bank  '), 'u-s-bank');
  assert.strictEqual(accountId('U S Bank'), 'u-s-bank');
});

test('an unnameable account still gets a usable id', () => {
  // Sources sometimes hand over punctuation-only or empty names. An empty id
  // would collide with the object prototype chain and silently vanish.
  assert.strictEqual(accountId('...'), 'account');
  assert.strictEqual(accountId(''), 'account');
  assert.strictEqual(accountId(null), 'account');
});

test('an account is found regardless of how the source spells it', () => {
  const accounts = [{ id: 'u-s-bank', name: 'U.S. Bank' }];
  assert.ok(findAccount(accounts, 'u.s. bank'));
  assert.ok(findAccount(accounts, 'U S BANK'));
  assert.strictEqual(findAccount(accounts, 'Fidelity'), null);
  assert.strictEqual(findAccount([], 'Fidelity'), null);
});

test('adding an equivalent account reuses it instead of duplicating', () => {
  // Otherwise "Fidelity" and "fidelity" would each hold a slice of the same
  // position and the total would be right only by accident.
  let { accounts } = addAccount([], 'Fidelity');
  assert.strictEqual(accounts.length, 1);
  const again = addAccount(accounts, 'fidelity');
  assert.strictEqual(again.accounts.length, 1);
  assert.strictEqual(again.added, false);
  assert.strictEqual(again.account.name, 'Fidelity', 'the original label should win');
});

test('a blank account name is refused', () => {
  const result = addAccount([{ id: 'a', name: 'A' }], '   ');
  assert.strictEqual(result.added, false);
  assert.strictEqual(result.account, null);
  assert.strictEqual(result.accounts.length, 1);
});

test('addAccount does not mutate the list it was given', () => {
  const original = [];
  addAccount(original, 'Fidelity');
  assert.strictEqual(original.length, 0);
});

/* ------------------------------------------------------------------- totals */

test('the displayed total is the sum across every account', () => {
  const lots = {
    FXAIX: { fidelity: 900.5, 'u-s-bank': 99.5 },
    MSFT: { fidelity: 10 },
  };
  assert.deepStrictEqual(totalsFromLots(lots), { FXAIX: 1000, MSFT: 10 });
});

test('empty, zero and negative counts do not create a position', () => {
  // A symbol emptied everywhere must disappear, not linger as a row of $0.00.
  const lots = { FXAIX: { fidelity: 0, 'u-s-bank': -5 }, MSFT: {} };
  assert.deepStrictEqual(totalsFromLots(lots), {});
  assert.deepStrictEqual(totalsFromLots({}), {});
  assert.deepStrictEqual(totalsFromLots(null), {});
});

test('a non-numeric share count is ignored rather than poisoning the total', () => {
  const lots = { FXAIX: { fidelity: 100, 'u-s-bank': 'lots' } };
  assert.deepStrictEqual(totalsFromLots(lots), { FXAIX: 100 });
});

/* ---------------------------------------------------------------- one cell */

test('typing into one account leaves the others alone', () => {
  const before = { FXAIX: { fidelity: 900, 'u-s-bank': 100 } };
  const after = setLot(before, 'FXAIX', 'u-s-bank', 120);
  assert.deepStrictEqual(after.FXAIX, { fidelity: 900, 'u-s-bank': 120 });
  assert.deepStrictEqual(before.FXAIX, { fidelity: 900, 'u-s-bank': 100 },
    'setLot must not mutate its input');
});

test('clearing a field removes that account, and the symbol once it is empty', () => {
  const before = { FXAIX: { fidelity: 900, 'u-s-bank': 100 }, MSFT: { fidelity: 5 } };
  const one = setLot(before, 'FXAIX', 'u-s-bank', '');
  assert.deepStrictEqual(one.FXAIX, { fidelity: 900 });
  const none = setLot(one, 'FXAIX', 'fidelity', 0);
  assert.ok(!('FXAIX' in none), 'a symbol held nowhere should not survive');
  assert.deepStrictEqual(none.MSFT, { fidelity: 5 });
});

test('a symbol never held before can be filled in', () => {
  const after = setLot({}, 'MSFT', 'fidelity', 12);
  assert.deepStrictEqual(after, { MSFT: { fidelity: 12 } });
});

/* -------------------------------------------------------------- sync/import */

test('a sync replaces its own account and no other', () => {
  const before = { FXAIX: { fidelity: 900, 'u-s-bank': 100 }, MSFT: { fidelity: 10 } };
  const { lots, kept } = replaceAccountLots(before, 'fidelity', { FXAIX: 950, MSFT: 11 },
    ['FXAIX', 'MSFT']);
  assert.strictEqual(kept, 2);
  assert.deepStrictEqual(lots.FXAIX, { 'u-s-bank': 100, fidelity: 950 });
  assert.deepStrictEqual(lots.MSFT, { fidelity: 11 });
});

test('a position sold at one institution disappears from it', () => {
  // The whole point of replacing rather than merging: "sold" arrives as an
  // absence, and an absence cannot overwrite anything.
  const before = { FXAIX: { fidelity: 900, 'u-s-bank': 100 }, MSFT: { fidelity: 10 } };
  const { lots } = replaceAccountLots(before, 'fidelity', { FXAIX: 900 }, ['FXAIX', 'MSFT']);
  assert.ok(!('MSFT' in lots), 'MSFT was not in the sync, so Fidelity no longer holds it');
  assert.deepStrictEqual(lots.FXAIX, { 'u-s-bank': 100, fidelity: 900 });
});

test('an untracked ticker in the file is skipped', () => {
  const { lots, kept } = replaceAccountLots({}, 'fidelity', { FXAIX: 900, TSLA: 5 },
    ['FXAIX', 'MSFT']);
  assert.strictEqual(kept, 1);
  assert.deepStrictEqual(lots, { FXAIX: { fidelity: 900 } });
});

test('symbols are matched case-insensitively', () => {
  const { lots } = replaceAccountLots({}, 'fidelity', { fxaix: 900 }, ['FXAIX']);
  assert.deepStrictEqual(lots, { FXAIX: { fidelity: 900 } });
});

test('an import matching nothing reports zero so the caller can refuse it', () => {
  // Caller contract: kept === 0 means do not save. Wiping a good account
  // because a CSV had the wrong column headings would be silent data loss.
  const before = { FXAIX: { fidelity: 900 } };
  const { kept } = replaceAccountLots(before, 'fidelity', { TSLA: 5 }, ['FXAIX']);
  assert.strictEqual(kept, 0);
});

test('replaceAccountLots does not mutate its input', () => {
  const before = { FXAIX: { fidelity: 900, 'u-s-bank': 100 } };
  replaceAccountLots(before, 'fidelity', { FXAIX: 1 }, ['FXAIX']);
  assert.deepStrictEqual(before, { FXAIX: { fidelity: 900, 'u-s-bank': 100 } });
});

/* ------------------------------------------------------------------ removal */

test('removing an account forgets its shares but keeps everyone else', () => {
  const accounts = [{ id: 'fidelity', name: 'Fidelity' }, { id: 'u-s-bank', name: 'U.S. Bank' }];
  const lots = { FXAIX: { fidelity: 900, 'u-s-bank': 100 }, MSFT: { fidelity: 10 } };
  const after = removeAccount(accounts, lots, 'fidelity');
  assert.deepStrictEqual(after.accounts, [{ id: 'u-s-bank', name: 'U.S. Bank' }]);
  assert.deepStrictEqual(after.lots, { FXAIX: { 'u-s-bank': 100 } });
  assert.deepStrictEqual(totalsFromLots(after.lots), { FXAIX: 100 });
});

/* ---------------------------------------------------------- sync identity */

test('a provider that re-words its label renames its account, it does not fork', () => {
  // SnapTrade reports the brokerage name for one connection and something else
  // entirely once a second is linked; the Plaid institution lookup is
  // best-effort and falls back to "Bank sync". Keying storage off that string
  // created a second bucket, and because buckets are replaced independently the
  // stale one was never reconciled - so the position silently doubled.
  let accounts = [];
  ({ accounts } = syncAccount(accounts, 'snaptrade', 'Fidelity'));
  const second = syncAccount(accounts, 'snaptrade', 'Fidelity + U.S. Bank');
  assert.strictEqual(second.accounts.length, 1, 'a re-worded label forked the account');
  assert.strictEqual(second.account.id, 'fidelity', 'the storage key must not move');
  assert.strictEqual(second.account.name, 'Fidelity + U.S. Bank',
    'the display name should follow the provider');
});

test('two different providers reporting one institution share a bucket', () => {
  // Two rails onto the same brokerage are reporting the same shares. Forking
  // would double-count them, which is worse than either rail winning outright.
  let accounts = [];
  ({ accounts } = syncAccount(accounts, 'plaid', 'Fidelity'));
  const snap = syncAccount(accounts, 'snaptrade', 'Fidelity');
  assert.strictEqual(snap.accounts.length, 1);
  assert.strictEqual(snap.account.id, 'fidelity');
});

test('a sync adopts the account the user already made by hand', () => {
  // Otherwise setting up "Fidelity", typing the split, then syncing would
  // shadow it with a second bucket holding the same shares.
  const manual = addAccount([], 'Fidelity').accounts;
  const result = syncAccount(manual, 'snaptrade', 'Fidelity');
  assert.strictEqual(result.accounts.length, 1);
  assert.strictEqual(result.account.id, 'fidelity');
  assert.strictEqual(result.account.provider, 'snaptrade');
  assert.ok(!result.created, 'adopting an existing account is not creating one');
});

test('a genuinely new account is flagged as created', () => {
  const first = syncAccount([], 'snaptrade', 'Fidelity');
  assert.ok(first.created, 'the first sync must report that it made an account');
});

test('an aggregate sync landing beside existing accounts names what may double', () => {
  // "Fidelity + U.S. Bank" against hand-made "Fidelity" and "U.S. Bank" is
  // indistinguishable from a genuinely third institution, so say so rather
  // than guess.
  const lots = { FXAIX: { fidelity: 900, 'u-s-bank': 100 }, MSFT: { fidelity: 10 } };
  assert.deepStrictEqual(
    overlappingSymbols(lots, 'fidelity-u-s-bank', { FXAIX: 1000, MSFT: 10 }),
    ['FXAIX', 'MSFT']);
  // Shares already in the target account are being replaced, not added.
  assert.deepStrictEqual(overlappingSymbols(lots, 'fidelity', { MSFT: 10 }), []);
  assert.deepStrictEqual(overlappingSymbols({}, 'fidelity', { MSFT: 10 }), []);
});

test('a provider with no usable label still gets a stable account', () => {
  const first = syncAccount([], 'plaid', '');
  const second = syncAccount(first.accounts, 'plaid', null);
  assert.strictEqual(second.accounts.length, 1);
  assert.strictEqual(first.account.id, second.account.id);
});

test('syncAccount does not mutate the list it was given', () => {
  const original = [{ id: 'fidelity', name: 'Fidelity', provider: 'snaptrade' }];
  syncAccount(original, 'snaptrade', 'Something Else');
  assert.strictEqual(original[0].name, 'Fidelity');
});

test('two different names that slug alike still get separate ids', () => {
  const accounts = [{ id: 'fidelity', name: 'Fidelity' }];
  assert.strictEqual(uniqueAccountId(accounts, 'Fidelity'), 'fidelity-2');
  assert.strictEqual(uniqueAccountId(accounts, 'U.S. Bank'), 'u-s-bank');
  assert.strictEqual(uniqueAccountId([], 'Fidelity'), 'fidelity');
});

test('re-wording a label cannot double a position', () => {
  // The end-to-end shape of the bug, in the terms the user would see it.
  let accounts = [];
  let lots = {};
  const sync = (label, holdings) => {
    const resolved = syncAccount(accounts, 'snaptrade', label);
    accounts = resolved.accounts;
    ({ lots } = replaceAccountLots(lots, resolved.account.id, holdings, ['FXAIX', 'MSFT']));
  };
  sync('Fidelity', { FXAIX: 900, MSFT: 100 });
  assert.deepStrictEqual(totalsFromLots(lots), { FXAIX: 900, MSFT: 100 });
  sync('Fidelity + U.S. Bank', { FXAIX: 1000, MSFT: 100 });
  assert.deepStrictEqual(totalsFromLots(lots), { FXAIX: 1000, MSFT: 100 },
    'the re-worded sync was added to the old one instead of replacing it');
});

/* ---------------------------------------------------------------- migration */


test('existing share counts survive the move to per-account storage', () => {
  const migrated = migrateHoldings({ MSFT: 7885.97, FXAIX: 1000 },
    { at: '2026-01-01T00:00:00Z', source: 'Fidelity' });
  assert.deepStrictEqual(migrated.accounts, [{ id: 'fidelity', name: 'Fidelity' }]);
  assert.deepStrictEqual(totalsFromLots(migrated.lots), { MSFT: 7885.97, FXAIX: 1000 });
});

test('holdings with no recorded source land under a plainly labelled account', () => {
  const migrated = migrateHoldings({ MSFT: 10 }, { at: null, source: null });
  assert.strictEqual(migrated.accounts[0].name, 'Manual entry');
  assert.deepStrictEqual(totalsFromLots(migrated.lots), { MSFT: 10 });
});

test('a fresh install is not given a phantom account', () => {
  assert.strictEqual(migrateHoldings({}, {}), null);
  assert.strictEqual(migrateHoldings(null, null), null);
  assert.strictEqual(migrateHoldings({ MSFT: 0 }, {}), null);
});

/* -------------------------------------------------------------- reconciling */

test('an untouched split is left exactly alone', () => {
  // The normal case on every boot: the flat map is this build's own mirror, so
  // nothing disagrees and nothing may move.
  const lots = { FXAIX: { fidelity: 900, 'u-s-bank': 100 }, MSFT: { fidelity: 10 } };
  const result = reconcileFlatHoldings(lots, { FXAIX: 1000, MSFT: 10 }, 'fidelity');
  assert.strictEqual(result.changed, 0);
  assert.deepStrictEqual(result.lots, lots);
});

test('an edit made by an older build is recovered, not discarded', () => {
  // An older build knows only the flat map. Overwriting it from the stale lots
  // would silently throw the edit away.
  const lots = { FXAIX: { fidelity: 900, 'u-s-bank': 100 }, MSFT: { fidelity: 10 } };
  const result = reconcileFlatHoldings(lots, { FXAIX: 1000, MSFT: 25 }, 'fidelity');
  assert.strictEqual(result.changed, 1);
  assert.deepStrictEqual(totalsFromLots(result.lots), { FXAIX: 1000, MSFT: 25 });
  assert.deepStrictEqual(result.lots.FXAIX, { fidelity: 900, 'u-s-bank': 100 },
    'a symbol nobody touched must keep its split');
});

test('a symbol added by an older build appears', () => {
  const result = reconcileFlatHoldings({ MSFT: { fidelity: 10 } },
    { MSFT: 10, FSKAX: 42 }, 'fidelity');
  assert.deepStrictEqual(totalsFromLots(result.lots), { MSFT: 10, FSKAX: 42 });
});

test('a symbol deleted by an older build goes away', () => {
  const result = reconcileFlatHoldings({ MSFT: { fidelity: 10 }, FSKAX: { fidelity: 42 } },
    { MSFT: 10 }, 'fidelity');
  assert.deepStrictEqual(totalsFromLots(result.lots), { MSFT: 10 });
});

test('a recovered edit collapses only the symbol it touched', () => {
  const lots = { FXAIX: { fidelity: 900, 'u-s-bank': 100 } };
  const result = reconcileFlatHoldings(lots, { FXAIX: 1200 }, 'fidelity');
  assert.deepStrictEqual(result.lots.FXAIX, { fidelity: 1200 },
    'the flat map cannot say which account changed, so one bucket is the honest answer');
  assert.deepStrictEqual(lots.FXAIX, { fidelity: 900, 'u-s-bank': 100 },
    'reconcileFlatHoldings must not mutate its input');
});

/* ------------------------------------------------------------- the scenario */

test('splitting FXAIX across two institutions survives syncing one of them', () => {
  // The reason this feature exists. Fidelity holds most of the FXAIX and U.S.
  // Bank holds the rest; syncing Fidelity must not report the total as
  // whatever Fidelity alone happens to hold.
  let accounts = [];
  ({ accounts } = addAccount(accounts, 'Fidelity'));
  ({ accounts } = addAccount(accounts, 'U.S. Bank'));

  let lots = {};
  lots = setLot(lots, 'FXAIX', 'fidelity', 900);
  lots = setLot(lots, 'FXAIX', 'u-s-bank', 100);
  assert.deepStrictEqual(totalsFromLots(lots), { FXAIX: 1000 });

  // Fidelity reports its own 925 shares after a reinvestment.
  ({ lots } = replaceAccountLots(lots, 'fidelity', { FXAIX: 925 }, ['FXAIX']));
  assert.deepStrictEqual(totalsFromLots(lots), { FXAIX: 1025 },
    'the U.S. Bank shares were lost by a Fidelity sync');
});

/* ------------------------------------------------ explaining an empty sync */

const TRACKED = ['MSFT', 'FXAIX', 'FSKAX'];

test('an empty sync names both what arrived and what is tracked', () => {
  const msg = unmatchedMessage({ NVDA: 5, VTI: 10 }, 'Fidelity', TRACKED);
  assert.match(msg, /MSFT, FXAIX, FSKAX/, 'the tracked symbols are not named');
  assert.match(msg, /NVDA, VTI/, 'the symbols that actually arrived are not named');
  assert.match(msg, /Fidelity/);
  assert.match(msg, /Nothing was changed/, 'it must say the page was left alone');
});

test('the real Plaid sandbox payload explains itself', () => {
  // Verbatim from sandbox First Platypus Bank via /investments/holdings/get.
  // Sandbox credentials can only ever reach Plaid's fake banks, so this is the
  // message the page shows for every sandbox sync - it has to be informative
  // rather than look like a failure.
  const sandbox = {
    ACHN: 1, DBLTX: 2, NFLX180201C00355000: 10000, BTC: 0.00293644,
    EWZ: 5, MIPTX: 23.567, NHX105509: 100.05, CAMYX: 75.75, SBSI: 213,
  };
  const msg = unmatchedMessage(sandbox, 'First Platypus Bank', TRACKED);
  assert.match(msg, /9 position\(s\)/, 'the count of what arrived is wrong');
  assert.match(msg, /MSFT, FXAIX, FSKAX/);
  assert.match(msg, /and 3 more/, 'a long list must be truncated with a count');
  assert.ok(msg.length < 320, 'the status line must stay readable: ' + msg.length);
});

test('a long list is truncated but a short one is shown whole', () => {
  const six = { AAA: 1, BBB: 1, CCC: 1, DDD: 1, EEE: 1, FFF: 1 };
  assert.doesNotMatch(unmatchedMessage(six, 'X', TRACKED), /more/,
    'exactly six symbols should not be truncated');
  const seven = { ...six, GGG: 1 };
  assert.match(unmatchedMessage(seven, 'X', TRACKED), /and 1 more/);
});

test('an account holding nothing at all does not claim to have reported symbols', () => {
  const msg = unmatchedMessage({}, 'Empty Brokerage', TRACKED);
  assert.match(msg, /0 position\(s\)/);
  assert.doesNotMatch(msg, /It reported/, 'there was nothing to report');
});

test('the SnapTrade context is folded into the sentence', () => {
  const msg = unmatchedMessage({ NVDA: 1 }, 'SnapTrade', TRACKED, 'across 2 account(s)');
  assert.match(msg, /SnapTrade across 2 account\(s\), but none/);
});

/* --------------------------------------- several institutions in one sync */

const T3 = ['MSFT', 'FXAIX', 'FSKAX'];

test('the worker multi-institution shape is used when present', () => {
  const conns = connectionsFrom({
    connections: [
      { institution: 'Fidelity', holdings: { MSFT: 100 } },
      { institution: 'U.S. Bank', holdings: { FXAIX: 100 } },
    ],
    holdings: { MSFT: 100, FXAIX: 100 },
  }, 'fallback');
  assert.strictEqual(conns.length, 2, 'the merged map was used instead of the split one');
  assert.strictEqual(conns[1].institution, 'U.S. Bank');
});

test('an older worker returning one merged map still works', () => {
  // A page updated before the worker, or vice versa; neither may assume the
  // other has been deployed.
  const conns = connectionsFrom({ holdings: { MSFT: 100 }, institution: 'Fidelity' }, 'fallback');
  assert.deepStrictEqual(conns, [{ institution: 'Fidelity', holdings: { MSFT: 100 } }]);
});

test('a payload with no holdings at all yields nothing to apply', () => {
  assert.deepStrictEqual(connectionsFrom({}, 'x'), []);
  assert.deepStrictEqual(connectionsFrom(null, 'x'), []);
  assert.deepStrictEqual(connectionsFrom({ connections: [] }, 'x'), []);
});

test('the fallback label is used only when the payload names nothing', () => {
  assert.strictEqual(connectionsFrom({ holdings: { MSFT: 1 } }, 'Bank sync')[0].institution, 'Bank sync');
  assert.strictEqual(connectionsFrom({ holdings: { MSFT: 1 }, institution: 'Real' }, 'Bank sync')[0].institution, 'Real');
});

test('a multi-institution sync names each institution and its count', () => {
  const summary = {
    applied: [{ label: 'Fidelity', kept: 2 }, { label: 'U.S. Bank', kept: 1 }],
    empty: [], total: 3, count: 2,
  };
  const { text, ok } = describeSync(summary, T3);
  assert.ok(ok);
  assert.match(text, /Fidelity \(2\)/);
  assert.match(text, /U\.S\. Bank \(1\)/);
  assert.match(text, /3 position\(s\)/);
});

test('an institution that reported nothing tracked is still named', () => {
  // Silence would look like it was never contacted, when it did answer.
  const summary = {
    applied: [{ label: 'Fidelity', kept: 2 }],
    empty: [{ label: 'U.S. Bank', holdings: { NVDA: 5 } }],
    total: 2, count: 2,
  };
  const { text, ok } = describeSync(summary, T3);
  assert.ok(ok, 'a partial success is still a success');
  assert.match(text, /Fidelity \(2\)/);
  assert.match(text, /U\.S\. Bank reported nothing tracked/);
});

test('when a single institution matches nothing, the detailed message is used', () => {
  const summary = { applied: [], empty: [{ label: 'First Platypus Bank', holdings: { ACHN: 1, BTC: 2 } }], total: 0, count: 1 };
  const { text, ok } = describeSync(summary, T3);
  assert.strictEqual(ok, false);
  assert.match(text, /ACHN/, 'the single-institution case should still list what arrived');
  assert.match(text, /MSFT, FXAIX, FSKAX/);
});

test('when several institutions all match nothing, all are named', () => {
  const summary = {
    applied: [],
    empty: [{ label: 'Fidelity', holdings: { NVDA: 1 } }, { label: 'U.S. Bank', holdings: { VTI: 2 } }],
    total: 0, count: 2,
  };
  const { text, ok } = describeSync(summary, T3);
  assert.strictEqual(ok, false);
  assert.match(text, /Fidelity, U\.S\. Bank/);
  assert.match(text, /Nothing was changed/);
});

test('the verb is caller-chosen so a refresh does not claim to be a first sync', () => {
  const summary = { applied: [{ label: 'Fidelity', kept: 1 }], empty: [], total: 1, count: 1 };
  assert.match(describeSync(summary, T3, 'Refreshed').text, /^Refreshed/);
  assert.match(describeSync(summary, T3).text, /^Synced/);
});

test('two institutions on one provider get different account buckets', () => {
  // The bug this whole change exists to prevent: pinning both to the bare
  // provider string made the second overwrite the first.
  let accounts = [];
  const a = syncAccount(accounts, 'plaid:ins_1', 'Fidelity');
  const b = syncAccount(a.accounts, 'plaid:ins_2', 'U.S. Bank');
  assert.strictEqual(b.accounts.length, 2, 'the second institution reused the first bucket');
  assert.notStrictEqual(a.account.id, b.account.id);

  let lots = {};
  ({ lots } = replaceAccountLots(lots, a.account.id, { FXAIX: 900.512, MSFT: 100 }, T3));
  ({ lots } = replaceAccountLots(lots, b.account.id, { FXAIX: 100 }, T3));
  assert.deepStrictEqual(totalsFromLots(lots), { FXAIX: 1000.512, MSFT: 100 },
    'syncing both institutions did not preserve both sets of shares');
});

test('re-wording one institution does not fork it away from the other', () => {
  let accounts = [];
  accounts = syncAccount(accounts, 'plaid:ins_1', 'Fidelity').accounts;
  accounts = syncAccount(accounts, 'plaid:ins_2', 'U.S. Bank').accounts;
  const again = syncAccount(accounts, 'plaid:ins_1', 'Fidelity Investments');
  assert.strictEqual(again.accounts.length, 2, 'a re-wording created a third account');
  // `created` is set only when an account is actually added, and every caller
  // tests it for truthiness, so absent and false mean the same thing here.
  assert.ok(!again.created, 'a re-wording should not report a new account');
  assert.strictEqual(again.account.name, 'Fidelity Investments', 'the label should update in place');
});

/* ------------------------------------- accounts left out of spendable income */

test('skipped retirement accounts are named, not silently dropped', () => {
  // A Fidelity login covers nine accounts and reports shares from three. An
  // unexplained shortfall reads as a bug; a named one reads as a decision.
  const note = describeSkipped([
    { name: 'ROTH IRA', kind: 'sheltered' },
    { name: 'Health Savings Account', kind: 'sheltered' },
  ]);
  assert.match(note, /ROTH IRA/);
  assert.match(note, /Health Savings Account/);
  assert.match(note, /spendable/, 'the note must say why they were left out');
});

test('cards and chequing accounts are not mentioned', () => {
  // They hold no positions to begin with, so listing them is noise.
  const note = describeSkipped([
    { name: 'Rewards Visa', kind: 'credit' },
    { name: 'Robinhood Checking', kind: 'deposit' },
  ]);
  assert.strictEqual(note, '');
});

test('nothing skipped means nothing said', () => {
  assert.strictEqual(describeSkipped([]), '');
  assert.strictEqual(describeSkipped(null), '');
  assert.strictEqual(describeSkipped(undefined), '');
});

test('a long list of skipped accounts is truncated with a count', () => {
  const note = describeSkipped(
    ['401(k)', 'Roth IRA', 'HSA', 'Traditional IRA', 'Deferred Comp']
      .map((name) => ({ name, kind: 'sheltered' })));
  assert.match(note, /401\(k\), Roth IRA, HSA/);
  assert.match(note, /and 2 more/);
  assert.ok(note.length < 260, 'the status line must stay readable: ' + note.length);
});

test('SnapTrade reports skipped accounts once for the whole read', () => {
  const payload = { skipped: [{ name: 'ROTH IRA', kind: 'sheltered' }], connections: [] };
  assert.deepStrictEqual(skippedFrom(payload), [{ name: 'ROTH IRA', kind: 'sheltered' }]);
});

test('Plaid reports them per connection, since each Item is one institution', () => {
  const payload = {
    connections: [
      { institution: 'Fidelity', skipped: [{ name: 'ROTH IRA', kind: 'sheltered' }] },
      { institution: 'U.S. Bank', skipped: [{ name: 'IRA', kind: 'sheltered' }] },
    ],
  };
  assert.strictEqual(skippedFrom(payload).length, 2,
    'a second institution\u2019s skipped accounts were lost');
});

test('a payload with nothing skipped yields an empty list', () => {
  assert.deepStrictEqual(skippedFrom({ connections: [{ institution: 'X' }] }), []);
  assert.deepStrictEqual(skippedFrom({}), []);
  assert.deepStrictEqual(skippedFrom(null), []);
});

test('the sync sentence and the skipped note read as one message', () => {
  const summary = { applied: [{ label: 'Fidelity', kept: 3 }], empty: [], total: 3, count: 1 };
  const text = describeSync(summary, ['MSFT', 'FXAIX', 'FSKAX']).text
    + describeSkipped([{ name: 'ROTH IRA', kind: 'sheltered' }]);
  assert.match(text, /^Synced 3 position\(s\) from Fidelity \(3\)\. Not counted: ROTH IRA/);
});

test('an all-retirement login is not reported as a failed sync', () => {
  // Plaid's stock sandbox is exactly this: every holding sits in an IRA or a
  // 401(k). "0 positions matched" would read as broken rather than filtered.
  const { text, ok } = describeSync(
    { applied: [], empty: [{ label: 'First Platypus Bank', holdings: {} }], total: 0, count: 1 },
    T3, 'Synced',
    [{ name: 'Plaid IRA', kind: 'sheltered' }, { name: 'Plaid 401k', kind: 'sheltered' }]);
  assert.strictEqual(ok, false);
  assert.match(text, /retirement or health account/);
  assert.match(text, /Plaid IRA, Plaid 401k/, 'the accounts must be named');
  assert.doesNotMatch(text, /0 position/, 'reporting zero positions hides the real cause');
});

test('a genuine mismatch keeps the detailed wording', () => {
  // Something WAS held, it just was not tracked. Different situation, and the
  // shelter wording would be a lie about the cause.
  const { text } = describeSync(
    { applied: [], empty: [{ label: 'Fidelity', holdings: { NVDA: 5, VTI: 2 } }], total: 0, count: 1 },
    T3, 'Synced', [{ name: 'ROTH IRA', kind: 'sheltered' }]);
  assert.match(text, /NVDA, VTI/, 'it should still list what actually arrived');
  assert.doesNotMatch(text, /retirement or health account/,
    'the shelter wording must not be used when real positions were found');
});

test('skipped cards alone never trigger the retirement wording', () => {
  const { text } = describeSync(
    { applied: [], empty: [{ label: 'Robinhood', holdings: {} }], total: 0, count: 1 },
    T3, 'Synced', [{ name: 'Robinhood Credit Card', kind: 'credit' }]);
  assert.doesNotMatch(text, /retirement or health/);
});
