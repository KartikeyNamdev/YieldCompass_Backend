#!/usr/bin/env python3
"""Precompute cached analyses so the demo never calls the model live.

  python scripts/precompute.py            # offline: deterministic template explanations from the seed
  python scripts/precompute.py --live     # calls Fable 5.1 (needs ANTHROPIC_API_KEY, DEMO_MODE=false):
                                          # re-extracts facts from data/seed/docs and writes explanations
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.llm import AnthropicClient, Doc, extract_facts, live_explanation, template_explanation  # noqa: E402
from app.pipeline import PoolAnalyzeRequest, SnapshotIn, analyze_pool  # noqa: E402
from app.risk import Extraction  # noqa: E402

SEED = Path(__file__).resolve().parents[3] / "data" / "seed"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true")
    live = ap.parse_args().live
    client = None
    if live:
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            sys.exit("--live needs ANTHROPIC_API_KEY")
        client = AnthropicClient(key)

    protocols = json.loads((SEED / "protocols.json").read_text())
    snaps = json.loads((SEED / "snapshots.json").read_text())["snapshots"]
    end = datetime(2026, 1, 1, tzinfo=timezone.utc)  # fixed anchor: scores must not depend on wall-clock time
    explanations: dict[str, dict[str, object]] = {}
    for p in protocols:
        pid = p["id"]
        docs = [Doc(**d) for d in json.loads((SEED / "docs" / f"{pid}.json").read_text())]
        analysis_path = SEED / "analysis" / f"{pid}.json"
        if client:
            extraction, dropped = extract_facts(pid, docs, client)
            analysis_path.write_text(json.dumps(
                {"generated_by": f"live:{os.environ.get('ANTHROPIC_MODEL', 'claude-fable-5-1')}", "dropped": dropped,
                 "extraction": extraction.model_dump()}, indent=2) + "\n")
        else:
            extraction = Extraction.model_validate(json.loads(analysis_path.read_text())["extraction"])
        rows = [SnapshotIn(ts=end + timedelta(days=r["day_offset"]), **{k: v for k, v in r.items() if k != "day_offset"})
                for r in snaps[pid]]
        out = analyze_pool(PoolAnalyzeRequest(protocol_id=pid, launched=(end - timedelta(days=p["age_days"])).date(), snapshots=rows, extraction=extraction))
        risk = out["risk"]
        text = live_explanation(risk, client, p["name"]) if client else template_explanation(risk, p["name"])
        explanations[pid] = {"score": risk.score, "text": text,
                             "generated_by": "live" if client else "template", "sources": [c.model_dump() for c in risk.sources]}
        print(f"{pid:18s} score={risk.score:3d}  sources={len(risk.sources)}")
    (SEED / "explanations.json").write_text(json.dumps(explanations, indent=2) + "\n")


if __name__ == "__main__":
    main()
