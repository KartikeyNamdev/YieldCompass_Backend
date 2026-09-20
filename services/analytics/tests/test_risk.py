import pytest

from app.risk import WEIGHTS, Audit, Extraction, Incident, Oracle, RiskInputs, UpgradeAuthority, score_risk

SRC = "https://example.org/x"


def full_extraction(**over) -> Extraction:
    base = dict(
        protocol_id="p",
        audits=[Audit(firm="A", quote="q1", source=SRC), Audit(firm="B", quote="q2", source=SRC)],
        upgrade_authority=UpgradeAuthority(type="multisig", quote="uq", source=SRC),
        oracle=Oracle(provider="Pyth", quote="oq", source=SRC),
        past_incidents=[],
    )
    base.update(over)
    return Extraction(**base)


def inputs(**over) -> RiskInputs:
    base = dict(protocol_id="p", tvl_usd=1e9, tvl_drawdown_30d=0.0, emissions_share=0.0, liquid_ratio=0.3,
                age_days=730, extraction=full_extraction())
    base.update(over)
    return RiskInputs(**base)


def test_weights_sum_to_100():
    assert sum(WEIGHTS.values()) == 100


def test_perfect_inputs_score_close_to_max():
    r = score_risk(inputs(extraction=full_extraction(audits=[Audit(firm=str(i), quote="q", source=SRC) for i in range(3)],
                                                     upgrade_authority=UpgradeAuthority(type="immutable", quote="q", source=SRC))))
    assert r.score == 100


def test_score_is_reproducible():
    a, b = score_risk(inputs()), score_risk(inputs())
    assert a == b
    # audits 2 -> 0.75*25, tvl 1.0*20, yield 1.0*20, maturity 1.0*10, oracle 1.0*10, liquidity 1.0*10, multisig 0.7*5
    assert a.score == round(18.75 + 20 + 20 + 10 + 10 + 10 + 3.5)  # 92.25 -> 92


def test_breakdown_points_sum_to_score():
    r = score_risk(inputs(tvl_usd=5e7, emissions_share=0.4, age_days=200))
    assert abs(sum(f.points for f in r.breakdown) - r.score) <= 0.5
    assert [f.factor for f in r.breakdown] == list(WEIGHTS)


def test_missing_extraction_is_conservative():
    with_facts = score_risk(inputs())
    without = score_risk(inputs(extraction=None))
    assert without.score < with_facts.score
    audit = next(f for f in without.breakdown if f.factor == "audit_quality")
    assert audit.value == 0.0 and "No audit" in audit.reason


def test_unresolved_critical_findings_penalise_audit_factor():
    clean = score_risk(inputs())
    bad = score_risk(inputs(extraction=full_extraction(
        audits=[Audit(firm="A", quote="q", source=SRC, critical_findings_unresolved=2)])))
    f = next(x for x in bad.breakdown if x.factor == "audit_quality")
    assert f.value == pytest.approx(0.5 * 0.4)
    assert bad.score < clean.score


def test_emissions_heavy_pool_scores_lower():
    assert score_risk(inputs(emissions_share=0.9)).score < score_risk(inputs(emissions_share=0.1)).score


def test_incidents_reduce_maturity():
    inc = [Incident(summary="s", source=SRC)]
    m = lambda r: next(f for f in r.breakdown if f.factor == "maturity_incidents").value  # noqa: E731
    assert m(score_risk(inputs(extraction=full_extraction(past_incidents=inc)))) == pytest.approx(0.7)


def test_tvl_drawdown_hurts():
    assert score_risk(inputs(tvl_drawdown_30d=0.5)).score < score_risk(inputs(tvl_drawdown_30d=0.0)).score


def test_sources_are_deduplicated_and_cited():
    r = score_risk(inputs())
    assert r.sources and all(c.url == SRC for c in r.sources)
    assert len({(c.url, c.quote) for c in r.sources}) == len(r.sources)


def test_input_bounds_validated():
    with pytest.raises(ValueError):
        inputs(emissions_share=1.5)
