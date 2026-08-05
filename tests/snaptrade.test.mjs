/*
 * Tests for the SnapTrade client's pure logic.
 *
 * Request signing is the critical part: SnapTrade signs a canonical JSON
 * string, so a byte difference (unsorted keys, a stray space) produces a valid
 * looking signature that the API rejects. Symbol extraction matters almost as
 * much, because SnapTrade nests the ticker differently per account type and a
 * wrong guess silently yields zero holdings rather than an error.
 */
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

import {
  canonicalJson,
  signRequest,
  buildQuery,
  snaptradeConfigured,
  aggregatePositions,
  extractTicker,
  extractUnits,
  describeCard,
  sortCards,
  totalOwed,
} from '../worker/src/snaptrade.js';

test('canonical JSON sorts keys at every level and strips whitespace', () => {
  assert.strictEqual(
    canonicalJson({ path: '/api/v1/symbols', content: null, query: 'a=1' }),
    '{"content":null,"path":"/api/v1/symbols","query":"a=1"}'
  );
  assert.strictEqual(
    canonicalJson({ b: { d: 1, c: 2 }, a: 3 }),
    '{"a":3,"b":{"c":2,"d":1}}'
  );
});

test('canonical JSON preserves array order while sorting inner objects', () => {
  // Arrays are ordered data; only object keys may be reordered.
  assert.strictEqual(
    canonicalJson([{ b: 1, a: 2 }, 'z', 1]),
    '[{"a":2,"b":1},"z",1]'
  );
});

test('canonical JSON treats null and undefined as null', () => {
  assert.strictEqual(canonicalJson(null), 'null');
  assert.strictEqual(canonicalJson(undefined), 'null');
  assert.strictEqual(canonicalJson({ a: null }), '{"a":null}');
});

test('canonical JSON matches the documented example payload', () => {
  // From docs.snaptrade.com/docs/request-signatures
  const payload = {
    content: { substring: 'AAPL' },
    path: '/api/v1/symbols',
    query: 'clientId=YOUR_CLIENT_ID&timestamp=1715123456',
  };
  assert.strictEqual(
    canonicalJson(payload),
    '{"content":{"substring":"AAPL"},"path":"/api/v1/symbols","query":"clientId=YOUR_CLIENT_ID&timestamp=1715123456"}'
  );
});

test('signature is HMAC-SHA256 of the canonical JSON, base64 encoded', async () => {
  const consumerKey = 'YOUR_CONSUMER_KEY';
  const payload = {
    content: { substring: 'AAPL' },
    path: '/api/v1/symbols',
    query: 'clientId=YOUR_CLIENT_ID&timestamp=1715123456',
  };
  const actual = await signRequest(consumerKey, payload);

  // Independently derived with Node's crypto rather than reusing our own code.
  const expected = crypto
    .createHmac('sha256', consumerKey)
    .update(canonicalJson(payload))
    .digest('base64');

  assert.strictEqual(actual, expected);
});

test('signature changes when any signed field changes', async () => {
  const key = 'k';
  const base = { content: null, path: '/api/v1/accounts', query: 'clientId=a&timestamp=1' };
  const sig = await signRequest(key, base);
  assert.notStrictEqual(sig, await signRequest(key, { ...base, query: 'clientId=a&timestamp=2' }));
  assert.notStrictEqual(sig, await signRequest(key, { ...base, path: '/api/v1/positions' }));
  assert.notStrictEqual(sig, await signRequest(key, { ...base, content: {} }));
  assert.notStrictEqual(sig, await signRequest('other', base));
});

test('a missing body signs as null, not as an empty object', async () => {
  // The docs are explicit: "requests where the body would otherwise be {}"
  // must sign content as null.
  const key = 'k';
  const path = '/api/v1/accounts';
  const query = 'clientId=a&timestamp=1';
  const omitted = await signRequest(key, { path, query });
  const explicitNull = await signRequest(key, { content: null, path, query });
  const emptyObject = await signRequest(key, { content: {}, path, query });
  assert.strictEqual(omitted, explicitNull);
  assert.notStrictEqual(omitted, emptyObject);
});

