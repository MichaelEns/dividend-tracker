"""Projection engine for future, not-yet-announced distributions.

Everything produced here is an *estimate*. Each projected row carries
``status='projected'``, a confidence score and a ``basis`` string explaining how
the number was derived, so the UI can keep it visually separate from money that
has actually been declared.

Two payout shapes are recognised, chosen automatically from the history:

``level_step``
    The per-payment amount is flat across a year and steps up once a year.
    This is the classic dividend-growth equity pattern (MSFT: four payments of
    the same size, raised with the September declaration).

``seasonal``
    The amount swings widely between slots but each calendar slot behaves
    consistently year over year. This is how index mutual funds behave - a small
    April income payment and a large December payment that also carries the
    capital-gain distribution (FSKAX, FXAIX).
"""

from __future__ import annotations

import calendar
import statistics
from collections import Counter, defaultdict
from datetime import date, timedelta
from typing import Iterable, Optional

from .model import STATUS_PROJECTED, Distribution

# Cadence label -> nominal days between payments.
CADENCE_DAYS = {
    "monthly": 30,
    "quarterly": 91,
    "semiannual": 182,
    "annual": 365,
}

# Guard rails so a noisy history cannot produce an absurd forecast.
MAX_ANNUAL_GROWTH = 0.25
MIN_ANNUAL_GROWTH = -0.15
LEVEL_MODEL_MAX_CV = 0.08


def _median(values: Iterable[float]) -> float:
    data = list(values)
    return statistics.median(data) if data else 0.0


def _totals_by_ex_date(distributions: list[Distribution]) -> list[tuple[date, float]]:
    """Collapse same-day income + capital-gain rows into one total per ex-date."""

    totals: dict[date, float] = defaultdict(float)
    for dist in distributions:
        totals[dist.ex_date] += dist.amount
    return sorted(totals.items())


PAYMENTS_PER_YEAR_LABEL = {1: "annual", 2: "semiannual", 3: "three times a year", 4: "quarterly", 12: "monthly"}


def infer_cadence(ex_dates: list[date], slots_per_year: Optional[int] = None) -> tuple[str, Optional[int]]:
    """Infer payout cadence.

    The number of distribution slots per year is the reliable signal. Gap-based
    inference misclassifies funds such as FSKAX, which pays only in April and
    December: the short Dec->Apr gap looks quarterly even though the fund pays
    twice a year. The median gap is still returned for display.
    """

    recent = ex_dates[-13:]
    if len(recent) < 2:
        return "unknown", None
    gaps = [(b - a).days for a, b in zip(recent, recent[1:]) if (b - a).days > 0]
    median_gap = int(_median(gaps)) if gaps else None

    if slots_per_year:
        label = PAYMENTS_PER_YEAR_LABEL.get(slots_per_year)
        if label:
            return label, median_gap
        return f"{slots_per_year}x per year", median_gap

    if median_gap is None:
        return "unknown", None
    label = min(CADENCE_DAYS, key=lambda name: abs(CADENCE_DAYS[name] - median_gap))
    if abs(CADENCE_DAYS[label] - median_gap) > 45:
        return "irregular", median_gap
    return label, median_gap


def _slot_months(series: list[tuple[date, float]], lookback_years: int = 3) -> list[int]:
    """Months of the year in which this security normally distributes."""

    if not series:
        return []
    cutoff = series[-1][0] - timedelta(days=365 * lookback_years + 20)
    months = Counter(d.month for d, _ in series if d >= cutoff)
    if not months:
        months = Counter(d.month for d, _ in series)
    # A month counts as a real slot if it shows up in most of the sampled years.
    top = max(months.values())
    threshold = max(1, top - 1)
    return sorted(month for month, count in months.items() if count >= threshold)


def _typical_day(series: list[tuple[date, float]], month: int) -> int:
    days = [d.day for d, _ in series if d.month == month][-4:]
    return int(_median(days)) if days else 15


def _adjust_to_weekday(value: date) -> date:
    """Nudge weekend dates onto the neighbouring trading day."""

    if value.weekday() == 5:      # Saturday -> Friday
        return value - timedelta(days=1)
    if value.weekday() == 6:      # Sunday -> Monday
        return value + timedelta(days=1)
    return value


def _safe_date(year: int, month: int, day: int) -> date:
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, min(day, last_day))


def _intra_year_cv(series: list[tuple[date, float]]) -> float:
    """Median coefficient of variation of payment sizes within a calendar year."""

    by_year: dict[int, list[float]] = defaultdict(list)
    for ex_date, amount in series:
        by_year[ex_date.year].append(amount)
    cvs = []
    for amounts in by_year.values():
        if len(amounts) < 2:
            continue
        mean = statistics.fmean(amounts)
        if mean <= 0:
            continue
        cvs.append(statistics.pstdev(amounts) / mean)
    return _median(cvs) if cvs else 1.0


