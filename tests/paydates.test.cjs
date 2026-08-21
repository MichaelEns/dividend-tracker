/*
 * The folded portrait date column.
 *
 * Portrait drops the separate Pay date column, so one cell carries both dates
 * and has to choose which one is prominent. These tests pin that choice and,
 * more importantly, pin what happens when there is no pay date to show - which
 * is most rows here, because no free feed publishes pay dates for mutual funds.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { portraitDates, nextPayment, parseDate, formatDate } = require(path.join(__dirname, '..', 'docs', 'app.js'));

const PAID = { exDate: '2026-02-19', payDate: '2026-03-12' };
const FUND = { exDate: '2026-04-04', payDate: null };

test('the pay date is the prominent line when it is known', () => {
  const { main, alt } = portraitDates(PAID);
  assert.match(main, /Mar/, 'the large line must be the pay date, not the ex-date');
  assert.match(main, /2026/, 'the large line carries the year');
  assert.doesNotMatch(main, /Feb/, 'the ex-date must not be the large line');
  assert.match(alt, /^ex /, 'the small line must be labelled as the ex-date');
  assert.match(alt, /Feb/);
});

test('the small line omits the year, which the large line already gives', () => {
  const { alt } = portraitDates(PAID);
  assert.doesNotMatch(alt, /2026/, 'repeating the year wastes a narrow column');
});

test('a row with no pay date leads with its ex-date rather than with TBD', () => {
  // 94 of 154 rows are fund distributions with no published pay date. Leading
  // with "TBD" would blank the column for most of the table.
  const { main, alt } = portraitDates(FUND);
  assert.match(main, /Apr/, 'the one date we do know should be the prominent one');
  assert.doesNotMatch(main, /TBD/i, 'the large line must never be a placeholder');
  assert.strictEqual(alt, 'ex-date', 'the row must label what the large line actually is');
  // Deliberately not "pay TBD": most such rows were paid years ago, so nothing
  // about them is to be determined - the pay date was simply never published.
  assert.doesNotMatch(alt, /TBD/i, 'a settled historical row must not claim to be pending');
});

test('the two cases are never ambiguous about what the large date means', () => {
  const known = portraitDates(PAID);
  const unknown = portraitDates(FUND);
  assert.notStrictEqual(known.alt, unknown.alt);
  // Whichever branch ran, the second line names what the first line is not.
  assert.match(known.alt, /ex/, 'pay-date rows must label the ex-date');
  assert.strictEqual(unknown.alt, 'ex-date', 'ex-date rows must say so outright');
});

test('an undefined pay date is treated the same as a missing one', () => {
  const undef = portraitDates({ exDate: '2026-04-04' });
  assert.deepStrictEqual(undef, portraitDates(FUND));
});

test('an empty-string pay date does not produce a blank prominent line', () => {
  // The build writes null, but a hand-edited config/announced.json can leave "".
  const blank = portraitDates({ exDate: '2026-04-04', payDate: '' });
  assert.match(blank.main, /Apr/);
  assert.doesNotMatch(blank.main, /^—$/, 'an empty pay date must not render as a dash');
});

test('the lines stay short enough for a narrow column', () => {
  for (const row of [PAID, FUND]) {
    const { main, alt } = portraitDates(row);
    assert.ok(main.length <= 14, `large line too long: ${main}`);
    assert.ok(alt.length <= 20, `small line too long: ${alt}`);
  }
});

/* -------------------------------------------- which payment arrives next */

const row = (sym, ex, pay) => ({ symbol: sym, exDate: ex, payDate: pay, date: parseDate(ex) });
const TODAY = parseDate('2026-09-01');

test('a dividend that has gone ex but not yet paid is still coming', () => {
  // MSFT goes ex about three weeks before it pays. Picking by ex-date skipped
  // straight past money that had not arrived yet, for those three weeks.
  const rows = [
    row('MSFT', '2026-08-20', '2026-09-10'),
    row('FXAIX', '2026-10-05', '2026-10-06'),
  ];
  const next = nextPayment(rows, TODAY);
  assert.strictEqual(next.row.symbol, 'MSFT', 'an unpaid dividend was skipped');
  assert.strictEqual(next.when.getTime(), parseDate('2026-09-10').getTime());
});

