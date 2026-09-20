#!/usr/bin/env python3
"""Generate the offline demo seed in data/seed/.

EVERYTHING GENERATED HERE IS SYNTHETIC. The protocols are fictional, the numbers are illustrative,
and the "documents" are fixtures written for tests. Nothing here describes a real protocol.
Live data comes from services/ingestion (DefiLlama etc.) when DEMO_MODE=false.
"""
from __future__ import annotations

import json
import random
from datetime import date
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "data" / "seed"
DAYS = 35  # daily points; day_offset 0 is "now" and is re-timed at load
EX = "https://example.org/sample"  # placeholder source host (RFC 2606, never resolves to a real protocol)

# name, category, launched, tvl, tvl_trend(end/start), base, reward, realized_apy, vol, liquid, reward_px_trend
P = [
    dict(id="aurora-lend", name="Aurora Lend (sample)", category="lending", launched="2022-03-01", tvl=420e6, tvl_trend=1.03,
         base=0.062, reward=0.019, realized=0.059, vol=0.0, liquid=0.42, px=0.98,
         audits=[("Sample Audit Co A", "2023-02-10", 0), ("Sample Audit Co B", "2024-06-21", 0)],
         authority=("multisig", "upgrade authority is a 4-of-7 multisig"), oracle="Pyth", incidents=[]),
    dict(id="basalt-markets", name="Basalt Markets (sample)", category="lending", launched="2021-08-15", tvl=310e6, tvl_trend=0.99,
         base=0.054, reward=0.016, realized=0.052, vol=0.0, liquid=0.35, px=1.05,
         audits=[("Sample Audit Co A", "2022-05-02", 0), ("Sample Audit Co C", "2024-01-18", 0)],
         authority=("timelock", "upgrades pass through a 72-hour timelock"), oracle="Switchboard",
         incidents=[("2023-04-12", "A price feed update was delayed for about 40 minutes; no funds were lost.")]),
    dict(id="cinder-stake", name="Cinder Stake (sample)", category="liquid-staking", launched="2021-06-01", tvl=900e6, tvl_trend=1.01,
         base=0.069, reward=0.004, realized=0.067, vol=0.0, liquid=0.12, px=1.0,
         audits=[("Sample Audit Co B", "2021-09-09", 0), ("Sample Audit Co C", "2023-03-30", 0), ("Sample Audit Co A", "2024-11-05", 0)],
         authority=("multisig", "upgrade authority is a 5-of-9 multisig"), oracle=None, incidents=[]),
    dict(id="delta-farm", name="Delta Farm (sample)", category="yield-farm", launched="2024-09-10", tvl=22e6, tvl_trend=0.62,
         base=0.031, reward=0.349, realized=0.030, vol=0.0, liquid=0.08, px=0.55,
         audits=[("Sample Audit Co D", "2024-08-20", 2)],
         authority=("single_key", "the program upgrade authority is a single key held by the team"), oracle="custom TWAP",
         incidents=[("2025-01-14", "A reward emission bug over-distributed tokens for one epoch before a patch.")]),
    dict(id="ember-vault", name="Ember Vault (sample)", category="vault", launched="2023-11-20", tvl=95e6, tvl_trend=1.06,
         base=0.125, reward=0.0, realized=0.091, vol=0.6, liquid=0.20, px=1.0,
         audits=[("Sample Audit Co C", "2023-10-01", 0)],
         authority=("multisig", "upgrade authority is a 3-of-5 multisig"), oracle="Pyth", incidents=[]),
    dict(id="flux-stable-pool", name="Flux Stable Pool (sample)", category="amm-lp", launched="2022-09-05", tvl=60e6, tvl_trend=0.94,
         base=0.040, reward=0.055, realized=0.037, vol=0.0, liquid=0.50, px=0.80,
         audits=[("Sample Audit Co A", "2022-08-01", 0), ("Sample Audit Co D", "2024-04-15", 0)],
         authority=("timelock", "upgrades pass through a 48-hour timelock"), oracle=None, incidents=[]),
]


