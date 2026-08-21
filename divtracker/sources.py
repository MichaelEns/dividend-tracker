"""Upstream data sources.

Only the Python standard library is used so the pipeline runs in CI with no
install step and cannot break on a dependency resolution failure.

Sources
-------
Yahoo Finance chart API : realized dividend / capital-gain history plus the last
                          traded price. Covers equities, ETFs and open-end mutual
                          funds, which is why it is the backbone here.
Nasdaq quote API        : dividends that have been *declared but not yet paid*.
                          Equities and ETFs only - it rejects mutual fund symbols.
"""

from __future__ import annotations

import json
import logging
import ssl
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from .model import (
    STATUS_ANNOUNCED,
    STATUS_PAID,
    Distribution,
    SymbolConfig,
)

log = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

YAHOO_CHART = (
    "https://query{host}.finance.yahoo.com/v8/finance/chart/{symbol}"
    "?period1={start}&period2={end}&interval=1d&events=div%7Csplit%7CcapitalGain"
)
NASDAQ_DIVIDENDS = "https://api.nasdaq.com/api/quote/{symbol}/dividends?assetclass={assetclass}"

# Market timestamps come back as seconds UTC at ~09:30 America/New_York. Shifting
# back 5 hours before taking the date yields the correct Eastern calendar day
# without needing the IANA tz database (absent on stock Windows Python).
_ET_SHIFT = timedelta(hours=5)


class SourceError(RuntimeError):
    """Raised when a source cannot be reached or returns unusable data."""


def _get(url: str, *, timeout: int = 30, attempts: int = 3) -> bytes:
    last_err: Optional[Exception] = None
    ctx = ssl.create_default_context()
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": _UA,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                return resp.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            last_err = exc
            if attempt < attempts:
                sleep_for = 1.5 * attempt
                log.debug("fetch failed (%s), retrying in %.1fs: %s", exc, sleep_for, url)
                time.sleep(sleep_for)
    raise SourceError(f"could not fetch {url}: {last_err}")


def _get_json(url: str, **kwargs) -> dict:
    raw = _get(url, **kwargs)
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise SourceError(f"invalid JSON from {url}: {exc}") from exc


def _ts_to_et_date(ts: int) -> date:
    return (datetime.fromtimestamp(int(ts), tz=timezone.utc) - _ET_SHIFT).date()


def _parse_us_date(value: str) -> Optional[date]:
    value = (value or "").strip()
    if not value or value.upper() in {"N/A", "--", "NA"}:
        return None
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%b %d, %Y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    return None