test('a fund going ex later can still pay first', () => {
  // A fund pays the next business day; an equity takes about three weeks. So
  // ex-date order and payment order genuinely disagree.
  const rows = [
    row('MSFT', '2026-09-02', '2026-09-23'),
    row('FXAIX', '2026-09-10', '2026-09-11'),
  ];
  assert.strictEqual(nextPayment(rows, TODAY).row.symbol, 'FXAIX',
    'the card must name whichever pays first, not whichever goes ex first');
});

test('a payment already made is not offered as next', () => {
  const rows = [row('MSFT', '2026-05-20', '2026-06-10'), row('FXAIX', '2026-10-05', '2026-10-06')];
  assert.strictEqual(nextPayment(rows, TODAY).row.symbol, 'FXAIX');
});

test('a row with no pay date falls back to its ex-date rather than vanishing', () => {
  const rows = [{ symbol: 'X', exDate: '2026-09-15', payDate: null, date: parseDate('2026-09-15') }];
  const next = nextPayment(rows, TODAY);
  assert.strictEqual(next.row.symbol, 'X');
  assert.strictEqual(next.when.getTime(), parseDate('2026-09-15').getTime());
});

test('nothing scheduled yields nothing, rather than throwing', () => {
  assert.strictEqual(nextPayment([], TODAY), null);
  assert.strictEqual(nextPayment(null, TODAY), null);
  assert.strictEqual(nextPayment([row('MSFT', '2026-01-01', '2026-01-22')], TODAY), null);
});

test('a payment landing exactly today is treated as already arrived', () => {
  const rows = [row('MSFT', '2026-08-10', '2026-09-01'), row('FXAIX', '2026-09-04', '2026-09-07')];
  assert.strictEqual(nextPayment(rows, TODAY).row.symbol, 'FXAIX');
});

test('the earliest payment wins regardless of the order rows arrive in', () => {
  const late = row('A', '2026-09-20', '2026-09-25');
  const soon = row('B', '2026-09-02', '2026-09-03');
  assert.strictEqual(nextPayment([late, soon], TODAY).row.symbol, 'B');
  assert.strictEqual(nextPayment([soon, late], TODAY).row.symbol, 'B');
});

test('a Date is accepted as well as a YYYY-MM-DD string', () => {
  // The "Next payment" card holds an already-parsed date. Passing it produced
  // an em dash, because String(date) has no dashes where parseDate expects.
  const d = new Date(2026, 8, 10);
  const out = parseDate(d);
  assert.ok(out instanceof Date);
  assert.strictEqual(out.getTime(), d.getTime());
  assert.notStrictEqual(out, d, 'must be a copy, so no caller can mutate another\u2019s date');
});

test('an invalid Date yields null rather than an Invalid Date', () => {
  assert.strictEqual(parseDate(new Date('nonsense')), null);
});

test('formatDate renders a Date, not an em dash', () => {
  const { formatDate } = require(path.join(__dirname, '..', 'docs', 'app.js'));
  const text = formatDate(new Date(2026, 8, 10));
  assert.notStrictEqual(text, '\u2014');
  assert.match(text, /2026/);
});

/* ------------------------------- upcoming vs history, decided by arrival */

const { arrivalDate, inRange } = require(path.join(__dirname, '..', 'docs', 'app.js'));

// MSFT went ex on 20 Aug 2026 and pays on 10 Sep 2026. Between those dates the
// money is declared, certain, and has not arrived.
const IN_FLIGHT = { symbol: 'MSFT', exDate: '2026-08-20', payDate: '2026-09-10' };
const BETWEEN = parseDate('2026-08-21');

