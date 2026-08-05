/*
 * Tests for the bank balances page.
 *
 * The parts worth testing here are the ones where a plausible-looking answer is
 * wrong in a way nobody would notice on screen: a Canadian chequing account
 * silently added to a US one, an amount owed counted as an amount held, or a
 * reading from last week presented as if it were current.
 *
 * `describeAccount` lives in the worker and the display helpers live in the
 * page, but they are two halves of one number, so they are tested together.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { describeAccount, linkScope } from '../worker/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The page is a plain script the browser loads with a <script> tag, so it is
// CommonJS and has to be pulled in the CommonJS way.
const require = createRequire(import.meta.url);
const {
  normalizePassphrase, groupOf, totalByCurrency, formatTotals, formatOwed,
  describeAge, money, GROUPS,
} = require('../docs/balances.js');

/* ------------------------------------------------------------- grouping */

test('a chequing account is cash', () => {
  assert.strictEqual(groupOf({ type: 'depository', subtype: 'chequing' }), 'depository');
});

test('a credit card and a mortgage both count as owed', () => {
  assert.strictEqual(groupOf({ type: 'credit' }), 'credit');
  assert.strictEqual(groupOf({ type: 'loan' }), 'credit');
});

test('a TFSA held at a bank is an investment, not cash', () => {
  assert.strictEqual(groupOf({ type: 'investment', subtype: 'tfsa' }), 'investment');
});

test('type is matched case-insensitively, because Plaid is not consistent', () => {
  assert.strictEqual(groupOf({ type: 'Depository' }), 'depository');
  assert.strictEqual(groupOf({ type: 'CREDIT' }), 'credit');
});

test('an unrecognised type still lands somewhere rather than vanishing', () => {
  assert.strictEqual(groupOf({ type: 'annuity' }), 'other');
  assert.strictEqual(groupOf({}), 'other');
  assert.strictEqual(groupOf(null), 'other');
});

test('every group has a label, so no heading can render blank', () => {
  for (const g of GROUPS) assert.ok(g.label, `group ${g.id} has no label`);
});

/* ------------------------------------------------------- currency safety */

test('two currencies are never added together', () => {
  const totals = totalByCurrency([
    { current: 100, currency: 'CAD' },
    { current: 50, currency: 'USD' },
    { current: 25, currency: 'CAD' },
  ]);
  assert.deepStrictEqual(
    totals.sort((a, b) => a.currency.localeCompare(b.currency)),
    [{ currency: 'CAD', amount: 125 }, { currency: 'USD', amount: 50 }],
  );
});

test('a mixed-currency total is shown as both, not as one number', () => {
  const text = formatTotals([{ currency: 'CAD', amount: 125 }, { currency: 'USD', amount: 50 }]);
  assert.ok(text.includes('+'), `expected two amounts, got ${text}`);
  assert.ok(/125/.test(text) && /50/.test(text), text);
});

test('an account with no balance is skipped rather than counted as zero', () => {
  const totals = totalByCurrency([
    { current: 100, currency: 'CAD' },
    { current: null, currency: 'CAD' },
    { currency: 'CAD' },
  ]);
  assert.deepStrictEqual(totals, [{ currency: 'CAD', amount: 100 }]);
});

test('a missing currency code is assumed Canadian on a Canadian banks page', () => {
  assert.deepStrictEqual(totalByCurrency([{ current: 10 }]), [{ currency: 'CAD', amount: 10 }]);
});

test('nothing at all reads as an em dash, not as $0.00', () => {
  assert.strictEqual(formatTotals([]), '—');
  assert.deepStrictEqual(totalByCurrency([]), []);
  assert.deepStrictEqual(totalByCurrency(null), []);
});

test('an amount owed pulls the total down', () => {
  const totals = totalByCurrency([
    { current: 1000, currency: 'CAD' },
    { current: -250, currency: 'CAD' },
  ]);
  assert.deepStrictEqual(totals, [{ currency: 'CAD', amount: 750 }]);
});

test('a heading that already says "Owed" does not also show a minus sign', () => {
  // "Owed -$253,988.12" reads as though the bank owes you.
  const owed = totalByCurrency([{ current: -410, currency: 'CAD' }, { current: -56302.06, currency: 'CAD' }]);
  const text = formatOwed(owed);
  assert.ok(!/-|\u2212/.test(text), `expected no minus under an Owed label, got ${text}`);
  assert.ok(/56,712\.06/.test(text), text);
});

test('the Owed heading agrees with the rows underneath it', () => {
  // The rows drop the sign; if the heading kept it the two would contradict.
  assert.strictEqual(formatOwed(totalByCurrency([{ current: -100, currency: 'CAD' }])),
    formatTotals(totalByCurrency([{ current: 100, currency: 'CAD' }])));
});

test('a card paid off to zero is still shown as zero, not as an em dash', () => {
  assert.ok(/0\.00/.test(formatOwed(totalByCurrency([{ current: 0, currency: 'CAD' }]))));
});

