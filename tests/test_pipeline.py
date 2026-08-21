"""Focused unit tests for the projection engine and Nasdaq parsing.

Run with:  python -m unittest discover -s tests
"""
from __future__ import annotations

import json
import unittest
from datetime import date, timedelta

from divtracker.model import (
    STATUS_ANNOUNCED,
    STATUS_PAID,
    STATUS_PROJECTED,
    Distribution,
)
from divtracker.build import _apply_pay_dates, _estimate_fund_pay_dates
from divtracker.projection import (
    annual_growth_rate, infer_cadence, next_business_day, project, roll_to_business_day,
)
from divtracker.sources import _parse_money, _parse_us_date


def make_history(anchor: date, gap_days: int, amounts: list[float]) -> list[Distribution]:
    history = []
    current = anchor
    for amount in amounts:
        history.append(
            Distribution(
                symbol="TEST",
                ex_date=current,
                amount=amount,
                status=STATUS_PAID,
                kind="income",
                source="test",
            )
        )
        current = current + timedelta(days=gap_days)
    return history


class NasdaqParsingTests(unittest.TestCase):
    def test_parse_money(self):
        self.assertAlmostEqual(_parse_money("$0.91"), 0.91)
        self.assertAlmostEqual(_parse_money("1,234.56"), 1234.56)
        self.assertIsNone(_parse_money(""))
        self.assertIsNone(_parse_money("N/A"))

    def test_parse_us_date(self):
        self.assertEqual(_parse_us_date("08/20/2026"), date(2026, 8, 20))
        self.assertEqual(_parse_us_date("2026-08-20"), date(2026, 8, 20))
        self.assertIsNone(_parse_us_date(""))
        self.assertIsNone(_parse_us_date("N/A"))


class CadenceTests(unittest.TestCase):
    def test_quarterly_from_slot_count(self):
        # 4 slots per year -> quarterly, regardless of raw gap noise.
        dates = [date(2024, m, 15) for m in (2, 5, 8, 11)] + [date(2025, m, 15) for m in (2, 5, 8, 11)]
        label, gap = infer_cadence(dates, slots_per_year=4)
        self.assertEqual(label, "quarterly")
        self.assertIsNotNone(gap)

    def test_semiannual_avoids_quarterly_trap(self):
        # FSKAX pays only Apr and Dec; Dec->Apr gap looks quarterly.
        dates = [date(2023, 4, 20), date(2023, 12, 20),
                 date(2024, 4, 20), date(2024, 12, 20)]
        label, _ = infer_cadence(dates, slots_per_year=2)
        self.assertEqual(label, "semiannual")


class GrowthTests(unittest.TestCase):
    def test_10_percent_growth_recovered(self):
        # Level payer, +10%/yr for 5 years -> median growth ~= 0.10 clamped ok.
        history = []
        amount = 0.50
        for year in range(2019, 2025):
            for month in (2, 5, 8, 11):
                history.append(
                    Distribution(
                        symbol="TEST",
                        ex_date=date(year, month, 15),
                        amount=amount,
                        status=STATUS_PAID,
                        kind="income",
                        source="test",
                    )
                )
            amount *= 1.10
        series = [(d.ex_date, d.amount) for d in history]
        rate = annual_growth_rate(series)
        self.assertAlmostEqual(rate, 0.10, places=2)


class ProjectionTests(unittest.TestCase):
    def test_level_payer_projects_flat_amount_after_announced(self):
        history = []
        for year in (2023, 2024, 2025):
            for month in (2, 5, 8, 11):
                history.append(
                    Distribution(
                        symbol="MSFT",
                        ex_date=date(year, month, 20),
                        amount=0.83,
                        status=STATUS_PAID,
                        kind="income",
                        source="test",
                    )
                )
        confirmed = [
            Distribution(
                symbol="MSFT",
                ex_date=date(2026, 2, 19),
                amount=0.91,
                status=STATUS_ANNOUNCED,
                kind="income",
                pay_date=date(2026, 3, 12),
                source="Nasdaq",
            )
        ]
        projections, diag = project(
            "MSFT",
            history,
            confirmed,
            today=date(2026, 1, 15),
            horizon_years=1,
            hint_kind="equity",
        )
        # None should collide with the announced slot.
        for p in projections:
            self.assertEqual(p.status, STATUS_PROJECTED)
            self.assertGreater(p.ex_date, date(2026, 2, 19))
        # Amounts start at the latest announced rate ($0.91).
        first = min(projections, key=lambda p: p.ex_date)
        self.assertAlmostEqual(first.amount, 0.91, places=2)

    def test_short_history_returns_no_projection(self):
        history = make_history(date(2024, 1, 15), 91, [0.50, 0.50])
        projections, diag = project(
            "TEST", history, [], today=date(2024, 6, 1), horizon_years=1
        )
        self.assertEqual(projections, [])
        self.assertIn("warnings", diag)