def snapshots(p: dict, rng: random.Random) -> list[dict]:
    g = (1 + p["realized"]) ** (1 / 365) - 1  # daily growth giving the target realized APY
    rate, rows = 1.0, []
    for i in range(DAYS):
        off = i - (DAYS - 1)
        f = i / (DAYS - 1)
        if i:
            rate *= 1 + g * (1 + p["vol"] * rng.uniform(-1, 1))
        rows.append(dict(
            day_offset=off,
            tvl_usd=round(p["tvl"] * (1 + (p["tvl_trend"] - 1) * f) / p["tvl_trend"], 2),
            apy_headline=round(p["base"] + p["reward"], 6),
            apy_base=p["base"], apy_reward=p["reward"],
            share_rate=round(rate, 12),
            reward_price=round(1.0 + (p["px"] - 1.0) * f, 6) if p["reward"] > 0 else None,
            liquidity_ratio=p["liquid"],
        ))
    return rows


def docs_for(p: dict) -> list[dict]:
    pid, src = p["id"], f"{EX}/{p['id']}"
    audit_lines = [f"Security review by {firm}, dated {date}. Critical findings unresolved: {n}." for firm, date, n in p["audits"]]
    inc = [f"Incident report ({d}): {s}" for d, s in p["incidents"]]
    o = f"Asset prices are read from the {p['oracle']} oracle." if p["oracle"] else "The protocol does not describe its price source."
    return [
        dict(source=f"{src}/audits", text="SAMPLE FIXTURE, NOT A REAL AUDIT.\n" + "\n".join(audit_lines)),
        dict(source=f"{src}/docs", text=f"SAMPLE FIXTURE. {p['name']} documentation.\nThe {p['authority'][1]}.\n{o}"),
        dict(source=f"{src}/incidents", text="SAMPLE FIXTURE.\n" + ("\n".join(inc) if inc else "No incidents have been reported.")),
    ]


def analysis_for(p: dict) -> dict:
    src = f"{EX}/{p['id']}"
    audits = [dict(firm=f, date=d, critical_findings_unresolved=n,
                   quote=f"Security review by {f}, dated {d}. Critical findings unresolved: {n}.", source=f"{src}/audits")
              for f, d, n in p["audits"]]
    return dict(
        generated_by="fixture (hand-authored, validated against docs by tests; re-run precompute --live to replace)",
        dropped=[],
        extraction=dict(
            protocol_id=p["id"], audits=audits,
            upgrade_authority=dict(type=p["authority"][0], quote=f"The {p['authority'][1]}.", source=f"{src}/docs"),
            oracle=(dict(provider=p["oracle"], quote=f"Asset prices are read from the {p['oracle']} oracle.", source=f"{src}/docs")
                    if p["oracle"] else dict(provider=None, quote=None, source=None)),
            past_incidents=[dict(date=d, summary=s, source=f"{src}/incidents") for d, s in p["incidents"]],
            notes=None,
        ),
    )


def main() -> None:
    rng = random.Random(42)
    protocols, snaps = [], {}
    for p in P:
        src = f"{EX}/{p['id']}"
        protocols.append(dict(id=p["id"], name=p["name"], category=p["category"], chain="solana", launched=p["launched"],
                              age_days=(date(2026, 1, 1) - date.fromisoformat(p["launched"])).days,
                              audit_urls=[f"{src}/audits"], doc_urls=[f"{src}/docs", f"{src}/incidents"], synthetic=True))
        snaps[p["id"]] = snapshots(p, rng)
        (OUT / "docs" / f"{p['id']}.json").write_text(json.dumps(docs_for(p), indent=2) + "\n")
        (OUT / "analysis" / f"{p['id']}.json").write_text(json.dumps(analysis_for(p), indent=2) + "\n")
    (OUT / "protocols.json").write_text(json.dumps(protocols, indent=2) + "\n")
    (OUT / "snapshots.json").write_text(json.dumps(dict(synthetic=True, days=DAYS, snapshots=snaps), separators=(",", ":")) + "\n")
    print(f"wrote {len(P)} protocols to {OUT}")


if __name__ == "__main__":
    main()
