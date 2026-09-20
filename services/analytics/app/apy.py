"""Realized APY and emissions math. All rates are decimal fractions (0.05 == 5%)."""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Sequence

MIN_WINDOW_DAYS = 0.5  # shorter spans make annualisation meaningless


@dataclass(frozen=True)
class RatePoint:
    ts: datetime
    rate: float


@dataclass(frozen=True)
class RealizedResult:
    period_return: float
    apy: float
    days: float
    start_ts: datetime
    end_ts: datetime


def realized_apy(points: Sequence[RatePoint], window_days: int) -> RealizedResult:
    """period_return = rate_end / rate_start - 1; apy = (1 + period_return) ** (365 / days) - 1.

    The window ends at the latest point. `days` is the ACTUAL elapsed time between the first
    point inside the window and the last point, not the nominal window length.
    """
    if window_days <= 0:
        raise ValueError("window_days must be positive")
    pts = sorted(points, key=lambda p: p.ts)
    if len(pts) < 2:
        raise ValueError("need at least two rate points")
    end = pts[-1]
    cutoff = end.ts - timedelta(days=window_days)
    inside = [p for p in pts if p.ts >= cutoff]
    if len(inside) < 2:
        raise ValueError("need at least two rate points inside the window")
    start = inside[0]
    if start.rate <= 0 or end.rate <= 0:
        raise ValueError("share rates must be positive")
    days = (end.ts - start.ts).total_seconds() / 86_400
    if days < MIN_WINDOW_DAYS:
        raise ValueError("window too short to annualise")
    period_return = end.rate / start.rate - 1
    try:
        apy = (1 + period_return) ** (365 / days) - 1
    except OverflowError as exc:  # absurdly large return over a short span
        raise ValueError("annualised return overflows") from exc
    if not math.isfinite(apy):
        raise ValueError("annualised return is not finite")
    return RealizedResult(period_return, apy, days, start.ts, end.ts)


@dataclass(frozen=True)
class PricePoint:
    ts: datetime
    price: float


@dataclass(frozen=True)
class EmissionsResult:
    emissions_share: float
    haircut: float
    sustainable_apy: float
    price_change_30d: float | None
    haircut_basis: str


NO_PRICE_HAIRCUT = 0.5  # conservative default when the reward token price history is unavailable


def price_change(points: Sequence[PricePoint], window_days: int = 30) -> float | None:
    pts = sorted(points, key=lambda p: p.ts)
    if len(pts) < 2:
        return None
    end = pts[-1]
    inside = [p for p in pts if p.ts >= end.ts - timedelta(days=window_days)]
    if len(inside) < 2 or inside[0].price <= 0:
        return None
    return end.price / inside[0].price - 1


def emissions(base_apy: float, reward_apy: float, prices: Sequence[PricePoint] = ()) -> EmissionsResult:
    """emissions_share = reward / (base + reward)
    sustainable_apy = base + reward * haircut, haircut = clamp(1 + 30d price change, 0, 1).
    """
    if base_apy < 0 or reward_apy < 0:
        raise ValueError("apys must be non-negative")
    total = base_apy + reward_apy
    share = reward_apy / total if total > 0 else 0.0
    change = price_change(prices)
    if change is None:
        haircut, basis = NO_PRICE_HAIRCUT, "no_price_data"
    else:
        haircut, basis = min(1.0, max(0.0, 1 + change)), "price_change_30d"
    return EmissionsResult(share, haircut, base_apy + reward_apy * haircut, change, basis)


def risk_adjusted_yield(sustainable_realized_apy: float, risk_score: int) -> float:
    return sustainable_realized_apy * (risk_score / 100)
