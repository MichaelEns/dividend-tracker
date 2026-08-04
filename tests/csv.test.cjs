/*
 * Tests for the brokerage CSV import.
 *
 * Real Fidelity and U.S. Bancorp Investments exports are messy: quoted fields,
 * preamble/footer text, money-market rows suffixed with "**", the same symbol
 * held across multiple accounts, and differing header names. These fixtures
 * mirror those shapes.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { parseCsv, extractHoldings, parseDate } = require(
  path.join(__dirname, '..', 'docs', 'app.js')
);

const KNOWN = ['MSFT', 'FXAIX', 'FSKAX'];

const FIDELITY_CSV = [
  '',
  '"Account Number","Account Name","Symbol","Description","Quantity","Last Price","Current Value"',
  '"Z12345678","INDIVIDUAL","MSFT","MICROSOFT CORP","100.000","$495.76","$49576.00"',
  '"Z12345678","INDIVIDUAL","FXAIX","FIDELITY 500 INDEX FUND","250.123","$264.23","$66089.00"',
  '"Z12345678","INDIVIDUAL","SPAXX**","FIDELITY GOVERNMENT MONEY MARKET","1,000.00","$1.00","$1000.00"',
  '"Z87654321","ROTH IRA","MSFT","MICROSOFT CORP","40.500","$495.76","$20078.28"',
  '"Z87654321","ROTH IRA","FSKAX","FIDELITY TOTAL MARKET INDEX FUND","1,234.567","$209.45","$258581.00"',
  '',
  '"Brokerage services provided by Fidelity Brokerage Services LLC, Member NYSE, SIPC."',
].join('\r\n');

const USBANK_CSV = [
  'Positions as of 08/04/2026',
  'Ticker,Description,Shares,Price,Market Value',
  'MSFT,MICROSOFT CORPORATION,25,495.76,12394.00',
  'CASH,CASH & EQUIVALENTS,5000,1.00,5000.00',
].join('\n');

test('parseCsv handles quoted fields, embedded commas and CRLF', () => {
  const rows = parseCsv('a,b\r\n"1,5","say ""hi"""\r\n');
  assert.deepStrictEqual(rows, [['a', 'b'], ['1,5', 'say "hi"']]);
});

test('parseCsv drops fully blank lines', () => {
  assert.strictEqual(parseCsv('a,b\n\n\nc,d\n').length, 2);
});

test('Fidelity export: sums across accounts and ignores untracked rows', () => {
  const found = extractHoldings(FIDELITY_CSV, KNOWN);
  assert.strictEqual(found.MSFT, 140.5, 'MSFT should sum taxable + Roth');
  assert.strictEqual(found.FXAIX, 250.123);
  assert.strictEqual(found.FSKAX, 1234.567, 'thousands separator must be stripped');
  assert.ok(!('SPAXX' in found), 'money market row must be ignored');
});

test('U.S. Bank export: alternate headers and a preamble line', () => {
  const found = extractHoldings(USBANK_CSV, KNOWN);
  assert.deepStrictEqual(found, { MSFT: 25 });
});

test('a file with no usable header is rejected clearly', () => {
  assert.throws(
    () => extractHoldings('foo,bar\n1,2\n', KNOWN),
    /Symbol.*Quantity/
  );
});

test('a file with no tracked symbols is rejected clearly', () => {
  const csv = 'Symbol,Quantity\nAAPL,10\n';
  assert.throws(() => extractHoldings(csv, KNOWN), /No tracked symbols/);
});

test('parseDate treats YYYY-MM-DD as local, not UTC', () => {
  const parsed = parseDate('2026-08-20');
  assert.strictEqual(parsed.getFullYear(), 2026);
  assert.strictEqual(parsed.getMonth(), 7);
  assert.strictEqual(parsed.getDate(), 20, 'must not shift a day in negative UTC offsets');
});
