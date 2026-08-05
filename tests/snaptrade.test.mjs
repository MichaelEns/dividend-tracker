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
