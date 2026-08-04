/*
 * Tests for the Plaid worker's pure logic.
 *
 * The origin check is security-critical: this worker holds a Plaid secret and
 * can start bank sign-in flows, so it must fail closed when misconfigured.
 */
import test from 'node:test';
import assert from 'node:assert';

import { aggregateHoldings, originAllowed, authorized, timingSafeEqual } from '../worker/src/index.js';

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
  assert.deepStrictEqual(aggregateHoldings(investments), {
    MSFT: 140.5,
    FXAIX: 250.123,
  });
});

test('holdings tolerate an empty payload', () => {
  assert.deepStrictEqual(aggregateHoldings({}), {});
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
  assert.strictEqual(authorized(PASS.toUpperCase(), env), false);
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