test('query string always leads with clientId then timestamp', () => {
  assert.strictEqual(buildQuery('cid', 123, null), 'clientId=cid&timestamp=123');
  assert.strictEqual(buildQuery('cid', 123, { extra: 'x' }), 'clientId=cid&timestamp=123&extra=x');
});

test('query string drops empty extras and percent-encodes values', () => {
  assert.strictEqual(
    buildQuery('c id', 1, { a: undefined, b: null, c: '', d: 'x/y' }),
    'clientId=c%20id&timestamp=1&d=x%2Fy'
  );
});

test('snaptrade is only considered configured with both credentials', () => {
  assert.strictEqual(snaptradeConfigured({}), false);
  assert.strictEqual(snaptradeConfigured({ SNAPTRADE_CLIENT_ID: 'a' }), false);
  assert.strictEqual(snaptradeConfigured({ SNAPTRADE_CONSUMER_KEY: 'b' }), false);
  assert.strictEqual(
    snaptradeConfigured({ SNAPTRADE_CLIENT_ID: 'a', SNAPTRADE_CONSUMER_KEY: 'b' }),
    true
  );
});

test('ticker is found however deeply SnapTrade nests it', () => {
  assert.strictEqual(extractTicker({ symbol: 'msft' }), 'MSFT');
  assert.strictEqual(extractTicker({ symbol: { symbol: 'fxaix' } }), 'FXAIX');
  assert.strictEqual(extractTicker({ symbol: { symbol: { symbol: 'fskax' } } }), 'FSKAX');
  assert.strictEqual(extractTicker({ symbol: { raw_symbol: 'vti' } }), 'VTI');
  assert.strictEqual(extractTicker({ universal_symbol: { symbol: 'abc' } }), 'ABC');
  assert.strictEqual(extractTicker({ ticker: 'xyz' }), 'XYZ');
});

test('ticker extraction gives up cleanly on unknown shapes', () => {
  assert.strictEqual(extractTicker({}), '');
  assert.strictEqual(extractTicker(null), '');
  assert.strictEqual(extractTicker({ symbol: {} }), '');
  assert.strictEqual(extractTicker({ symbol: { symbol: {} } }), '');
  assert.strictEqual(extractTicker({ symbol: '   ' }), '');
});

test('units accept either units or quantity', () => {
  assert.strictEqual(extractUnits({ units: 10 }), 10);
  assert.strictEqual(extractUnits({ quantity: 2.5 }), 2.5);
  assert.strictEqual(extractUnits({ units: 0 }), 0);
  assert.ok(Number.isNaN(extractUnits({})));
});

test('positions aggregate across duplicate tickers and skip junk', () => {
  const positions = [
    { symbol: { symbol: 'MSFT' }, units: 100 },
    { symbol: { symbol: 'msft' }, units: 40.5 },
    { symbol: { symbol: { symbol: 'FXAIX' } }, units: 250.123 },
    { symbol: {}, units: 999 },
    { symbol: { symbol: 'ZERO' }, units: 0 },
    { symbol: { symbol: 'NEG' }, units: -5 },
    { symbol: { symbol: 'NAN' }, units: 'abc' },
  ];
  assert.deepStrictEqual(aggregatePositions(positions), {
    MSFT: 140.5,
    FXAIX: 250.123,
  });
});

test('positions tolerate an empty or missing payload', () => {
  assert.deepStrictEqual(aggregatePositions([]), {});
  assert.deepStrictEqual(aggregatePositions(null), {});
  assert.deepStrictEqual(aggregatePositions(undefined), {});
});

/* ----------------------------------------------------------- credit cards */

test('what is owed is reported as a positive number', () => {
  // SnapTrade reports a debt as a negative balance, which reads as a credit on
  // screen. A cardholder asked what they owe expects a positive figure.
  const card = describeCard({
    id: 'abc', institution_name: 'U.S. Bank', name: 'Credit Card - 0001',
    balance: { total: { amount: -1234.56, currency: 'USD' } },
    sync_status: { holdings: { last_successful_sync: '2026-08-05T03:00:00Z' } },
  });
  assert.strictEqual(card.owed, 1234.56);
  assert.strictEqual(card.institution, 'U.S. Bank');
  assert.strictEqual(card.currency, 'USD');
  assert.strictEqual(card.syncedAt, '2026-08-05T03:00:00Z');
});