test('a dividend that has gone ex but not been paid is still Upcoming', () => {
  // The reported bug: it dropped out of Upcoming the morning after the ex-date,
  // three weeks before the cash arrived.
  assert.strictEqual(inRange(IN_FLIGHT, 'upcoming', BETWEEN), true);
});

test('the same dividend is not also filed under History', () => {
  // Showing in both would be a different lie: the money has not arrived.
  assert.strictEqual(inRange(IN_FLIGHT, 'history', BETWEEN), false);
});

test('once the pay date passes it moves to History and leaves Upcoming', () => {
  const after = parseDate('2026-09-11');
  assert.strictEqual(inRange(IN_FLIGHT, 'upcoming', after), false);
  assert.strictEqual(inRange(IN_FLIGHT, 'history', after), true);
});

test('on the pay date itself it is still Upcoming, and not yet History', () => {
  // "It should show up until the actual pay date has passed" - on the pay date
  // it has not passed. This also keeps the table's long-standing boundary, where
  // a row dated today is upcoming. The Next payment card is deliberately
  // stricter (it wants the next money to *come*, so it treats today as arrived);
  // the two answer different questions and are pinned separately.
  const onPayDay = parseDate('2026-09-10');
  assert.strictEqual(inRange(IN_FLIGHT, 'upcoming', onPayDay), true);
  assert.strictEqual(inRange(IN_FLIGHT, 'history', onPayDay), false);
  assert.strictEqual(nextPayment([{ ...IN_FLIGHT, date: parseDate('2026-08-20') }], onPayDay), null,
    'the card looks past a payment landing today');
});

test('a row is never in both buckets, and never in neither', () => {
  // The two filters must partition: an off-by-one between them would either
  // duplicate a payment or lose it entirely.
  const rows = [IN_FLIGHT,
    { exDate: '2026-04-04', payDate: null },
    { exDate: '2026-11-18', payDate: '2026-12-11' },
    { exDate: '2026-09-10', payDate: '2026-09-10' }];
  for (const day of ['2026-08-19', '2026-08-20', '2026-08-21', '2026-09-10', '2026-09-11']) {
    const today = parseDate(day);
    for (const r of rows) {
      const up = inRange(r, 'upcoming', today);
      const hist = inRange(r, 'history', today);
      assert.notStrictEqual(up, hist,
        `${r.exDate}/${r.payDate} on ${day} was in ${up && hist ? 'both' : 'neither'} bucket`);
    }
  }
});

test('a row with no pay date still buckets by its ex-date', () => {
  // Most fund rows have no published pay date; they must not all pile into one
  // bucket just because the pay date is missing.
  const fund = { symbol: 'FXAIX', exDate: '2026-04-04', payDate: null };
  assert.strictEqual(inRange(fund, 'history', BETWEEN), true);
  assert.strictEqual(inRange(fund, 'upcoming', BETWEEN), false);
});

test('a genuinely future dividend is Upcoming, as it always was', () => {
  const future = { symbol: 'MSFT', exDate: '2026-11-18', payDate: '2026-12-11' };
  assert.strictEqual(inRange(future, 'upcoming', BETWEEN), true);
  assert.strictEqual(inRange(future, 'history', BETWEEN), false);
});

test('the all range keeps everything', () => {
  for (const r of [IN_FLIGHT, { exDate: '2020-01-01', payDate: '2020-01-20' }]) {
    assert.strictEqual(inRange(r, 'all', BETWEEN), true);
  }
});

test('arrivalDate prefers the pay date and falls back to the ex-date', () => {
  assert.strictEqual(arrivalDate(IN_FLIGHT).getTime(), parseDate('2026-09-10').getTime());
  assert.strictEqual(arrivalDate({ exDate: '2026-04-04' }).getTime(),
    parseDate('2026-04-04').getTime());
  assert.strictEqual(arrivalDate({ exDate: '2026-04-04', payDate: '' }).getTime(),
    parseDate('2026-04-04').getTime(), 'an empty string is not a pay date');
  assert.strictEqual(arrivalDate(null), null);
});
