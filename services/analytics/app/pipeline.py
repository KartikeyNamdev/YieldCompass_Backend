"""One place that turns raw pool snapshots into everything the explorer shows."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from statistics import fmean

from pydantic import BaseModel, Field

from . import apy as apy_math
from .risk import Extraction, RiskInputs, RiskResult, score_risk


class SnapshotIn(BaseModel):
    ts: datetime
    tvl_usd: float = Field(ge=0)
    apy_headline: float | None = None
    apy_base: float | None = None
    apy_reward: float | None = None
    share_rate: float | None = Field(default=None, gt=0)
    reward_price: float | None = Field(default=None, gt=0)
    liquidity_ratio: float | None = Field(default=None, ge=0, le=1)


class PoolAnalyzeRequest(BaseModel):
    protocol_id: str
    launched: date | None = None
    snapshots: list[SnapshotIn] = Field(min_length=2, max_length=20000)
    extraction: Extraction | None = None


def realized_window(snaps: list[SnapshotIn], window_days: int) -> dict[str, object]:
    """Realized APY over a window. Uses the share-rate when available (what depositors actually earned),
    otherwise falls back to the mean daily base APY, labelled as lower confidence."""
    end = snaps[-1].ts
    inside = [s for s in snaps if s.ts >= end - timedelta(days=window_days)]
    with_rate = [apy_math.RatePoint(s.ts, s.share_rate) for s in inside if s.share_rate]
    if len(with_rate) >= 2:
        try:
            r = apy_math.realized_apy(with_rate, window_days)
            return {"apy": r.apy, "period_return": r.period_return, "days_used": r.days, "basis": "share_rate"}
        except ValueError:
            pass
    bases = [s.apy_base for s in inside if s.apy_base is not None]
    if len(bases) >= 2:
        return {"apy": fmean(bases), "period_return": None, "days_used": None, "basis": "base_apy_average"}
    return {"apy": None, "period_return": None, "days_used": None, "basis": "insufficient_data"}


def tvl_drawdown(snaps: list[SnapshotIn], window_days: int = 30) -> float:
    end = snaps[-1].ts
    peak, worst = 0.0, 0.0
    for s in snaps:
        if s.ts < end - timedelta(days=window_days):
            continue
        peak = max(peak, s.tvl_usd)
        if peak > 0:
            worst = max(worst, (peak - s.tvl_usd) / peak)
    return min(1.0, worst)


def analyze_pool(req: PoolAnalyzeRequest) -> dict[str, object]:
    snaps = sorted(req.snapshots, key=lambda s: s.ts)
    latest = snaps[-1]
    base = latest.apy_base or 0.0
    reward = latest.apy_reward or 0.0
    headline = latest.apy_headline if latest.apy_headline is not None else base + reward

    prices = [apy_math.PricePoint(s.ts, s.reward_price) for s in snaps if s.reward_price]
    em = apy_math.emissions(base, reward, prices)
    r7, r30 = realized_window(snaps, 7), realized_window(snaps, 30)

    age_days = max(0, (latest.ts.date() - req.launched).days) if req.launched else 0
    risk: RiskResult = score_risk(
        RiskInputs(
            protocol_id=req.protocol_id, tvl_usd=latest.tvl_usd, tvl_drawdown_30d=tvl_drawdown(snaps),
            emissions_share=em.emissions_share, liquid_ratio=latest.liquidity_ratio or 0.0,
            age_days=age_days, extraction=req.extraction,
        )
    )
    realized_30 = r30["apy"] if isinstance(r30["apy"], float) else None
    sustainable_realized = None if realized_30 is None else realized_30 + reward * em.haircut
    return {
        "protocol_id": req.protocol_id,
        "as_of": latest.ts,
        "tvl_usd": latest.tvl_usd,
        "apy_headline": headline,
        "apy_base": base,
        "apy_reward": reward,
        "realized": {"7d": r7, "30d": r30},
        "emissions": {"share": em.emissions_share, "haircut": em.haircut, "haircut_basis": em.haircut_basis,
                      "price_change_30d": em.price_change_30d, "sustainable_apy": em.sustainable_apy},
        "sustainable_realized_apy": sustainable_realized,
        "risk_adjusted_yield": None if sustainable_realized is None
        else apy_math.risk_adjusted_yield(sustainable_realized, risk.score),
        "risk": risk,
        "mostly_bonus_tokens": em.emissions_share > 0.5,
    }