test('a card genuinely in credit stays distinguishable from one that is owed', () => {
  // Overpaid: the issuer owes the cardholder. Collapsing to a magnitude would
  // report it as a debt, which is precisely backwards.
  const card = describeCard({ balance: { total: { amount: 42.5, currency: 'USD' } } });
  assert.strictEqual(card.owed, -42.5);
});

test('a card whose balance could not be read reports null, not zero', () => {
  // Zero means "paid off" and sorts last; null means "unknown" and must not be
  // silently presented as good news.
  assert.strictEqual(describeCard({ name: 'X' }).owed, null);
  assert.strictEqual(describeCard({ balance: {} }).owed, null);
  assert.strictEqual(describeCard({ balance: { total: { amount: 'oops' } } }).owed, null);
});

test('cards with a balance sort before cards without, each alphabetically', () => {
  // The real five, with the names and balances SnapTrade actually returned.
  const cards = [
    { name: 'Robinhood Credit Card', owed: 9.99 },
    { name: 'Fidelity\u00ae Rewards Visa Signature\u00ae Card 0000', owed: 0 },
    { name: 'State Farm\u00ae Premier Cash Rewards Visa Signature', owed: 77.25 },
    { name: 'Credit Card - 0002', owed: 22.50 },
    { name: 'Credit Card - 0001', owed: 1234.56 },
  ];
  assert.deepStrictEqual(sortCards(cards).map((c) => c.name), [
    'Credit Card - 0001',
    'Credit Card - 0002',
    'Robinhood Credit Card',
    'State Farm\u00ae Premier Cash Rewards Visa Signature',
    'Fidelity\u00ae Rewards Visa Signature\u00ae Card 0000',
  ]);
});

test('a paid-off card sinks rather than disappearing', () => {
  const sorted = sortCards([
    { name: 'AAA Paid Off', owed: 0 },
    { name: 'ZZZ Owing', owed: 5 },
  ]);
  assert.deepStrictEqual(sorted.map((c) => c.name), ['ZZZ Owing', 'AAA Paid Off'],
    'an alphabetically-first paid card must still sort after an owing one');
  assert.strictEqual(sorted.length, 2, 'a paid card must not be hidden entirely');
});

test('a card in credit counts as outstanding, not as paid off', () => {
  const sorted = sortCards([
    { name: 'Paid', owed: 0 },
    { name: 'Overpaid', owed: -20 },
  ]);
  assert.strictEqual(sorted[0].name, 'Overpaid',
    'a non-zero balance is worth seeing whichever way it points');
});

test('a card with an unreadable balance is not treated as paid off', () => {
  const sorted = sortCards([{ name: 'Paid', owed: 0 }, { name: 'Unknown', owed: null }]);
  assert.strictEqual(sorted[0].name, 'Paid',
    'null is falsy, so an unknown balance sorts with the paid cards');
});

test('numbers inside names sort naturally, not lexically', () => {
  const sorted = sortCards([
    { name: 'Credit Card - 10', owed: 1 },
    { name: 'Credit Card - 9', owed: 1 },
  ]);
  assert.deepStrictEqual(sorted.map((c) => c.name), ['Credit Card - 9', 'Credit Card - 10']);
});

test('sorting does not mutate the caller\u2019s array', () => {
  const cards = [{ name: 'B', owed: 0 }, { name: 'A', owed: 5 }];
  sortCards(cards);
  assert.strictEqual(cards[0].name, 'B', 'the input array was reordered in place');
});

test('the total owed is the sum across every card', () => {
  assert.strictEqual(totalOwed([
    { owed: 9.99 }, { owed: 1234.56 }, { owed: 22.50 }, { owed: 77.25 }, { owed: 0 },
  ]).toFixed(2), '1344.30');
});

test('an unreadable balance does not poison the total', () => {
  assert.strictEqual(totalOwed([{ owed: 100 }, { owed: null }, { owed: 50 }]), 150);
  assert.strictEqual(totalOwed([]), 0);
  assert.strictEqual(totalOwed(null), 0);
});

test('a card in credit reduces the total', () => {
  assert.strictEqual(totalOwed([{ owed: 100 }, { owed: -30 }]), 70);
});
