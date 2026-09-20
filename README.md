# YieldCompass (backend)

Risk-aware, fixed-term yield vault for Solana stablecoins, plus an intelligence layer that shows what DeFi pools
**actually earned** (realized APY) and how risky they are.

> **Devnet prototype. Unaudited. Test tokens only.** Target rate, not guaranteed. Informational only, not financial advice.
> `mock_yield` is a **test double** that simulates profit and loss. It is not a real strategy.

This repository contains the backend only (no `apps/web`). See `CLAUDE.md` for the full spec.

## What is built

| Part | Path | State |
| --- | --- | --- |
| Anchor vault (series, senior/junior tranches, risk gate, waterfall, claims) | `programs/yc_vault` | done, 13 on-chain integration tests |
| Mock yield source (`simulate_yield` / `simulate_loss`) | `programs/mock_yield` | done (test double) |
| Waterfall math, Rust + TypeScript mirror | `programs/yc_vault/src/math.rs`, `packages/waterfall` | done, table + property tests |
| Analytics (realized APY, emissions, risk score, Fable 5.1 extraction) | `services/analytics` | done, 55 tests |
| Ingestion (BullMQ: ingest, compute-apy, analyze-docs) | `services/ingestion` | done, demo seed + live DefiLlama |
| Indexer (chain to Postgres) | `services/indexer` | done, e2e tested on a local validator |
| Keeper (risk publisher + settle bot) | `services/keeper` | done, e2e tested on a local validator |
| REST API (NestJS, `/v1`) | `apps/api` | done, 45 tests |
| Postgres migrations, Docker Compose | `migrations/`, `infra/` | done |
| Demo CLI for the on-chain cycle | `services/keeper/src/demo.ts` | done |

Not built: `apps/web`, Kubernetes manifests, alerts, chat box, a real yield-source integration.

## Quick start

```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up --build      # everything, seeded from data/seed (DEMO_MODE=true)
curl localhost:4000/health                                 # api; also :4001 ingestion, :4002 indexer, :4003 keeper, :8000 analytics
curl "localhost:4000/v1/pools?profile=conservative"
```

The keeper stays healthy without keys and simply leaves on-chain duties off. To enable them:

```bash
scripts/gen-devnet-keys.sh                 # writes secrets/{keeper,risk,admin}.json (devnet only, gitignored)
solana airdrop 2 <pubkey> --url devnet     # fund each, then set YC_VAULT_PROGRAM_ID / MOCK_YIELD_PROGRAM_ID
```

No Docker? `scripts/dev-local.sh up` starts Postgres (5433), Redis (6380) and analytics (8000) from Homebrew binaries.

## Tests

```bash
cargo test -p yc_vault --lib                       # waterfall unit + property tests (Rust)
npm run build:libs && npm run test:libs            # waterfall (TS) + shared
npm run test:programs                              # anchor build + bankrun: lifecycle, loss, cancel/refund, pause, unauthorized, gate
npm run test:analytics                             # pytest
npm -w @yc/api test                                # API (fake repositories)
scripts/dev-local.sh up
TEST_DATABASE_URL=postgres://yc@localhost:5433/yc TEST_ANALYTICS_URL=http://localhost:8000 npm -w @yc/ingestion test
scripts/e2e-keeper.sh                              # keeper + indexer against a real local validator (fresh chain per suite)
```

## API (`/v1`)

`GET /pools?profile=&sort=` · `GET /pools/:id` · `GET /pools/:id/history?window=7d|30d` · `GET /risk/:id` · `POST /risk/:id/explain` ·
`GET /series` · `GET /series/:id` · `GET /series/:id/quote?amount=&tranche=` · `POST /series/:id/simulate {yieldBps}` ·
`POST /wallet/positions {address}` · `GET /health`. Every response carries `updated_at`; vault responses carry the disclaimer.
Rates are decimal fractions (0.05 = 5%). Token amounts are decimal strings.