def _parse_money(value: str) -> Optional[float]:
    text = (value or "").replace("$", "").replace(",", "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def fetch_yahoo(symbol: str, years_back: int = 12) -> dict:
    """Return realized distributions and quote metadata from Yahoo Finance."""

    start = int((datetime.now(tz=timezone.utc) - timedelta(days=365 * years_back)).timestamp())
    end = int((datetime.now(tz=timezone.utc) + timedelta(days=400)).timestamp())

    payload = None
    last_err: Optional[Exception] = None
    for host in (1, 2):
        url = YAHOO_CHART.format(host=host, symbol=symbol, start=start, end=end)
        try:
            payload = _get_json(url)
            break
        except SourceError as exc:
            last_err = exc
    if payload is None:
        raise SourceError(f"Yahoo unavailable for {symbol}: {last_err}")

    chart = payload.get("chart") or {}
    if chart.get("error"):
        raise SourceError(f"Yahoo error for {symbol}: {chart['error']}")
    results = chart.get("result") or []
    if not results:
        raise SourceError(f"Yahoo returned no result for {symbol}")

    result = results[0]
    meta = result.get("meta") or {}
    events = result.get("events") or {}

    distributions: list[Distribution] = []
    for kind, bucket in (("income", "dividends"), ("capital_gain", "capitalGains")):
        for entry in (events.get(bucket) or {}).values():
            amount = entry.get("amount")
            ts = entry.get("date")
            if amount is None or ts is None:
                continue
            amount = float(amount)
            if amount <= 0:
                continue
            distributions.append(
                Distribution(
                    symbol=symbol,
                    ex_date=_ts_to_et_date(ts),
                    amount=amount,
                    status=STATUS_PAID,
                    kind=kind,
                    source="Yahoo Finance",
                )
            )

    distributions.sort(key=lambda d: d.ex_date)
    return {
        "distributions": distributions,
        "price": meta.get("regularMarketPrice"),
        "currency": meta.get("currency") or "USD",
        "name": meta.get("longName") or meta.get("shortName") or "",
        "instrument_type": meta.get("instrumentType") or "",
    }


def fetch_nasdaq_declared(symbol: str, today: date) -> tuple[list[Distribution], dict[date, date]]:
    """Return Nasdaq's declared-but-not-yet-paid dividends, plus every pay date.

    Two things come back because one request carries both, and the second was
    previously being thrown away. Nasdaq's table spans years of *past*
    dividends, each with a paymentDate, but this function only ever kept the
    future rows - Yahoo is the authority for historical amounts, so the past
    rows looked redundant. Their pay dates are not redundant: Yahoo publishes
    no pay date at all, so discarding them left the entire paid history unable
    to say when the money actually arrived, which for an equity is about three
    weeks after the ex-date.

    The second return value therefore maps ex_date -> pay_date for every row
    Nasdaq reports, past and future, for callers to merge into history.

    Mutual funds are not covered by this endpoint; callers should treat an
    empty list as "no confirmation available" rather than "no future dividend",
    and an empty map as "no pay dates published" rather than "paid same day".
    """

    out: list[Distribution] = []
    pay_dates: dict[date, date] = {}
    payload = None
    for assetclass in ("stocks", "etf"):
        try:
            candidate = _get_json(NASDAQ_DIVIDENDS.format(symbol=symbol, assetclass=assetclass))
        except SourceError as exc:
            log.debug("nasdaq %s/%s failed: %s", symbol, assetclass, exc)
            continue
        if (candidate.get("data") or {}).get("dividends"):
            payload = candidate
            break
    if payload is None:
        return out, pay_dates

    rows = ((payload.get("data") or {}).get("dividends") or {}).get("rows") or []
    for row in rows:
        ex_date = _parse_us_date(row.get("exOrEffDate", ""))
        amount = _parse_money(row.get("amount", ""))
        pay_date = _parse_us_date(row.get("paymentDate", ""))

        # Collected before the amount check: a pay date is still usable even
        # from a row whose amount Nasdaq formats in a way we cannot parse, and
        # a pay date that precedes its ex-date is a data error, not a schedule.
        if ex_date is not None and pay_date is not None and pay_date >= ex_date:
            pay_dates[ex_date] = pay_date

        if ex_date is None or amount is None or amount <= 0:
            continue
        # Drop the row only once the money has actually arrived, not when it
        # goes ex. Skipping everything with a past ex-date opened a hole: Nasdaq
        # stops offering a dividend on its ex-date, but Yahoo does not report one
        # until a day or so afterwards, so for that window NEITHER source carried
        # it and a declared dividend disappeared from the app outright - three
        # weeks before it was due to be paid. Yahoo stays the authority for
        # anything genuinely settled; a row with no pay date falls back to the
        # ex-date, which is the old behaviour.
        settled = pay_date if pay_date is not None else ex_date
        if settled <= today:
            continue
        row_type = (row.get("type") or "").strip().lower()
        kind = "capital_gain" if "capital" in row_type else "income"
        out.append(
            Distribution(
                symbol=symbol,
                ex_date=ex_date,
                amount=amount,
                status=STATUS_ANNOUNCED,
                kind=kind,
                pay_date=pay_date,
                record_date=_parse_us_date(row.get("recordDate", "")),
                declared_date=_parse_us_date(row.get("declarationDate", "")),
                source="Nasdaq (declared)",
            )
        )

    out.sort(key=lambda d: d.ex_date)
    return out, pay_dates


def load_manual_announcements(config: dict, today: date) -> dict[str, list[Distribution]]:
    """Parse config/announced.json into per-symbol confirmed distributions."""

    by_symbol: dict[str, list[Distribution]] = {}
    for row in config.get("announced") or []:
        symbol = (row.get("symbol") or "").upper().strip()
        amount = row.get("amount")
        ex_date = _parse_us_date(row.get("ex_date", ""))
        if not symbol or amount is None or ex_date is None:
            continue  # placeholder/example rows are skipped by design
        try:
            amount = float(amount)
        except (TypeError, ValueError):
            continue
        if amount <= 0 or ex_date <= today:
            continue
        by_symbol.setdefault(symbol, []).append(
            Distribution(
                symbol=symbol,
                ex_date=ex_date,
                amount=amount,
                status=STATUS_ANNOUNCED,
                kind=(row.get("kind") or "income"),
                pay_date=_parse_us_date(row.get("pay_date", "")),
                record_date=_parse_us_date(row.get("record_date", "")),
                declared_date=_parse_us_date(row.get("declared_date", "")),
                source=row.get("source") or "manual announcement",
                note=row.get("note") or "",
            )
        )
    return by_symbol


def load_symbol_configs(config: dict) -> list[SymbolConfig]:
    configs: list[SymbolConfig] = []
    for row in config.get("symbols") or []:
        symbol = (row.get("symbol") or "").upper().strip()
        if not symbol:
            continue
        configs.append(
            SymbolConfig(
                symbol=symbol,
                name=row.get("name") or "",
                kind=(row.get("kind") or "equity").lower(),
                expected_cadence=(row.get("expected_cadence") or "").lower(),
                notes=row.get("notes") or "",
            )
        )
    return configs
