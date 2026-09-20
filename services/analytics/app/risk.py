"""Rule-based, reproducible risk score. The LLM only supplies extracted facts (see llm.py);
every number here is computed by the rules below."""
from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, Field

WEIGHTS: dict[str, int] = {
    "audit_quality": 25,
    "tvl": 20,
    "yield_source": 20,
    "maturity_incidents": 10,
    "oracle_dependency": 10,
    "withdrawal_liquidity": 10,
    "governance": 5,
}
assert sum(WEIGHTS.values()) == 100

FACTOR_LABELS = {
    "audit_quality": "Smart-contract and audit quality",
    "tvl": "TVL size and stability",
    "yield_source": "Yield source quality",
    "maturity_incidents": "Protocol maturity and incident history",
    "oracle_dependency": "Oracle and dependency risk",
    "withdrawal_liquidity": "Withdrawal liquidity",
    "governance": "Governance and admin-key risk",
}

TRUSTED_ORACLES = {"pyth", "switchboard", "chainlink"}
AUTHORITY_VALUE = {"immutable": 1.0, "timelock": 0.9, "multisig": 0.7, "unknown": 0.3, "single_key": 0.1}


class Citation(BaseModel):
    url: str | None = None
    quote: str | None = None


class Audit(BaseModel):
    firm: str | None = None
    date: str | None = None
    critical_findings_unresolved: float | None = None
    quote: str | None = None
    source: str


class UpgradeAuthority(BaseModel):
    type: Literal["multisig", "single_key", "timelock", "immutable", "unknown"] = "unknown"
    quote: str | None = None
    source: str | None = None


class Oracle(BaseModel):
    provider: str | None = None
    quote: str | None = None
    source: str | None = None


class Incident(BaseModel):
    date: str | None = None
    summary: str
    source: str


class Extraction(BaseModel):
    protocol_id: str
    audits: list[Audit] = Field(default_factory=list)
    upgrade_authority: UpgradeAuthority = Field(default_factory=UpgradeAuthority)
    oracle: Oracle = Field(default_factory=Oracle)
    past_incidents: list[Incident] = Field(default_factory=list)
    notes: str | None = None


class RiskInputs(BaseModel):
    protocol_id: str
    tvl_usd: float = Field(ge=0)
    tvl_drawdown_30d: float = Field(ge=0, le=1, description="max peak-to-trough TVL drop over 30d")
    emissions_share: float = Field(ge=0, le=1)
    liquid_ratio: float = Field(ge=0, le=1, description="withdrawable liquidity / TVL")
    age_days: int = Field(ge=0)
    extraction: Extraction | None = None


class FactorScore(BaseModel):
    factor: str
    label: str
    weight: int
    value: float  # 0..1
    points: float  # weight * value
    reason: str
    sources: list[Citation] = Field(default_factory=list)


class RiskResult(BaseModel):
    protocol_id: str
    score: int
    breakdown: list[FactorScore]
    sources: list[Citation]


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def _cite(url: str | None, quote: str | None) -> list[Citation]:
    return [Citation(url=url, quote=quote)] if (url or quote) else []


def _audit(ex: Extraction | None) -> tuple[float, str, list[Citation]]:
    if ex is None or not ex.audits:
        return 0.0, "No audit found in the provided documents.", []
    n = len(ex.audits)
    value = min(1.0, 0.5 + 0.25 * (n - 1))
    reason = f"{n} audit(s) cited."
    unresolved = sum(a.critical_findings_unresolved or 0 for a in ex.audits)
    if unresolved > 0:
        value *= 0.4
        reason += f" {int(unresolved)} unresolved critical finding(s) reduce the factor."
    cites = [c for a in ex.audits for c in _cite(a.source, a.quote)]
    return value, reason, cites


def _tvl(i: RiskInputs) -> tuple[float, str, list[Citation]]:
    # size: $1M -> 0, $1B -> 1 on a log scale
    size = _clamp(math.log10(max(i.tvl_usd, 1.0) / 1e6) / 3) if i.tvl_usd > 0 else 0.0
    stability = 1 - _clamp(i.tvl_drawdown_30d / 0.5)
    value = 0.6 * size + 0.4 * stability
    return value, f"TVL ${i.tvl_usd:,.0f}; 30d max drawdown {i.tvl_drawdown_30d:.0%}.", []


def _yield_source(i: RiskInputs) -> tuple[float, str, list[Citation]]:
    return 1 - i.emissions_share, f"{i.emissions_share:.0%} of headline yield comes from emissions.", []


def _maturity(i: RiskInputs) -> tuple[float, str, list[Citation]]:
    ex = i.extraction
    age = _clamp(i.age_days / 730)
    incidents = ex.past_incidents if ex else []
    value = age * max(0.0, 1 - 0.3 * len(incidents))
    reason = f"Live for {i.age_days} days; {len(incidents)} incident(s) cited."
    return value, reason, [c for x in incidents for c in _cite(x.source, x.summary)]


def _oracle(i: RiskInputs) -> tuple[float, str, list[Citation]]:
    o = i.extraction.oracle if i.extraction else Oracle()
    provider = (o.provider or "").strip().lower()
    if not provider:
        return 0.3, "Oracle provider not found in the provided text.", []
    value = 1.0 if provider in TRUSTED_ORACLES else 0.6
    return value, f"Oracle provider: {o.provider}.", _cite(o.source, o.quote)


def _liquidity(i: RiskInputs) -> tuple[float, str, list[Citation]]:
    return _clamp(i.liquid_ratio / 0.3), f"{i.liquid_ratio:.0%} of TVL is withdrawable now.", []


def _governance(i: RiskInputs) -> tuple[float, str, list[Citation]]:
    ua = i.extraction.upgrade_authority if i.extraction else UpgradeAuthority()
    return AUTHORITY_VALUE[ua.type], f"Upgrade authority: {ua.type}.", _cite(ua.source, ua.quote)


def score_risk(i: RiskInputs) -> RiskResult:
    parts = {
        "audit_quality": _audit(i.extraction),
        "tvl": _tvl(i),
        "yield_source": _yield_source(i),
        "maturity_incidents": _maturity(i),
        "oracle_dependency": _oracle(i),
        "withdrawal_liquidity": _liquidity(i),
        "governance": _governance(i),
    }
    breakdown: list[FactorScore] = []
    total = 0.0
    for key, (value, reason, cites) in parts.items():
        value = _clamp(value)
        points = WEIGHTS[key] * value
        total += points
        breakdown.append(
            FactorScore(factor=key, label=FACTOR_LABELS[key], weight=WEIGHTS[key], value=round(value, 4),
                        points=round(points, 2), reason=reason, sources=cites)
        )
    seen: set[tuple[str | None, str | None]] = set()
    sources: list[Citation] = []
    for f in breakdown:
        for c in f.sources:
            k = (c.url, c.quote)
            if k not in seen:
                seen.add(k)
                sources.append(c)
    return RiskResult(protocol_id=i.protocol_id, score=int(total + 0.5), breakdown=breakdown, sources=sources)