def annual_growth_rate(series: list[tuple[date, float]]) -> float:
    """Median year-over-year growth of trailing annual totals, clamped."""

    by_year: dict[int, float] = defaultdict(float)
    for ex_date, amount in series:
        by_year[ex_date.year] += amount
    years = sorted(by_year)
    # Drop the current (incomplete) year so a partial total cannot fake a decline.
    complete = [y for y in years if y < (series[-1][0].year if series else 0)]
    if len(complete) < 2:
        return 0.0
    ratios = []
    for prev, curr in zip(complete, complete[1:]):
        if curr - prev != 1 or by_year[prev] <= 0:
            continue
        ratios.append(by_year[curr] / by_year[prev] - 1.0)
    if not ratios:
        return 0.0
    return max(MIN_ANNUAL_GROWTH, min(MAX_ANNUAL_GROWTH, _median(ratios)))


def _detect_raise(series: list[tuple[date, float]]) -> tuple[Optional[int], float]:
    """Find the month a level-payer normally raises, and the typical raise size."""

    months: Counter[int] = Counter()
    pcts: list[float] = []
    for (_, prev_amt), (curr_date, curr_amt) in zip(series, series[1:]):
        if prev_amt > 0 and curr_amt > prev_amt * 1.005:
            months[curr_date.month] += 1
            pcts.append(curr_amt / prev_amt - 1.0)
    if not months:
        return None, 0.0
    raise_month = months.most_common(1)[0][0]
    typical = max(0.0, min(MAX_ANNUAL_GROWTH, _median(pcts)))
    return raise_month, typical


def _slot_confidence(series: list[tuple[date, float]], month: int) -> float:
    """Lower confidence for slots whose size has historically been erratic."""

    amounts = [amount for d, amount in series if d.month == month][-5:]
    if len(amounts) < 2:
        return 0.55
    mean = statistics.fmean(amounts)
    if mean <= 0:
        return 0.5
    cv = statistics.pstdev(amounts) / mean
    return max(0.25, min(0.92, 1.0 / (1.0 + 2.2 * cv)))


def _slot_coverage(series: list[tuple[date, float]], month: int, years: int = 3) -> float:
    """Fraction of recent years in which this slot actually paid out.

    A slot that shows up every year is far more predictable than one that only
    appeared once, so this scales the projection's confidence.
    """

    if not series:
        return 0.0
    latest_year = series[-1][0].year
    window = [latest_year - offset for offset in range(1, years + 1)]
    seen = {d.year for d, _ in series if d.month == month}
    hits = sum(1 for year in window if year in seen)
    return hits / len(window)


def next_business_day(day: date) -> date:
    """The next weekday after `day`.

    Weekends only; US market holidays are not modelled. That is a deliberate
    limit on an estimate rather than an oversight: a holiday pushes a payment
    one further day, and carrying a holiday calendar to shave one day off an
    approximation is more machinery than the accuracy is worth.
    """

    nxt = day + timedelta(days=1)
    while nxt.weekday() >= 5:  # 5 = Saturday, 6 = Sunday
        nxt = nxt + timedelta(days=1)
    return nxt


def roll_to_business_day(day: Optional[date]) -> Optional[date]:
    """Move a date off a weekend, leaving weekdays alone.

    Applied to projected pay dates. A projected ex-date plus a median lag lands
    wherever the arithmetic puts it, including Saturdays - and nobody has ever
    been paid a dividend on a Saturday. Left uncorrected it was invisible while
    the table led with the ex-date, and became wrong on screen the moment the
    pay date was promoted to the prominent line.
    """

    if day is None or day.weekday() < 5:
        return day
    return next_business_day(day)


def _pay_lag(distributions: list[Distribution]) -> Optional[int]:
    lags = [
        (d.pay_date - d.ex_date).days
        for d in distributions
        if d.pay_date and d.ex_date and 0 <= (d.pay_date - d.ex_date).days < 90
    ]
    return int(_median(lags)) if lags else None


