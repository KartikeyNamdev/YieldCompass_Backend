from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, StringConstraints

from . import apy as apy_math
from .llm import (AnthropicClient, Doc, ExtractionError, LLMClient, extract_facts, explanation_is_safe,
                  live_explanation, template_explanation)
from .pipeline import PoolAnalyzeRequest, analyze_pool
from .risk import Citation, Extraction, RiskInputs, RiskResult, score_risk

ProtocolId = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")]


def demo_mode() -> bool:
    return os.environ.get("DEMO_MODE", "true").lower() != "false"


def seed_dir() -> Path:
    configured = os.environ.get("SEED_DIR")
    if configured:
        return Path(configured)
    # repo checkout layout: services/analytics/app/main.py -> <repo>/data/seed
    return Path(__file__).resolve().parents[3] / "data" / "seed"


def _load_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def get_llm() -> LLMClient | None:
    """Live model client. Never used while DEMO_MODE is on."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    return AnthropicClient(key) if key and not demo_mode() else None


app = FastAPI(title="YieldCompass analytics", version="0.1.0")


def now() -> datetime:
    return datetime.now(timezone.utc)


@app.get("/health")
def health() -> dict[str, object]:
    return {"status": "ok", "service": "analytics", "demo_mode": demo_mode()}


# ---------------------------------------------------------------- APY


class RatePointIn(BaseModel):
    ts: datetime
    rate: float = Field(gt=0)


class RealizedRequest(BaseModel):
    series: list[RatePointIn] = Field(min_length=2, max_length=5000)
    window_days: int = Field(gt=0, le=365)


@app.post("/apy/realized")
def apy_realized(req: RealizedRequest) -> dict[str, object]:
    try:
        r = apy_math.realized_apy([apy_math.RatePoint(p.ts, p.rate) for p in req.series], req.window_days)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"window_days": req.window_days, "days_used": r.days, "period_return": r.period_return, "apy": r.apy,
            "start_ts": r.start_ts, "end_ts": r.end_ts, "updated_at": now()}


class PricePointIn(BaseModel):
    ts: datetime
    price: float = Field(gt=0)


class EmissionsRequest(BaseModel):
    base_apy: float = Field(ge=0)
    reward_apy: float = Field(ge=0)
    reward_price_series: list[PricePointIn] = Field(default_factory=list, max_length=5000)


@app.post("/apy/emissions")
def apy_emissions(req: EmissionsRequest) -> dict[str, object]:
    r = apy_math.emissions(req.base_apy, req.reward_apy, [apy_math.PricePoint(p.ts, p.price) for p in req.reward_price_series])
    return {"emissions_share": r.emissions_share, "haircut": r.haircut, "haircut_basis": r.haircut_basis,
            "price_change_30d": r.price_change_30d, "sustainable_apy": r.sustainable_apy, "updated_at": now()}


# ---------------------------------------------------------------- risk


class ScoreResponse(RiskResult):
    computed_at: datetime


@app.post("/risk/score", response_model=ScoreResponse)
def risk_score(inputs: RiskInputs) -> ScoreResponse:
    return ScoreResponse(**score_risk(inputs).model_dump(), computed_at=now())


class AnalyzeRequest(BaseModel):
    protocol_id: ProtocolId
    docs: list[Doc] = Field(default_factory=list, max_length=20)


@app.post("/risk/analyze-docs")
def risk_analyze_docs(req: AnalyzeRequest) -> dict[str, object]:
    cached = _load_json(seed_dir() / "analysis" / f"{req.protocol_id}.json")
    if demo_mode():
        # Never call the model live during the demo.
        if not isinstance(cached, dict):
            raise HTTPException(404, "no cached analysis for this protocol (DEMO_MODE is on)")
        return {"extraction": Extraction.model_validate(cached["extraction"]), "dropped": cached.get("dropped", []),
                "served_from": "cache", "generated_by": cached.get("generated_by"), "updated_at": now()}
    client = get_llm()
    if client is None or not req.docs:
        raise HTTPException(503, "live analysis needs ANTHROPIC_API_KEY and at least one document")
    try:
        extraction, dropped = extract_facts(req.protocol_id, req.docs, client)
    except ExtractionError as exc:
        raise HTTPException(502, str(exc)) from exc
    return {"extraction": extraction, "dropped": dropped, "served_from": "live", "updated_at": now()}


class ExplainRequest(BaseModel):
    protocol_id: ProtocolId
    name: str | None = None
    result: RiskResult


@app.post("/risk/explain")
def risk_explain(req: ExplainRequest) -> dict[str, object]:
    sources: list[Citation] = req.result.sources
    cached = _load_json(seed_dir() / "explanations.json")
    entry = cached.get(req.protocol_id) if isinstance(cached, dict) else None
    if isinstance(entry, dict) and entry.get("score") == req.result.score and explanation_is_safe(str(entry.get("text", ""))):
        text, served = str(entry["text"]), "cache"
    elif not demo_mode() and (client := get_llm()) is not None:
        text, served = live_explanation(req.result, client, req.name), "live"
    else:
        text, served = template_explanation(req.result, req.name), "template"
    return {"protocol_id": req.protocol_id, "score": req.result.score, "explanation": text,
            "sources": sources, "served_from": served, "updated_at": now()}


# ---------------------------------------------------------------- pools


@app.post("/pools/analyze")
def pools_analyze(req: PoolAnalyzeRequest) -> dict[str, object]:
    """Snapshots in, everything the explorer needs out (realized APY, emissions, risk)."""
    out = analyze_pool(req)
    out["updated_at"] = now()
    return out
