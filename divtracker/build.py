"""Pipeline entry point: fetch -> project -> write docs/data.json."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from . import __version__
from .model import STATUS_ANNOUNCED, SymbolResult
from .projection import next_business_day, project, trailing_12m
from .sources import (
    SourceError,
    fetch_nasdaq_declared,
    fetch_yahoo,
    load_manual_announcements,
    load_symbol_configs,
)

log = logging.getLogger("divtracker")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DOCS_DIR = ROOT / "docs"


def _load_json(path: Path) -> dict:
    if not path.exists():
        log.warning("config file missing: %s", path)
        return {}
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _apply_pay_dates(distributions: list, pay_dates: dict) -> int:
    """Fill in missing pay dates from a source that publishes them.

    Yahoo's dividend history carries an ex-date and an amount and nothing else,
    so every paid row arrives with pay_date=None - which is the one date that
    answers "when does the money reach my account". Nasdaq publishes it for the
    same dividends, so the two are merged here on the ex-date they share.

    Only blanks are filled. A pay date already present came from a source that
    named this specific dividend (an announcement, or the user's own
    config/announced.json), and that is better evidence than a lookup table.

    Returns how many were filled, so the caller can say nothing if the answer
    is zero rather than implying it enriched something.
    """

    if not pay_dates:
        return 0
    filled = 0
    for dist in distributions:
        if dist.pay_date is None and dist.ex_date in pay_dates:
            dist.pay_date = pay_dates[dist.ex_date]
            filled += 1
    return filled


def _estimate_fund_pay_dates(distributions: list) -> int:
    """Fill in missing pay dates for a mutual fund.

    No free feed publishes pay dates for open-end mutual funds: Yahoo carries
    none at all and Nasdaq does not cover funds. That left every fund row
    showing an ex-date, which answers the wrong question - the ex-date is when
    the NAV drops, not when the money is available.

    Fidelity pays its index funds on the next business day after the ex-date,
    unlike an equity where the gap is about three weeks. That regularity is
    what makes an estimate defensible here and not for a stock, so this is only
    ever applied to funds.

    Only blanks are filled; a pay date from config/announced.json names one
    specific distribution and always wins. Returns how many were estimated.
    """

    filled = 0
    for dist in distributions:
        if dist.pay_date is None and dist.ex_date is not None:
            dist.pay_date = next_business_day(dist.ex_date)
            dist.pay_date_estimated = True
            filled += 1
    return filled


def _dedupe(distributions: list) -> list:
    """Drop duplicates that arrive from more than one source for the same slot."""

    seen: dict[tuple, object] = {}
    for dist in sorted(distributions, key=lambda d: (d.ex_date, d.kind)):
        key = (dist.ex_date, dist.kind, round(dist.amount, 6))
        if key not in seen:
            seen[key] = dist
    return sorted(seen.values(), key=lambda d: d.ex_date)


def build_symbol(symbol_config, announcements: dict, today: date, horizon_years: int) -> SymbolResult:
    symbol = symbol_config.symbol
    result = SymbolResult(config=symbol_config)

    log.info("fetching %s", symbol)
    yahoo = fetch_yahoo(symbol)
    history = [d for d in yahoo["distributions"] if d.ex_date <= today]
    result.price = yahoo.get("price")
    result.currency = yahoo.get("currency") or "USD"
    if not result.config.name:
        result.config.name = yahoo.get("name") or symbol

    # Anything Yahoo reports with a future ex-date is already official.
    confirmed_future = [d for d in yahoo["distributions"] if d.ex_date > today]
    for dist in confirmed_future:
        dist.status = STATUS_ANNOUNCED
        dist.source = "Yahoo Finance (declared)"

    if symbol_config.kind != "fund":
        try:
            declared, pay_dates = fetch_nasdaq_declared(symbol, today)
            confirmed_future.extend(declared)
            _apply_pay_dates(history, pay_dates)
        except SourceError as exc:
            result.warnings.append(f"Could not check Nasdaq for declared dividends: {exc}")

    confirmed_future.extend(announcements.get(symbol, []))
    confirmed_future = _dedupe(confirmed_future)

    # Nasdaq now carries a dividend until it is paid and Yahoo starts carrying it
    # a day or so after it goes ex, so for that window both describe the SAME
    # payment. Keep the history copy: _apply_pay_dates has already given it the
    # pay date, so nothing is lost, and the projection keeps the newest point in
    # its series. Without this the row would be listed twice between the ex-date
    # and the pay date.
    history_keys = {(d.ex_date, d.kind, round(d.amount, 6)) for d in history}
    confirmed_future = [
        d for d in confirmed_future
        if (d.ex_date, d.kind, round(d.amount, 6)) not in history_keys
    ]

    # Going ex is not the same as being paid - MSFT goes ex about three weeks
    # before the cash lands. Status was decided by the ex-date alone, so the
    # morning after a dividend went ex it was filed as settled history, and
    # everything that asks "what is still coming" skipped money that had not
    # turned up yet. Once a pay date is known, that is what decides.
    for dist in history:
        if dist.pay_date and dist.pay_date > today:
            dist.status = STATUS_ANNOUNCED

    if symbol_config.kind == "fund" and not confirmed_future:
        result.warnings.append(
            "No public feed publishes announced distributions for open-end mutual funds. "
            "Future rows are projections until you add the published figure to "
            "config/announced.json."
        )

    projections, diagnostics = project(
        symbol,
        history,
        confirmed_future,
        today=today,
        horizon_years=horizon_years,
        hint_kind=symbol_config.kind,
    )
    result.warnings.extend(diagnostics.get("warnings", []))
    result.cadence = diagnostics.get("cadence", symbol_config.expected_cadence or "unknown")
    result.cadence_days = diagnostics.get("cadence_days")
    result.growth_rate = diagnostics.get("growth")

    if any(d.kind == "capital_gain" for d in history):
        result.warnings.append(
            "Capital-gain distributions are reported separately by the data provider."
        )
    elif symbol_config.kind == "fund":
        result.warnings.append(
            "The data provider folds capital-gain distributions into the same stream as "
            "income, so a large December figure normally includes both."
        )

    result.distributions = history + confirmed_future + projections

    # No free feed publishes pay dates for open-end mutual funds, which left
    # every fund row showing an ex-date - the date the NAV drops, not the date
    # the money is available. Fidelity pays its index funds the next business
    # day, and that regularity is what makes an estimate defensible here and
    # not for an equity, where the gap is about three weeks and varies.
    if symbol_config.kind == "fund":
        estimated = _estimate_fund_pay_dates(result.distributions)
        if estimated:
            result.warnings.append(
                "Pay dates for this fund are estimated as the next business day "
                "after the ex-date, because no free feed publishes them. Add a "
                "pay_date to config/announced.json to pin down any that matter."
            )
    elif result.distributions and not any(d.pay_date for d in result.distributions):
        # An equity with no pay dates at all means the Nasdaq lookup failed;
        # guessing one would be far wider of the mark than saying nothing.
        result.warnings.append(
            "No pay dates were available for this symbol, so rows show the "
            "ex-date instead."
        )

    result.trailing_12m = trailing_12m(result.distributions, today)
    if result.price:
        result.yield_pct = (result.trailing_12m / result.price) * 100.0
    return result


def build(today: date, horizon_years: int, out_path: Path) -> dict:
    symbols_cfg = _load_json(CONFIG_DIR / "symbols.json")
    announced_cfg = _load_json(CONFIG_DIR / "announced.json")

    symbol_configs = load_symbol_configs(symbols_cfg)
    if not symbol_configs:
        raise SystemExit("No symbols configured in config/symbols.json")

    announcements = load_manual_announcements(announced_cfg, today)

    results = []
    errors = []
    for symbol_config in symbol_configs:
        try:
            results.append(build_symbol(symbol_config, announcements, today, horizon_years))
        except SourceError as exc:
            log.error("%s failed: %s", symbol_config.symbol, exc)
            errors.append({"symbol": symbol_config.symbol, "error": str(exc)})

    if not results:
        raise SystemExit("Every symbol failed to build; refusing to overwrite existing data.")

    payload = {
        "generatedAt": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
        "asOfDate": today.isoformat(),
        "version": __version__,
        "horizonYears": horizon_years,
        "sources": [
            "Yahoo Finance chart API (realized history and prices)",
            "Nasdaq quote API (declared but unpaid dividends, equities and ETFs)",
            "config/announced.json (manually entered official announcements)",
        ],
        "errors": errors,
        "symbols": [r.to_json() for r in results],
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    tmp_path.replace(out_path)
    return payload


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Build the dividend and distribution dataset.")
    parser.add_argument("--out", default=str(DOCS_DIR / "data.json"), help="output JSON path")
    parser.add_argument("--horizon-years", type=int, default=3, help="how far ahead to project")
    parser.add_argument("--today", default=None, help="override today's date (YYYY-MM-DD), for testing")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    today = (
        datetime.strptime(args.today, "%Y-%m-%d").date()
        if args.today
        else datetime.now(tz=timezone.utc).date()
    )

    payload = build(today, args.horizon_years, Path(args.out))

    for symbol in payload["symbols"]:
        counts: dict[str, int] = {}
        for dist in symbol["distributions"]:
            counts[dist["status"]] = counts.get(dist["status"], 0) + 1
        log.info(
            "%-6s %-38s paid=%d announced=%d projected=%d  ttm=$%.4f/share",
            symbol["symbol"],
            symbol["name"][:38],
            counts.get("paid", 0),
            counts.get("announced", 0),
            counts.get("projected", 0),
            symbol["trailing12m"] or 0.0,
        )
    if payload["errors"]:
        log.warning("completed with errors: %s", payload["errors"])
    log.info("wrote %s", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
