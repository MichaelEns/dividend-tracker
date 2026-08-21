"""Tests for the projection engine.

Synthetic histories model the two real payout shapes this tool tracks: a
dividend-growth equity (MSFT) and a seasonal index mutual fund (FSKAX).
"""

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from divtracker.model import (  # noqa: E402
    STATUS_ANNOUNCED,
    STATUS_PAID,
    STATUS_PROJECTED,
    Distribution,
)
from divtracker.projection import (  # noqa: E402
    annual_growth_rate,
    infer_cadence,
    project,
    trailing_12m,
)


def make(symbol, ex_date, amount, status=STATUS_PAID, kind="income", **kwargs):
    return Distribution(
        symbol=symbol, ex_date=ex_date, amount=amount, status=status, kind=kind, **kwargs
    )


def msft_history():
    """Quarterly payer that raises ~10% each November."""
    rows = []
    amount = 0.62
    for year in (2022, 2023, 2024, 2025):
        for month, day in ((2, 16), (5, 18), (8, 17), (11, 16)):
            if month == 11:
                amount = round(amount * 1.10, 2)
            rows.append(make("MSFT", date(year, month, day), amount))
    rows.append(make("MSFT", date(2026, 2, 18), amount))
    rows.append(make("MSFT", date(2026, 5, 20), amount))
    return rows


def fund_history():
    """Semiannual fund: small April income, large December total."""
    rows = []
    for year in (2021, 2022, 2023, 2024, 2025):
        rows.append(make("FSKAX", date(year, 4, 10), round(0.10 * (1.03 ** (year - 2021)), 4)))
        rows.append(make("FSKAX", date(year, 12, 18), round(1.50 * (1.03 ** (year - 2021)), 4)))
    rows.append(make("FSKAX", date(2026, 4, 10), 0.1160))
    return rows


class CadenceTests(unittest.TestCase):
    def test_slot_count_drives_label(self):
        # Apr/Dec spacing looks quarterly by gap, but the fund pays twice a year.
        ex_dates = [d.ex_date for d in fund_history()]
        label, _ = infer_cadence(ex_dates, slots_per_year=2)
        self.assertEqual(label, "semiannual")

    def test_quarterly_equity(self):
        ex_dates = [d.ex_date for d in msft_history()]
        label, gap = infer_cadence(ex_dates, slots_per_year=4)
        self.assertEqual(label, "quarterly")
        self.assertTrue(80 <= gap <= 100)


class GrowthTests(unittest.TestCase):
    def test_growth_is_clamped(self):
        rows = [make("X", date(2022, 3, 1), 1.0), make("X", date(2023, 3, 1), 5.0),
                make("X", date(2024, 3, 1), 25.0), make("X", date(2025, 3, 1), 60.0)]
        series = [(d.ex_date, d.amount) for d in rows]
        self.assertLessEqual(annual_growth_rate(series), 0.25)

    def test_incomplete_current_year_ignored(self):
        rows = [make("X", date(y, m, 15), 1.0) for y in (2023, 2024, 2025) for m in (3, 6, 9, 12)]
        rows.append(make("X", date(2026, 3, 15), 1.0))
        series = [(d.ex_date, d.amount) for d in rows]
        self.assertAlmostEqual(annual_growth_rate(series), 0.0, places=6)