if __name__ == "__main__":
    unittest.main()


class PayDateEnrichmentTests(unittest.TestCase):
    """Yahoo history has no pay dates; Nasdaq publishes them for the same rows."""

    def _history(self):
        return [
            Distribution(symbol="MSFT", ex_date=date(2026, 2, 19), amount=0.91,
                         status=STATUS_PAID, kind="income", source="Yahoo Finance"),
            Distribution(symbol="MSFT", ex_date=date(2026, 5, 21), amount=0.91,
                         status=STATUS_PAID, kind="income", source="Yahoo Finance"),
        ]

    def test_fills_missing_pay_dates_by_ex_date(self):
        history = self._history()
        filled = _apply_pay_dates(history, {
            date(2026, 2, 19): date(2026, 3, 12),
            date(2026, 5, 21): date(2026, 6, 11),
        })
        self.assertEqual(filled, 2)
        self.assertEqual(history[0].pay_date, date(2026, 3, 12))
        self.assertEqual(history[1].pay_date, date(2026, 6, 11))

    def test_leaves_rows_with_no_match_alone(self):
        history = self._history()
        filled = _apply_pay_dates(history, {date(2020, 1, 1): date(2020, 1, 20)})
        self.assertEqual(filled, 0)
        self.assertIsNone(history[0].pay_date)

    def test_never_overwrites_a_pay_date_that_is_already_known(self):
        # An announcement names one specific dividend, which beats a lookup.
        history = self._history()
        history[0].pay_date = date(2026, 3, 13)
        filled = _apply_pay_dates(history, {date(2026, 2, 19): date(2026, 3, 12)})
        self.assertEqual(filled, 0)
        self.assertEqual(history[0].pay_date, date(2026, 3, 13))

    def test_an_empty_map_is_a_no_op(self):
        history = self._history()
        self.assertEqual(_apply_pay_dates(history, {}), 0)
        self.assertIsNone(history[0].pay_date)


