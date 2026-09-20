"""Seed integrity + HTTP layer. Runs fully offline (DEMO_MODE)."""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

SEED = Path(__file__).resolve().parents[3] / "data" / "seed"
os.environ["DEMO_MODE"] = "true"
os.environ["SEED_DIR"] = str(SEED)

from app.llm import Doc, validate_extraction  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
PROTOCOLS = json.loads((SEED / "protocols.json").read_text())
SNAPS = json.loads((SEED / "snapshots.json").read_text())["snapshots"]
END = datetime(2026, 1, 1, tzinfo=timezone.utc)


def analyze_body(p: dict, with_extraction: bool = True) -> dict:
    body = {
        "protocol_id": p["id"],
        "launched": (END - timedelta(days=p["age_days"])).date().isoformat(),
        "snapshots": [{**{k: v for k, v in r.items() if k != "day_offset"}, "ts": (END + timedelta(days=r["day_offset"])).isoformat()}
                      for r in SNAPS[p["id"]]],
    }
    if with_extraction:
        body["extraction"] = json.loads((SEED / "analysis" / f"{p['id']}.json").read_text())["extraction"]
    return body


def test_health():
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["service"] == "analytics"


def test_seed_has_at_least_five_protocols_flagged_synthetic():
    assert len(PROTOCOLS) >= 5 and all(p["synthetic"] for p in PROTOCOLS)


@pytest.mark.parametrize("p", PROTOCOLS, ids=lambda p: p["id"])
def test_cached_analysis_is_supported_by_its_documents(p):
    docs = [Doc(**d) for d in json.loads((SEED / "docs" / f"{p['id']}.json").read_text())]
    cached = json.loads((SEED / "analysis" / f"{p['id']}.json").read_text())["extraction"]
    _, dropped = validate_extraction(cached, p["id"], docs)
    assert dropped == [], dropped


@pytest.mark.parametrize("p", PROTOCOLS, ids=lambda p: p["id"])
def test_every_seed_protocol_has_a_cited_explanation_matching_its_score(p):
    res = client.post("/pools/analyze", json=analyze_body(p)).json()
    exp = client.post("/risk/explain", json={"protocol_id": p["id"], "name": p["name"], "result": res["risk"]}).json()
    assert exp["served_from"] == "cache", "cached explanation is stale: run scripts/precompute.py"
    assert exp["score"] == res["risk"]["score"] and exp["explanation"] and exp["sources"]
    assert all(s["url"] for s in exp["sources"])


def test_realized_apy_matches_hand_calculation_for_a_seed_protocol():
    p = next(x for x in PROTOCOLS if x["id"] == "aurora-lend")
    res = client.post("/pools/analyze", json=analyze_body(p)).json()
    rows = SNAPS["aurora-lend"]
    start, end = rows[-31]["share_rate"], rows[-1]["share_rate"]  # 30 days apart
    hand = (end / start) ** (365 / 30) - 1
    assert res["realized"]["30d"]["basis"] == "share_rate"
    assert res["realized"]["30d"]["apy"] == pytest.approx(hand, rel=1e-9)
    assert res["realized"]["30d"]["apy"] == pytest.approx(0.059, abs=1e-6)  # the rate the seed was generated with


def test_gap_and_bonus_token_flag():
    by = {p["id"]: client.post("/pools/analyze", json=analyze_body(p)).json() for p in PROTOCOLS}
    farm = by["delta-farm"]
    assert farm["mostly_bonus_tokens"] is True and farm["emissions"]["share"] > 0.9
    assert farm["apy_headline"] > 10 * farm["realized"]["30d"]["apy"]
    assert by["cinder-stake"]["mostly_bonus_tokens"] is False
    assert farm["risk"]["score"] < by["aurora-lend"]["risk"]["score"]


def test_risk_adjusted_ranking_differs_from_headline_ranking():
    res = [client.post("/pools/analyze", json=analyze_body(p)).json() for p in PROTOCOLS]
    top_headline = max(res, key=lambda r: r["apy_headline"])["protocol_id"]
    top_adjusted = max(res, key=lambda r: r["risk_adjusted_yield"])["protocol_id"]
    assert top_headline == "delta-farm" and top_adjusted != top_headline


def test_analyze_without_share_rates_falls_back_to_base_apy_average():
    p = PROTOCOLS[0]
    body = analyze_body(p)
    for s in body["snapshots"]:
        s["share_rate"] = None
    r = client.post("/pools/analyze", json=body).json()
    assert r["realized"]["30d"]["basis"] == "base_apy_average"


def test_apy_endpoints_validate_input():
    assert client.post("/apy/realized", json={"series": [], "window_days": 7}).status_code == 422
    body = {"series": [{"ts": "2026-01-01T00:00:00Z", "rate": 1.0}, {"ts": "2026-01-01T01:00:00Z", "rate": 1.1}], "window_days": 7}
    assert client.post("/apy/realized", json=body).status_code == 422  # span too short to annualise
    ok = {"series": [{"ts": "2026-01-01T00:00:00Z", "rate": 1.0}, {"ts": "2026-01-31T00:00:00Z", "rate": 1.01}], "window_days": 30}
    assert client.post("/apy/realized", json=ok).json()["apy"] == pytest.approx(0.128695, abs=1e-6)
    em = client.post("/apy/emissions", json={"base_apy": 0.03, "reward_apy": 0.03}).json()
    assert em["emissions_share"] == pytest.approx(0.5) and em["haircut_basis"] == "no_price_data"
    assert client.post("/apy/emissions", json={"base_apy": -1, "reward_apy": 0}).status_code == 422


def test_demo_mode_never_goes_live_and_serves_cache_only():
    r = client.post("/risk/analyze-docs", json={"protocol_id": "aurora-lend", "docs": []}).json()
    assert r["served_from"] == "cache"
    assert client.post("/risk/analyze-docs", json={"protocol_id": "unknown-protocol", "docs": []}).status_code == 404


def test_protocol_id_cannot_traverse_paths():
    assert client.post("/risk/analyze-docs", json={"protocol_id": "../../etc/passwd", "docs": []}).status_code == 422


def test_stale_cache_falls_back_to_template():
    p = PROTOCOLS[0]
    res = client.post("/pools/analyze", json=analyze_body(p)).json()["risk"]
    res["score"] = 1  # cached explanation was written for a different score
    exp = client.post("/risk/explain", json={"protocol_id": p["id"], "result": res}).json()
    assert exp["served_from"] == "template"
