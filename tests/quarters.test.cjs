/*
 * Tests for quarter bucketing.
 *
 * The table colours each row by the quarter of its ex-date, and rows are sorted
 * by that same date, so quarters must form contiguous runs. Anything that
 * breaks the month -> quarter mapping, or that disagrees with parseDate about
 * which calendar day a distribution falls on, turns the colour bands into
 * stripes of noise.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { quarterOf, parseDate } = require(path.join(__dirname, '..', 'docs', 'app.js'));

test('every month maps to the expected quarter', () => {
  const expected = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4];
  expected.forEach((q, i) => {
    const date = new Date(2026, i, 15);
    assert.equal(quarterOf(date).index, q, `month index ${i} should be Q${q}`);
  });
});

test('quarter edges land on the correct side', () => {
  // The costly mistake is an off-by-one at a boundary, which would put the
  // last dividend of a quarter in the wrong colour band.
  const cases = [
    ['2026-01-01', '2026-Q1'], ['2026-03-31', '2026-Q1'],
    ['2026-04-01', '2026-Q2'], ['2026-06-30', '2026-Q2'],
    ['2026-07-01', '2026-Q3'], ['2026-09-30', '2026-Q3'],
    ['2026-10-01', '2026-Q4'], ['2026-12-31', '2026-Q4'],
  ];
  for (const [iso, key] of cases) {
    assert.equal(quarterOf(iso).key, key, `${iso} should be ${key}`);
  }
});

test('the key carries the year so quarters never merge across years', () => {
  // Q4 2025 and Q4 2026 share a colour by design, but they must not be treated
  // as one run - otherwise a year boundary would silently drop a band label.
  assert.notEqual(quarterOf('2025-12-31').key, quarterOf('2026-12-31').key);
  assert.equal(quarterOf('2025-12-31').index, quarterOf('2026-12-31').index);
});

test('the label is human readable', () => {
  assert.equal(quarterOf('2026-02-20').label, 'Q1 2026');
  assert.equal(quarterOf('2026-11-05').label, 'Q4 2026');
});

test('the year comes from the date, not the current clock', () => {
  assert.equal(quarterOf('2019-08-14').year, 2019);
  assert.equal(quarterOf('2019-08-14').key, '2019-Q3');
});

test('an ISO string and its parsed Date agree', () => {
  // renderTable passes row.date (a Date); the tests above mostly pass strings.
  // If these two paths disagreed, the class on the row would not match the
  // date rendered beside it.
  for (const iso of ['2026-01-01', '2026-03-31', '2026-04-01', '2026-12-31']) {
    assert.equal(quarterOf(iso).key, quarterOf(parseDate(iso)).key, iso);
  }
});

test('dates near midnight stay on their local calendar day', () => {
  // parseDate builds a local-time Date precisely so that a UTC shift cannot
  // push a March 31 ex-date into Q2. Guard that this holds here too.
  assert.equal(quarterOf(parseDate('2026-03-31')).key, '2026-Q1');
  assert.equal(quarterOf(parseDate('2026-01-01')).key, '2026-Q1');
});

test('unusable input yields null rather than a bogus quarter', () => {
  for (const bad of [null, undefined, '', 'not a date', 'sometime']) {
    assert.equal(quarterOf(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  assert.equal(quarterOf(new Date('nonsense')), null);
});

test('sorted rows produce contiguous quarter runs', () => {
  // This is the property the colour bands depend on: once a quarter is left,
  // it is never re-entered.
  const dates = [
    '2026-01-15', '2026-02-20', '2026-03-05',
    '2026-04-02', '2026-05-19',
    '2026-07-08',
    '2026-10-01', '2026-12-31',
    '2027-01-04',
  ].map(parseDate).sort((a, b) => a - b);

  const seen = new Set();
  let previous = null;
  for (const date of dates) {
    const key = quarterOf(date).key;
    if (key !== previous) {
      assert.ok(!seen.has(key), `quarter ${key} was re-entered after leaving it`);
      seen.add(key);
      previous = key;
    }
  }
  assert.equal(seen.size, 5, 'expected five distinct quarters in the fixture');
});