class NasdaqPayDateHarvestTests(unittest.TestCase):
    """The pay-date map must include PAST rows - that is the whole point."""

    PAYLOAD = {
        "data": {"dividends": {"rows": [
            {"exOrEffDate": "08/20/2026", "paymentDate": "09/10/2026",
             "recordDate": "08/20/2026", "declarationDate": "06/09/2026",
             "amount": "$0.91", "type": "Cash"},
            {"exOrEffDate": "02/19/2026", "paymentDate": "03/12/2026",
             "recordDate": "02/19/2026", "declarationDate": "12/02/2025",
             "amount": "$0.91", "type": "Cash"},
            {"exOrEffDate": "11/20/2025", "paymentDate": "12/11/2025",
             "recordDate": "11/20/2025", "declarationDate": "09/16/2025",
             "amount": "$0.83", "type": "Cash"},
        ]}}
    }

    def _fetch(self, today):
        import divtracker.sources as src
        original = src._get_json
        src._get_json = lambda url, **kw: self.PAYLOAD
        try:
            return src.fetch_nasdaq_declared("MSFT", today)
        finally:
            src._get_json = original

    def test_past_rows_are_excluded_from_declared_but_keep_their_pay_dates(self):
        declared, pay_dates = self._fetch(date(2026, 8, 4))
        self.assertEqual([d.ex_date for d in declared], [date(2026, 8, 20)],
                         "only the not-yet-ex row is a declared dividend")
        self.assertEqual(pay_dates, {
            date(2026, 8, 20): date(2026, 9, 10),
            date(2026, 2, 19): date(2026, 3, 12),
            date(2025, 11, 20): date(2025, 12, 11),
        }, "past pay dates were dropped - they are the reason this exists")

    def test_declared_rows_still_carry_their_own_pay_date(self):
        declared, _ = self._fetch(date(2026, 8, 4))
        self.assertEqual(declared[0].pay_date, date(2026, 9, 10))

    def test_a_pay_date_before_its_ex_date_is_rejected_as_bad_data(self):
        import divtracker.sources as src
        original = src._get_json
        src._get_json = lambda url, **kw: {"data": {"dividends": {"rows": [
            {"exOrEffDate": "05/21/2026", "paymentDate": "01/02/2026", "amount": "$0.91"},
        ]}}}
        try:
            _, pay_dates = src.fetch_nasdaq_declared("MSFT", date(2026, 8, 4))
        finally:
            src._get_json = original
        self.assertEqual(pay_dates, {})

    def test_an_unparseable_amount_still_yields_its_pay_date(self):
        import divtracker.sources as src
        original = src._get_json
        src._get_json = lambda url, **kw: {"data": {"dividends": {"rows": [
            {"exOrEffDate": "05/21/2026", "paymentDate": "06/11/2026", "amount": "N/A"},
        ]}}}
        try:
            declared, pay_dates = src.fetch_nasdaq_declared("MSFT", date(2026, 8, 4))
        finally:
            src._get_json = original
        self.assertEqual(declared, [])
        self.assertEqual(pay_dates, {date(2026, 5, 21): date(2026, 6, 11)})

    def test_no_payload_returns_an_empty_pair_rather_than_raising(self):
        import divtracker.sources as src
        original = src._get_json
        src._get_json = lambda url, **kw: {}
        try:
            declared, pay_dates = src.fetch_nasdaq_declared("FXAIX", date(2026, 8, 4))
        finally:
            src._get_json = original
        self.assertEqual(declared, [])
        self.assertEqual(pay_dates, {})

    def test_a_dividend_that_has_gone_ex_is_kept_until_it_is_paid(self):
        # The reported bug. This function was asked only for not-yet-ex rows, so
        # it stopped offering the 20 Aug dividend on 20 Aug - but Yahoo does not
        # report a dividend until a day or so after its ex-date, so on that day
        # NEITHER source carried it and a declared payment disappeared from the
        # app outright, three weeks before it was due to arrive.
        for today in (date(2026, 8, 20), date(2026, 8, 21), date(2026, 9, 9)):
            declared, _ = self._fetch(today)
            self.assertEqual([d.ex_date for d in declared], [date(2026, 8, 20)],
                             f"the declared, unpaid dividend disappeared on {today}")
            self.assertEqual(declared[0].pay_date, date(2026, 9, 10))
            self.assertEqual(declared[0].status, STATUS_ANNOUNCED)

    def test_it_is_dropped_once_the_money_has_actually_arrived(self):
        for today in (date(2026, 9, 10), date(2026, 9, 11)):
            declared, _ = self._fetch(today)
            self.assertEqual(declared, [], f"still offered as upcoming on {today}")

    def test_with_no_pay_date_the_ex_date_still_settles_it(self):
        # Unparseable or absent pay date must fall back to the old behaviour
        # rather than pinning the row as upcoming forever.
        import divtracker.sources as src
        original = src._get_json
        src._get_json = lambda url, **kw: {"data": {"dividends": {"rows": [
            {"exOrEffDate": "08/20/2026", "paymentDate": "N/A", "amount": "$0.91"},
        ]}}}
        try:
            after, _ = src.fetch_nasdaq_declared("MSFT", date(2026, 8, 21))
            before, _ = src.fetch_nasdaq_declared("MSFT", date(2026, 8, 19))
        finally:
            src._get_json = original
        self.assertEqual(after, [], "an undated row must not linger past its ex-date")
        self.assertEqual([d.ex_date for d in before], [date(2026, 8, 20)])