/* --------------------------------------------------------- credit signing */

test('a card balance arrives positive from Plaid and is stored as owed', () => {
  const out = describeAccount({
    account_id: 'a1',
    name: 'Visa Infinite',
    type: 'credit',
    subtype: 'credit card',
    balances: {
      current: 842.19, available: 4157.81, limit: 5000, iso_currency_code: 'CAD',
    },
  });
  assert.strictEqual(out.current, -842.19, 'a card you owe on must not read as money you have');
  assert.strictEqual(out.limit, 5000, 'a limit is not a balance and must not be negated');
});

test('a mortgage is owed too', () => {
  const out = describeAccount({
    account_id: 'a2',
    name: 'Mortgage',
    type: 'loan',
    balances: { current: 312000, iso_currency_code: 'CAD' },
  });
  assert.strictEqual(out.current, -312000);
});

test('a chequing balance is left exactly as it came', () => {
  const out = describeAccount({
    account_id: 'a3',
    name: 'Everyday Chequing',
    type: 'depository',
    subtype: 'chequing',
    balances: { current: 2410.55, available: 2410.55, iso_currency_code: 'CAD' },
  });
  assert.strictEqual(out.current, 2410.55);
  assert.strictEqual(out.available, 2410.55);
});

test('a missing balance stays null rather than becoming minus zero', () => {
  const out = describeAccount({
    account_id: 'a4', name: 'New Card', type: 'credit', balances: { current: null },
  });
  assert.strictEqual(out.current, null);
  assert.strictEqual(out.available, null);
});

test('a currency in the unofficial field is still reported', () => {
  const out = describeAccount({
    account_id: 'a5',
    name: 'x',
    type: 'depository',
    balances: { current: 1, unofficial_currency_code: 'CAD' },
  });
  assert.strictEqual(out.currency, 'CAD');
});

test('an account with no name at all still has something to display', () => {
  const out = describeAccount({ account_id: 'a6', type: 'depository', balances: {} });
  assert.ok(out.name, 'a nameless account would render as an empty row');
});

test('the sign the worker applies is the sign the page groups on', () => {
  // The two halves have to agree, or an amount owed shows under "Cash".
  const card = describeAccount({
    account_id: 'a7', name: 'Visa', type: 'credit', balances: { current: 100, iso_currency_code: 'CAD' },
  });
  assert.strictEqual(groupOf(card), 'credit');
  assert.ok(card.current < 0, 'grouped as owed but signed as held');
});

/* ------------------------------------------------------------------- age */

test('a fresh reading does not claim to be from the future', () => {
  assert.strictEqual(describeAge(0), 'just now');
  assert.strictEqual(describeAge(30 * 1000), 'just now');
});

test('ages read as English, singular and plural', () => {
  assert.strictEqual(describeAge(60 * 1000), 'a minute ago');
  assert.strictEqual(describeAge(5 * 60 * 1000), '5 minutes ago');
  assert.strictEqual(describeAge(60 * 60 * 1000), 'an hour ago');
  assert.strictEqual(describeAge(5 * 60 * 60 * 1000), '5 hours ago');
  assert.strictEqual(describeAge(24 * 60 * 60 * 1000), 'yesterday');
  assert.strictEqual(describeAge(3 * 24 * 60 * 60 * 1000), '3 days ago');
});

test('an age is never rounded up into the next unit', () => {
  // Half an hour must not read as "an hour ago"; a balance that looks older
  // than it is invites a pointless re-sync, and one that looks fresher than it
  // is invites spending money that is not there.
  assert.strictEqual(describeAge(31 * 60 * 1000), '31 minutes ago');
  assert.strictEqual(describeAge(59 * 60 * 1000), '59 minutes ago');
  assert.strictEqual(describeAge(90 * 60 * 1000), 'an hour ago');
  assert.strictEqual(describeAge(23 * 60 * 60 * 1000), '23 hours ago');
  assert.strictEqual(describeAge(36 * 60 * 60 * 1000), 'yesterday');
});

test('never having synced says so, rather than showing an age of zero', () => {
  assert.strictEqual(describeAge(null), 'never');
  assert.strictEqual(describeAge(undefined), 'never');
});

/* ----------------------------------------------------------------- money */

test('an amount is shown to the cent', () => {
  assert.ok(/1,234\.50/.test(money(1234.5, 'CAD')), money(1234.5, 'CAD'));
  assert.ok(/0\.00/.test(money(0, 'CAD')), money(0, 'CAD'));
});

test('a nonsense currency code still renders an amount rather than throwing', () => {
  const text = money(12.5, 'NOT-A-CURRENCY');
  assert.ok(/12\.50/.test(text), text);
});

test('a missing amount is an em dash, never NaN on screen', () => {
  assert.strictEqual(money(null, 'CAD'), '—');
  assert.strictEqual(money(NaN, 'CAD'), '—');
  assert.strictEqual(money(Infinity, 'CAD'), '—');
  assert.strictEqual(money('1200', 'CAD'), '—');
});

