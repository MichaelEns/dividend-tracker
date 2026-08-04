"""Core data types shared across the pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import date
from typing import Optional

# Lifecycle of a distribution.
STATUS_PAID = "paid"           # ex-date has passed; amount is history
STATUS_ANNOUNCED = "announced"  # officially declared by the issuer, not yet paid
STATUS_PROJECTED = "projected"  # estimated by this tool - NOT confirmed

CONFIRMED_STATUSES = (STATUS_PAID, STATUS_ANNOUNCED)


@dataclass
class Distribution:
    """A single dividend or capital-gain distribution for one symbol."""

    symbol: str
    ex_date: date
    amount: float
    status: str
    kind: str = "income"                  # income | capital_gain | distribution
    pay_date: Optional[date] = None
    record_date: Optional[date] = None
    declared_date: Optional[date] = None
    source: str = ""
    confidence: Optional[float] = None    # 0..1, only meaningful for projections
    basis: str = ""                       # how a projection was derived
    note: str = ""

    @property
    def is_confirmed(self) -> bool:
        return self.status in CONFIRMED_STATUSES

    def to_json(self) -> dict:
        out = asdict(self)
        for key in ("ex_date", "pay_date", "record_date", "declared_date"):
            value = out.get(key)
            out[key] = value.isoformat() if isinstance(value, date) else None
        if out.get("confidence") is not None:
            out["confidence"] = round(out["confidence"], 3)
        out["amount"] = round(out["amount"], 6)
        return {k: v for k, v in out.items() if v not in ("", None) or k in ("amount", "pay_date")}


@dataclass
class SymbolConfig:
    symbol: str
    name: str = ""
    kind: str = "equity"                  # equity | fund
    expected_cadence: str = ""
    notes: str = ""


@dataclass
class SymbolResult:
    """Everything the site needs to render one symbol."""

    config: SymbolConfig
    distributions: list = field(default_factory=list)
    price: Optional[float] = None
    currency: str = "USD"
    cadence: str = "unknown"
    cadence_days: Optional[int] = None
    trailing_12m: Optional[float] = None
    yield_pct: Optional[float] = None
    growth_rate: Optional[float] = None
    warnings: list = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "symbol": self.config.symbol,
            "name": self.config.name,
            "kind": self.config.kind,
            "notes": self.config.notes,
            "price": round(self.price, 4) if self.price is not None else None,
            "currency": self.currency,
            "cadence": self.cadence,
            "cadenceDays": self.cadence_days,
            "trailing12m": round(self.trailing_12m, 6) if self.trailing_12m is not None else None,
            "yieldPct": round(self.yield_pct, 4) if self.yield_pct is not None else None,
            "growthRate": round(self.growth_rate, 5) if self.growth_rate is not None else None,
            "warnings": self.warnings,
            "distributions": [d.to_json() for d in self.distributions],
        }