def project(
    symbol: str,
    history: list[Distribution],
    confirmed_future: list[Distribution],
    *,
    today: date,
    horizon_years: int = 3,
    hint_kind: str = "equity",
) -> tuple[list[Distribution], dict]:
    """Generate projected distributions beyond the last confirmed one.

    Returns the projections plus diagnostics describing the fitted model.
    """

    series = _totals_by_ex_date(history)
    diagnostics: dict = {"model": "none", "growth": 0.0, "warnings": []}
    if len(series) < 3:
        diagnostics["warnings"].append(
            "Not enough distribution history to project future payments."
        )
        return [], diagnostics

    ex_dates = [d for d, _ in series]
    months = _slot_months(series)
    if not months:
        diagnostics["warnings"].append("Could not determine a distribution schedule.")
        return [], diagnostics

    cadence, cadence_days = infer_cadence(ex_dates, slots_per_year=len(months))
    diagnostics["cadence"] = cadence
    diagnostics["cadence_days"] = cadence_days
    diagnostics["slot_months"] = months

    growth = annual_growth_rate(series)
    diagnostics["growth"] = growth

    cv = _intra_year_cv(series)
    use_level = cv <= LEVEL_MODEL_MAX_CV and hint_kind != "fund"
    diagnostics["model"] = "level_step" if use_level else "seasonal"
    diagnostics["intra_year_cv"] = round(cv, 4)

    has_capital_gains = any(d.kind == "capital_gain" for d in history)
    projected_kind = "distribution" if (has_capital_gains or hint_kind == "fund") else "income"

    pay_lag = _pay_lag(history + confirmed_future)

    # Projections start only after everything already confirmed.
    confirmed_dates = [d.ex_date for d in confirmed_future]
    last_confirmed = max([ex_dates[-1]] + confirmed_dates)
    blocked = sorted(confirmed_dates)

    # Anchor amounts for the level model: the newest confirmed per-payment amount.
    if confirmed_future:
        level_amount = max(confirmed_future, key=lambda d: d.ex_date).amount
    else:
        level_amount = series[-1][1]
    raise_month, raise_pct = _detect_raise(series)
    if raise_pct == 0.0:
        raise_pct = max(0.0, growth)
    diagnostics["raise_month"] = raise_month
    diagnostics["raise_pct"] = round(raise_pct, 4)

    # Most recent historical amount for each seasonal slot.
    last_by_month: dict[int, tuple[date, float]] = {}
    for ex_date, amount in series:
        last_by_month[ex_date.month] = (ex_date, amount)

    # Track whether the level model has already applied this year's raise.
    raise_applied_years: set[int] = set()
    if raise_month is not None:
        for ex_date, _ in series[-6:]:
            if ex_date.month == raise_month:
                raise_applied_years.add(ex_date.year)
        for dist in confirmed_future:
            if dist.ex_date.month == raise_month:
                raise_applied_years.add(dist.ex_date.year)

    projections: list[Distribution] = []
    horizon_end = today + timedelta(days=int(365.25 * horizon_years))
    start_year = max(today.year, last_confirmed.year)

    for year in range(start_year, horizon_end.year + 2):
        for month in months:
            ex_date = _adjust_to_weekday(_safe_date(year, month, _typical_day(series, month)))
            if ex_date <= last_confirmed or ex_date <= today or ex_date > horizon_end:
                continue
            # Skip a slot already covered by an announced distribution.
            if any(abs((ex_date - c).days) <= 20 for c in blocked):
                continue

            years_out = max(0.0, (ex_date - today).days / 365.25)

            if use_level:
                if raise_month is not None and month == raise_month and year not in raise_applied_years:
                    level_amount *= 1.0 + raise_pct
                    raise_applied_years.add(year)
                amount = level_amount
                basis = (
                    f"Held flat at the latest declared rate, with a {raise_pct * 100:.1f}% "
                    f"annual raise applied each {calendar.month_abbr[raise_month]}"
                    if raise_month
                    else "Held flat at the latest declared rate"
                )
                confidence = 0.85
            else:
                anchor = last_by_month.get(month)
                if anchor is None:
                    continue
                anchor_date, anchor_amount = anchor
                elapsed_years = max(1, year - anchor_date.year)
                amount = anchor_amount * ((1.0 + growth) ** elapsed_years)
                basis = (
                    f"{calendar.month_abbr[month]} {anchor_date.year} distribution of "
                    f"${anchor_amount:,.4f}/share grown {growth * 100:+.1f}%/yr"
                )
                confidence = _slot_confidence(series, month)

            # A slot that has not paid reliably every year is a weaker bet, and
            # every extra year of horizon compounds the uncertainty.
            confidence *= 0.55 + 0.45 * _slot_coverage(series, month)
            confidence *= 0.88 ** years_out

            projections.append(
                Distribution(
                    symbol=symbol,
                    ex_date=ex_date,
                    amount=round(amount, 6),
                    status=STATUS_PROJECTED,
                    kind=projected_kind,
                    pay_date=roll_to_business_day(
                        ex_date + timedelta(days=pay_lag) if pay_lag is not None else None),
                    source="projection",
                    confidence=round(max(0.05, min(0.95, confidence)), 3),
                    basis=basis,
                )
            )

    projections.sort(key=lambda d: d.ex_date)
    return projections, diagnostics


def trailing_12m(distributions: list[Distribution], today: date) -> float:
    cutoff = today - timedelta(days=365)
    return sum(
        d.amount
        for d in distributions
        if d.status == "paid" and cutoff < d.ex_date <= today
    )
