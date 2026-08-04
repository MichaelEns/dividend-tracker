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
from divtracker.projection import annual_growth_rate, infer_cadence, project
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