**Profiles** change eligibility and weighting. Ranked value = `sustainable_realized_apy x (risk_score/100)^k`:
conservative (score >= 65, no "mostly bonus tokens", k=2), balanced (score >= 40, k=1), aggressive (all, k=0.5).
Excluded pools are listed with a reason rather than silently dropped.

## How the numbers are made

* **Realized APY** = `(rate_end / rate_start)^(365/days) - 1` over the actual elapsed days, from the share rate when available.
  DefiLlama has no share rate, so live pools fall back to mean base APY and are labelled `base_apy_average` (lower confidence).
* **Emissions share** = `reward / (base + reward)`; flagged "mostly bonus tokens" above 50%.
  `sustainable_realized_apy` = realized + reward x haircut, haircut = clamp(1 + 30d reward-token price change, 0, 1); 0.5 if no price data.
* **Risk score** (0-100, higher is safer) is computed by fixed rules (`services/analytics/app/risk.py`), weights 25/20/20/10/10/10/5.
  The model never produces the number. Fable 5.1 only extracts cited facts from documents. Every extracted claim must quote the
  source text verbatim (under 25 words) or it is dropped; invalid JSON is retried at most twice. Documents are treated as untrusted data.
* **Waterfall**: `senior_owed = P + P x rate x term / year`; `senior = min(assets, owed)`; `junior = assets - senior`.
  Capacity rule: junior >= `min_junior_bps` of total on every senior deposit. Rust and TS implementations are tested against the same table.

## Risk gate and keeper

`activate` refuses unless the series' on-chain `RiskEntry` is fresh (`now < expires_at`) **and** `score >= min_risk_score`.
The keeper publishes entries with a 24h expiry when a score changes, **and re-publishes hourly** any entry expiring within 6h
(otherwise the gate would start refusing healthy strategies). `settle` is permissionless; the keeper calls it every 30s.
Every submission goes through an idempotency key in `tx_log`, so retries and concurrent workers cannot double-submit.
The admin key has no path to move vault funds. `refund` and `claim_*` do not read `Config`, so pausing cannot block them.

## Demo on-chain cycle (local validator or devnet)

```bash
cd services/keeper && npm run build
export SOLANA_RPC_URL=... ADMIN_KEYPAIR_PATH=... RISK_KEYPAIR_PATH=... KEEPER_KEYPAIR_PATH=...
node dist/demo.js bootstrap                                  # test mint, config, risk entries demo-good (85) and demo-low (40)
node dist/demo.js mint <wallet> 1000
node dist/demo.js create-series --id 1 --protocol demo-low --deadline 90 --term 180
node dist/demo.js deposit 1 junior 20 && node dist/demo.js deposit 1 senior 100
node dist/demo.js activate 1                                 # REFUSED: RiskScoreTooLow
node dist/demo.js create-series --id 2 --protocol demo-good ...   # activate, simulate yield 600, keeper settles, claim
```

## Data and honesty notes

* `data/seed/` is **synthetic**: fictional protocols, generated numbers, placeholder `example.org` sources. Regenerate with
  `python3 scripts/gen_seed.py`. Nothing there describes a real protocol.
* The cached explanations are deterministic template output until you run `services/analytics/scripts/precompute.py --live`
  with `ANTHROPIC_API_KEY` and `DEMO_MODE=false`, which calls Fable 5.1 and rewrites `data/seed/analysis` and `explanations.json`.
  The demo itself never calls the model live.
* Live mode (`DEMO_MODE=false`) reads six Solana pools from DefiLlama (`data/live_protocols.json`, pool ids checked against the
  live API on 2026-09-20). Launch dates and doc URLs are empty, so live risk scores are conservative until you add them.
* `wallet/positions` shows YieldCompass vault positions only, not positions in external protocols.
* Performance fee collection is not implemented; `init_series` requires `performance_fee_bps = 0`.
* Programs are not deployed to devnet yet. Program keypairs live in `target/deploy` (git-ignored); to use your own ids run `anchor keys sync`, then `scripts/sync-idl.sh`. Pooled products with stated returns are regulated in many jurisdictions; this is a prototype.