/* ------------------------------------------------------------ passphrase */
test('the balances page folds a passphrase exactly as the tracker does', () => {
  const straight = normalizePassphrase("It's a lovely day, isn't it?");
  const curly = normalizePassphrase('It\u2019s a lovely day, isn\u2019t it?');
  assert.strictEqual(curly, straight, 'an iPhone curly apostrophe must not lock you out');
  assert.strictEqual(normalizePassphrase('  ITS A LOVELY DAY ISNT IT  '), straight);
  assert.ok(/^[a-z0-9]+$/.test(straight), `must be header-safe ASCII, got ${straight}`);
});

/* ------------------------------------------------------------------- scope */

test('a link is for holdings unless it explicitly says balances', () => {
  assert.strictEqual(linkScope('balances'), 'balances');
  assert.strictEqual(linkScope('holdings'), 'holdings');
  assert.strictEqual(linkScope(undefined), 'holdings');
  assert.strictEqual(linkScope(''), 'holdings');
  assert.strictEqual(linkScope(null), 'holdings');
});

test('an unknown scope falls back to holdings rather than being trusted', () => {
  // The value arrives in a request body, so it is attacker-controlled in
  // principle and typo-prone in practice. Anything unrecognised must land on
  // the behaviour that existed before scopes did.
  assert.strictEqual(linkScope('BALANCES'), 'holdings');
  assert.strictEqual(linkScope('balance'), 'holdings');
  assert.strictEqual(linkScope({}), 'holdings');
  assert.strictEqual(linkScope(['balances']), 'holdings');
});

test('the balances page asks for the balances scope on both link calls', () => {
  // Getting a link token for `investments` in the US hides every Canadian
  // retail bank from Link's search, so the page looks broken rather than
  // unsupported. Both calls have to agree, or the exchange stores the wrong
  // kind of record and the dividend page starts reporting a phantom failure.
  const js = fs.readFileSync(path.join(__dirname, '..', 'docs', 'balances.js'), 'utf8');
  for (const endpoint of ['/link/token/create', '/link/token/exchange']) {
    const at = js.indexOf(endpoint);
    assert.ok(at > 0, `${endpoint} is never called`);
    const call = js.slice(at, at + 220);
    assert.ok(/scope:\s*'balances'/.test(call), `${endpoint} does not pass the balances scope`);
  }
});

test('the page does not narrow products when reopening a connection', () => {
  // Link only offers accounts supporting EVERY product asked for, so narrowing
  // hides account types rather than revealing them. Asking for `auth` would
  // exclude credit cards, and a card-only connection - a TD Aeroplan Visa with
  // no chequing behind it - would then have nothing selectable at all.
  //
  // Pinned because narrowing to `auth` is a plausible-sounding fix for "my
  // chequing account is missing", and it was briefly shipped as exactly that.
  const js = fs.readFileSync(path.join(__dirname, '..', 'docs', 'balances.js'), 'utf8');
  const at = js.indexOf("'/link/token/update'");
  assert.ok(at > 0, 'the update endpoint is never called');
  const call = js.slice(at, at + 160);
  assert.ok(!/products:/.test(call),
    'reopening narrows the products, which hides accounts rather than revealing them');
});

test('the public token from Link is exchanged, not discarded', () => {  // Plaid Link hands the public token to onSuccess and nothing else. Ignoring
  // it leaves the sign-in looking successful with no connection stored at all,
  // which is silent: the page just shows no accounts afterwards.
  const js = fs.readFileSync(path.join(__dirname, '..', 'docs', 'balances.js'), 'utf8');
  const at = js.indexOf('onSuccess:');
  assert.ok(at > 0, 'onSuccess is never defined');
  const handler = js.slice(at, at + 700);
  assert.ok(/onSuccess:\s*async\s*\(\s*\w+/.test(handler),
    'onSuccess ignores its public_token argument');
  assert.ok(/public_token:/.test(handler), 'onSuccess never exchanges the public token');
});

/* ----------------------------------------------------------------- styling */
test('every class the balances page uses is actually styled', () => {
  // Inventing a class name is silent: the markup renders, just unstyled, and
  // it looks plausible enough in a screenshot to miss. This page shipped with
  // `card-label` when the stylesheet had always called it `label`.
  const dir = path.join(__dirname, '..', 'docs');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const styled = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));

  const used = new Set();
  for (const file of ['balances.html', 'balances.js']) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of text.matchAll(/class="([^"$]*)"/g)) {
      for (const name of m[1].split(/\s+/).filter(Boolean)) used.add(name);
    }
  }

  assert.ok(used.size > 10, `expected to find classes to check, found ${used.size}`);
  const missing = [...used].filter((c) => !styled.has(c));
  assert.deepStrictEqual(missing, [], `not styled in styles.css: ${missing.join(', ')}`);
});