class InFlightDividendTests(unittest.TestCase):
    """A dividend between its ex-date and its pay date is money still coming.

    MSFT goes ex about three weeks before it pays, and the pipeline treated the
    ex-date as the moment a dividend became history. That lost the payment twice
    over: Nasdaq stopped offering it on the ex-date while Yahoo had not yet
    started, so for a day it existed nowhere; and once Yahoo did report it, it
    arrived flagged 'paid' three weeks before the cash did.
    """

    EX = date(2026, 8, 20)
    PAY = date(2026, 9, 10)

    PAST = [
        (date(2025, 2, 19), 0.83), (date(2025, 5, 14), 0.83),
        (date(2025, 8, 21), 0.83), (date(2025, 11, 20), 0.83),
        (date(2026, 2, 19), 0.91), (date(2026, 5, 21), 0.91),
    ]

    def _build(self, today, yahoo_has_it):
        import divtracker.build as b
        from divtracker.model import SymbolConfig

        history = [
            Distribution(symbol="MSFT", ex_date=ex, amount=amt,
                         status=STATUS_PAID, source="Yahoo Finance")
            for ex, amt in self.PAST
        ]
        if yahoo_has_it:
            history.append(Distribution(symbol="MSFT", ex_date=self.EX, amount=0.91,
                                        status=STATUS_PAID, source="Yahoo Finance"))

        pay_dates = {ex: ex + timedelta(days=21) for ex, _ in self.PAST}
        pay_dates[self.EX] = self.PAY

        declared = []
        if self.PAY > today:
            declared = [Distribution(symbol="MSFT", ex_date=self.EX, amount=0.91,
                                     status=STATUS_ANNOUNCED, pay_date=self.PAY,
                                     source="Nasdaq (declared)")]

        orig_y, orig_n = b.fetch_yahoo, b.fetch_nasdaq_declared
        b.fetch_yahoo = lambda s: {"distributions": history, "price": 500.0,
                                   "currency": "USD", "name": "Microsoft"}
        b.fetch_nasdaq_declared = lambda s, t: (list(declared), dict(pay_dates))
        try:
            return b.build_symbol(SymbolConfig(symbol="MSFT", kind="equity"), {}, today, 3)
        finally:
            b.fetch_yahoo, b.fetch_nasdaq_declared = orig_y, orig_n

    def _rows(self, result):
        return [d for d in result.distributions if d.ex_date == self.EX]

    def test_it_exists_on_its_ex_date_even_before_yahoo_reports_it(self):
        rows = self._rows(self._build(self.EX, yahoo_has_it=False))
        self.assertEqual(len(rows), 1, "the payment vanished from the app entirely")
        self.assertEqual(rows[0].pay_date, self.PAY)
        self.assertEqual(rows[0].status, STATUS_ANNOUNCED)

    def test_it_is_listed_once_when_both_sources_carry_it(self):
        # Relaxing the Nasdaq cutoff means both feeds describe this payment for
        # the three weeks between ex and pay; it must not appear twice.
        rows = self._rows(self._build(date(2026, 8, 21), yahoo_has_it=True))
        self.assertEqual(len(rows), 1, "the same payment was listed twice")

    def test_it_is_still_announced_after_yahoo_reports_it(self):
        rows = self._rows(self._build(date(2026, 8, 21), yahoo_has_it=True))
        self.assertEqual(rows[0].status, STATUS_ANNOUNCED,
                         "money that has not arrived was reported as paid")
        self.assertEqual(rows[0].pay_date, self.PAY)

    def test_it_becomes_paid_once_the_pay_date_passes(self):
        rows = self._rows(self._build(date(2026, 9, 11), yahoo_has_it=True))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].status, STATUS_PAID)

    def test_the_trailing_figure_still_counts_it(self):
        # It is within the trailing twelve months by ex-date, which is how
        # trailing yield is measured. Keying that sum on 'paid' alone would have
        # dropped it - and moved the reported yield - for those three weeks.
        result = self._build(date(2026, 8, 21), yahoo_has_it=True)
        # cutoff is exclusive, so 21 Aug 2025 falls just outside.
        self.assertAlmostEqual(result.trailing_12m, 0.83 + 0.91 + 0.91 + 0.91, places=6)

    def test_no_projection_is_invented_over_the_top_of_it(self):
        result = self._build(date(2026, 8, 21), yahoo_has_it=True)
        projected = [d for d in result.distributions
                     if d.status == STATUS_PROJECTED and abs((d.ex_date - self.EX).days) <= 20]
        self.assertEqual(projected, [], "a projection duplicated the real dividend")