class ProjectionTests(unittest.TestCase):
    today = date(2026, 8, 4)

    def test_equity_uses_level_model_and_respects_announced(self):
        announced = [
            make("MSFT", date(2026, 8, 19), 0.91, status=STATUS_ANNOUNCED, pay_date=date(2026, 9, 10))
        ]
        projections, diag = project(
            "MSFT", msft_history(), announced, today=self.today, horizon_years=2, hint_kind="equity"
        )
        self.assertEqual(diag["model"], "level_step")
        self.assertEqual(diag["raise_month"], 11)
        self.assertTrue(projections)

        # Nothing may be projected on top of an announced payment.
        for row in projections:
            self.assertGreater(row.ex_date, announced[0].ex_date)
            self.assertEqual(row.status, "projected")
            self.assertIsNotNone(row.confidence)

        # The projection anchors to the announced rate, then raises in November.
        november = [p for p in projections if p.ex_date.month == 11][0]
        february = [p for p in projections if p.ex_date.month == 2][0]
        self.assertGreater(november.amount, 0.91)
        self.assertAlmostEqual(november.amount, february.amount, places=6)

    def test_fund_uses_seasonal_model_and_keeps_slot_shape(self):
        projections, diag = project(
            "FSKAX", fund_history(), [], today=self.today, horizon_years=2, hint_kind="fund"
        )
        self.assertEqual(diag["model"], "seasonal")
        self.assertEqual(diag["slot_months"], [4, 12])

        december = [p for p in projections if p.ex_date.month == 12]
        april = [p for p in projections if p.ex_date.month == 4]
        self.assertTrue(december and april)
        # December must stay the large distribution; a flat model would erase this.
        self.assertGreater(december[0].amount, april[0].amount * 5)

    def test_confidence_decays_with_horizon(self):
        projections, _ = project(
            "FSKAX", fund_history(), [], today=self.today, horizon_years=4, hint_kind="fund"
        )
        december = sorted(
            [p for p in projections if p.ex_date.month == 12], key=lambda p: p.ex_date
        )
        self.assertGreaterEqual(len(december), 2)
        self.assertLess(december[-1].confidence, december[0].confidence)

    def test_projections_never_land_in_the_past(self):
        projections, _ = project(
            "MSFT", msft_history(), [], today=self.today, horizon_years=3, hint_kind="equity"
        )
        for row in projections:
            self.assertGreater(row.ex_date, self.today)

    def test_projected_dates_avoid_weekends(self):
        projections, _ = project(
            "FSKAX", fund_history(), [], today=self.today, horizon_years=3, hint_kind="fund"
        )
        for row in projections:
            self.assertLess(row.ex_date.weekday(), 5, f"{row.ex_date} falls on a weekend")

    def test_short_history_produces_no_projection(self):
        rows = [make("NEW", date(2026, 1, 5), 0.2)]
        projections, diag = project("NEW", rows, [], today=self.today, hint_kind="equity")
        self.assertEqual(projections, [])
        self.assertTrue(diag["warnings"])

    def test_horizon_is_respected(self):
        projections, _ = project(
            "MSFT", msft_history(), [], today=self.today, horizon_years=1, hint_kind="equity"
        )
        for row in projections:
            self.assertLessEqual((row.ex_date - self.today).days, 372)


class TrailingTests(unittest.TestCase):
    def test_a_dividend_that_has_not_gone_ex_yet_does_not_count(self):
        rows = msft_history() + [
            make("MSFT", date(2026, 8, 19), 0.91, status=STATUS_ANNOUNCED)
        ]
        total = trailing_12m(rows, date(2026, 8, 4))
        # Window covers Aug 2025 (still the pre-raise 0.83) plus Nov 2025, Feb 2026
        # and May 2026 at 0.91. The August 2026 row has not gone ex yet.
        self.assertAlmostEqual(total, 0.83 + 0.91 * 3, places=6)

    def test_a_projection_never_counts(self):
        rows = msft_history() + [
            make("MSFT", date(2026, 8, 19), 0.91, status=STATUS_PROJECTED)
        ]
        total = trailing_12m(rows, date(2026, 8, 20))
        self.assertAlmostEqual(total, 0.91 * 3, places=6)

    def test_a_dividend_that_has_gone_ex_but_not_paid_still_counts(self):
        # Trailing yield is measured at the ex-date: that is when the share price
        # drops by the dividend, so it is earned even though the cash lands weeks
        # later. Keying this sum on 'paid' alone would drop the newest dividend -
        # and visibly cut the reported yield - for the three weeks each quarter
        # between MSFT's ex-date and its pay date.
        rows = msft_history() + [
            make("MSFT", date(2026, 8, 19), 0.91,
                 status=STATUS_ANNOUNCED, pay_date=date(2026, 9, 10))
        ]
        total = trailing_12m(rows, date(2026, 8, 20))
        self.assertAlmostEqual(total, 0.91 * 4, places=6)


if __name__ == "__main__":
    unittest.main()