class FundPayDateEstimateTests(unittest.TestCase):
    """No feed publishes mutual fund pay dates; Fidelity pays the next weekday."""

    def _fund(self, ex, pay=None):
        return Distribution(symbol="FXAIX", ex_date=ex, amount=0.5,
                            status=STATUS_PAID, kind="income", pay_date=pay,
                            source="Yahoo Finance")

    def test_a_midweek_ex_date_pays_the_next_day(self):
        dists = [self._fund(date(2026, 4, 8))]      # Wednesday
        self.assertEqual(_estimate_fund_pay_dates(dists), 1)
        self.assertEqual(dists[0].pay_date, date(2026, 4, 9))
        self.assertTrue(dists[0].pay_date_estimated)

    def test_a_friday_ex_date_skips_the_weekend(self):
        # The common case: most fund ex-dates land on a Friday.
        dists = [self._fund(date(2026, 7, 10))]     # Friday
        _estimate_fund_pay_dates(dists)
        self.assertEqual(dists[0].pay_date, date(2026, 7, 13))  # Monday

    def test_every_weekday_lands_on_a_weekday(self):
        # Whatever the ex-date, a payment never falls on a Saturday or Sunday.
        for day in range(1, 29):
            d = date(2026, 6, day)
            self.assertLess(next_business_day(d).weekday(), 5,
                            f"{d} produced a weekend pay date")
            self.assertGreater(next_business_day(d), d,
                               "the pay date must be after the ex-date")

    def test_a_published_pay_date_is_never_overwritten(self):
        # A pay date from config/announced.json names one specific
        # distribution, which beats a rule applied to all of them.
        dists = [self._fund(date(2026, 4, 8), pay=date(2026, 4, 15))]
        self.assertEqual(_estimate_fund_pay_dates(dists), 0)
        self.assertEqual(dists[0].pay_date, date(2026, 4, 15))
        self.assertFalse(dists[0].pay_date_estimated)

    def test_an_estimate_is_flagged_so_the_page_can_say_so(self):
        dists = [self._fund(date(2026, 4, 8))]
        _estimate_fund_pay_dates(dists)
        self.assertTrue(dists[0].to_json()["pay_date_estimated"])

    def test_a_real_pay_date_carries_no_flag_at_all(self):
        # Absent rather than false: it is the common case and carries no
        # information, and the page treats missing as "not estimated".
        dists = [self._fund(date(2026, 4, 8), pay=date(2026, 4, 9))]
        self.assertNotIn("pay_date_estimated", dists[0].to_json())

class ProjectedPayDateTests(unittest.TestCase):
    """Nobody has ever been paid a dividend on a Saturday."""

    def test_a_weekend_pay_date_rolls_forward(self):
        self.assertEqual(roll_to_business_day(date(2027, 12, 11)), date(2027, 12, 13))  # Sat -> Mon
        self.assertEqual(roll_to_business_day(date(2028, 12, 10)), date(2028, 12, 11))  # Sun -> Mon

    def test_a_weekday_is_left_exactly_alone(self):
        for day in (date(2026, 8, 3), date(2026, 8, 7)):   # Monday, Friday
            self.assertEqual(roll_to_business_day(day), day)

    def test_no_pay_date_stays_none(self):
        self.assertIsNone(roll_to_business_day(None))

    def test_projected_payments_never_land_on_a_weekend(self):
        # The real failure: a projected ex-date plus a median lag lands wherever
        # the arithmetic puts it. MSFT's 23-day lag put four projections on a
        # Saturday, invisible until the table started leading with the pay date.
        history = []
        ex = date(2020, 2, 19)
        for _ in range(12):
            history.append(Distribution(symbol="MSFT", ex_date=ex, amount=0.68,
                                        status=STATUS_PAID, kind="income",
                                        pay_date=ex + timedelta(days=23),
                                        source="test"))
            ex = ex + timedelta(days=91)
        projections, _ = project("MSFT", history, [], today=date(2026, 8, 4),
                                 horizon_years=3, hint_kind="equity")
        self.assertTrue(projections, "no projections were generated")
        for p in projections:
            if p.pay_date is None:
                continue
            self.assertLess(p.pay_date.weekday(), 5,
                            f"projected a payment on {p.pay_date:%A} ({p.pay_date})")
            self.assertGreaterEqual(p.pay_date, p.ex_date,
                                    "a payment cannot precede its ex-date")
