# YieldCompass: Build Spec for Claude Code

> Paste this whole file into Claude Code as `CLAUDE.md` (or as the first message) and work phase by phase (Section 11).
> Target: a working, demo-able prototype for the **Fable 5.1 Build Day (Bhopal)**. **Devnet / test tokens only.**

---

## 0. Kickoff prompt (paste this first)

```
You are building "YieldCompass" for a one-day hackathon. Read CLAUDE.md fully before writing code.
Work in the phases listed in Section 11, one phase at a time. After each phase: run its acceptance
checks, fix failures, then stop and summarize what's done and what's next.
Rules: TypeScript strict; Python 3.11 with type hints; Anchor (Rust) with checked math only;
no secrets in git; everything runs with `docker compose up`; devnet only; never write copy that
promises or guarantees returns. Prefer small, tested modules over big clever ones.
Start with Phase 0.
```

---

## 1. What we are building (and what we are NOT)

**One sentence:** YieldCompass is a _risk-aware, fixed-term yield vault for Solana stablecoins_, powered by a search
engine that shows what DeFi pools **actually earned** (realized APY) and how risky they are.

It has three layers:

| Layer                           | What it is                                                                                                                                                   | Built by us?                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| **A. Intelligence**             | Realized APY, emissions filter, 0-100 risk score with cited AI explanations                                                                                  | Yes (core, must ship)              |
| **B. Fixed-Term Tranche Vault** | User deposits a stablecoin for a fixed term and sees a **target** return (e.g. $100 becomes $102 in 1 year). Senior/junior tranches with a first-loss buffer | Yes (Anchor, the Rust "wow")       |
| **C. Risk gate**                | The vault will only deploy funds into a strategy if its onchain risk score is high enough and fresh                                                          | Yes (small, ties A and B together) |

**Lending and staking are yield SOURCES, not things we build.** We do not write a lending protocol or a staking
protocol in one day. Real protocols (Kamino, MarginFi, Jito, Marinade etc., verify each is live) are _read_ by layer A.
For layer B, the demo uses a **mock yield source** program on devnet that can simulate profit and loss.
Real integration is "phase 2" and is stated honestly in the pitch.

**Non-goals:** mainnet, real user funds, fixed-return _guarantees_, a token, governance, cross-chain, leverage, an AMM.

### The honest name for the 2% product

"Target fixed rate backed by a first-loss buffer." Never "guaranteed" or "risk-free".
If underlying assets lose more than the junior buffer, senior depositors lose money too (Section 4.3).

---

## 2. Features

### MVP (must ship)

1. **Yield explorer:** table of 5-8 Solana protocols with Headline APY, **Realized 7d/30d APY**, Emissions share, TVL, Risk score, "last updated".
2. **Advertised vs Realized gap bar** on each row, with a red **"Mostly bonus tokens"** flag when emissions share is above 50%.
3. **Risk profile filter:** Conservative / Balanced / Aggressive, ranking by `realized_apy x risk_score/100`.
4. **Protocol detail page:** APY and TVL history, risk breakdown by factor, Fable 5.1 explanation with source links.
5. **Fixed-term vault (devnet):** open a series, deposit senior or junior, see the **term sheet** ("deposit 100 USDC, target 102 USDC on <date>"), countdown, settle, claim.
6. **Scenario slider:** drag underlying yield from -10% to +10% and watch senior and junior payouts change live (uses the same waterfall math as the program).
7. **Risk gate:** the vault refuses to activate if the strategy's onchain risk entry is stale or below the series minimum.
8. **Wallet paste:** enter an address, see positions with realized vs advertised yield.

### Stretch (only if ahead at 2:30 PM)

- Alerts when realized APY diverges from advertised by more than X points.
- Kubernetes manifests and a `kind` demo.
- Chat box: "Why is this riskier than X?" answered by Fable 5.1 using cached analysis.
- One real integration (read-only deposit link-out to a live protocol).

---

## 3. How we are different from similar products

Be honest with judges. Some of these are strong products. Our claim is a _different angle_, not "we are better at everything".

| Product                                                | What it does                                                                                                                                 | Where we differ                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pendle** (EVM-first)                                 | Splits yield assets into PT (principal, fixed) and YT (yield, variable) and trades them. Powerful but complex, aimed at advanced users       | We offer one simple action ("deposit 100, see the target on a date") with no PT/YT trading and no maturity-market knowledge needed. Risk is scored and visible first                                                                                                                    |
| **Yearn** (EVM-first)                                  | Open-ended auto-optimizing vaults: pools money, hops between strategies, auto-compounds, takes performance/management fees                   | Ours is **fixed-term** with an explicit **loss waterfall**. Strategy choice is **constrained by a public risk score** rather than only chasing the highest return                                                                                                                       |
| **Exponent** (Solana, closest competitor)              | Yield-stripping (PT/YT) markets on Solana. Per public sources it has also launched senior/junior risk-tranching on a reinsurance-yield token | We do **not** claim to beat their markets or liquidity. Our angle is the **intelligence layer**: realized-vs-advertised yield, transparent scoring, cited AI term sheets, and a UX for non-experts. Position as complementary: a risk layer that could sit in front of venues like this |
| **Kamino / MarginFi / Jupiter Lend / Jito / Marinade** | Money markets and staking: where yield actually comes from                                                                                   | They are our **yield sources**. We measure and route, not compete                                                                                                                                                                                                                       |
| **Yield dashboards** (DefiLlama-style)                 | List headline APYs and TVL, read-only                                                                                                        | We show **realized** yield, separate real yield from emissions, score risk with sources, and connect the result to an actionable vault                                                                                                                                                  |

### Our three defensible differentiators

1. **Realized-yield truth:** rankings are based on what pools actually paid, not the marketing number.
2. **Risk-gated by design:** the score is published onchain, and the vault program _enforces_ it before deploying funds.
3. **Explainable:** every score has a factor breakdown and an AI-written explanation with citations, and the score itself is rule-based and reproducible (the AI extracts facts, it does not invent the number).

### Where we are NOT better (say this before a judge does)

- No liquidity, no secondary market, no PT/YT trading.
- Prototype on devnet with a mock yield source. Not audited.
- Exponent is far ahead on Solana fixed-yield markets. Our value is the risk-intelligence layer.

---

## 4. Money model (the part judges will probe)

### 4.1 Where does the fixed return come from?

Not from new depositors (that's a Ponzi shape). From **real yield** earned by deploying the pooled stablecoins into a yield source.
Because real yield varies, the vault splits depositors into two tranches.

| Tranche    | Who                                                  | Gets                                                                   | Risk              |
| ---------- | ---------------------------------------------------- | ---------------------------------------------------------------------- | ----------------- |
| **Senior** | Users wanting a stable target, e.g. 2% over the term | Paid first, up to `principal x (1 + rate x term)`                      | Low, but not zero |
| **Junior** | Yield-seekers (or the platform treasury)             | Whatever is left: all upside above the senior target, all first losses | High              |

### 4.2 Series lifecycle (fixed-term "series", similar to a bond issue)

```
        deposits allowed                 funds deployed              matured
  ┌───────────────────────┐   ┌────────────────────────┐   ┌────────────────────┐
  │  OPEN                 │──►│  ACTIVE                │──►│  SETTLED           │
  │  deposit_senior/junior│   │  activate() -> strategy│   │  settle() waterfall│
  └──────────┬────────────┘   └────────────────────────┘   │  claim_*()         │
             │ deadline passed & conditions not met         └────────────────────┘
             ▼
        CANCELLED  ->  refund() returns principal 1:1
```

Why fixed series (not open-ended like Yearn): no mid-term deposits/withdrawals means **no dilution or share-price edge cases**.
That makes the accounting small enough to test properly in a day.

### 4.3 Waterfall math

```
senior_owed = senior_principal + senior_principal * rate_bps * term_secs / (10_000 * SECS_PER_YEAR)

At settlement, total_assets = underlying tokens recovered from the strategy
senior_payout = min(total_assets, senior_owed)
junior_payout = total_assets - senior_payout        (then optional protocol fee on junior PROFIT only)
```

Worked example: senior $100, junior $10, rate 2%, term 1 year, so senior_owed = $102.

| Underlying result | Total assets | Senior gets | Junior gets |
| ----------------- | ------------ | ----------- | ----------- |
| +6%               | 116.60       | 102.00      | 14.60       |
| +2%               | 112.20       | 102.00      | 10.20       |
| 0%                | 110.00       | 102.00      | 8.00        |
| -5%               | 104.50       | 102.00      | 2.50        |
| -10%              | 99.00        | 99.00       | 0.00        |

**Capacity rule** (enforced on every senior deposit): `junior_principal / (senior_principal + junior_principal) >= min_junior_bps / 10_000`.
With `min_junior_bps = 1000` (10%), senior can be at most 9x junior.

### 4.4 Rust reference implementation (put in `programs/yc_vault/src/math.rs`)

```rust
pub const BPS: u128 = 10_000;
pub const SECS_PER_YEAR: u128 = 31_536_000;

/// Principal + simple interest for the term. None on overflow.
pub fn senior_owed(principal: u64, rate_bps: u16, term_secs: i64) -> Option<u64> {
    if term_secs < 0 { return None; }
    let p = principal as u128;
    let interest = p
        .checked_mul(rate_bps as u128)?
        .checked_mul(term_secs as u128)?
        .checked_div(BPS.checked_mul(SECS_PER_YEAR)?)?;
    u64::try_from(p.checked_add(interest)?).ok()
}

/// (senior_payout, junior_payout). Always sums to total_assets.
pub fn waterfall(total_assets: u64, senior_owed: u64) -> (u64, u64) {
    let senior = total_assets.min(senior_owed);
    (senior, total_assets - senior)
}

/// Pro-rata share of a tranche payout. Rounds DOWN (dust stays in vault).
pub fn claim_amount(payout_total: u64, user_shares: u64, total_shares: u64) -> Option<u64> {
    if total_shares == 0 { return None; }
    let v = (payout_total as u128)
        .checked_mul(user_shares as u128)?
        .checked_div(total_shares as u128)?;
    u64::try_from(v).ok()
}

/// True if the junior buffer is large enough.
pub fn junior_ratio_ok(senior: u64, junior: u64, min_junior_bps: u16) -> bool {
    let total = (senior as u128) + (junior as u128);
    if total == 0 { return true; }
    (junior as u128) * BPS >= total * (min_junior_bps as u128)
}
```

### 4.5 Fees (keep it simple)

- Optional `performance_fee_bps` charged only on **junior profit** (payout above junior principal). Default **0** in the demo.
- No management fee. No fee on senior. Fees never touch principal.

### 4.6 What to say about "interest" and "time"

- The user picks a **term** (demo: 3 minutes so the whole cycle happens live; product framing: 90 days / 1 year).
- The UI shows a **target**, plus scenarios. It never says the user will receive that amount.
- Required disclaimer on every vault screen: _"Target rate, not guaranteed. Devnet prototype. Not financial advice."_

---

## 5. Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ apps/web  (Next.js + React + TS, wallet adapter, charts, term sheet)   │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ REST/JSON
┌───────────────────────────────▼────────────────────────────────────────┐
│ apps/api  (NestJS gateway)  validation, caching, rate limits, DTOs     │
└───┬───────────────┬──────────────────────────┬─────────────────────────┘
    │               │                          │
┌───▼────┐   ┌──────▼───────────┐     ┌────────▼──────────────────┐
│ Redis  │   │ services/        │     │ Postgres                  │
│ cache  │   │ analytics (Py)   │     │ snapshots, scores, series │
│ BullMQ │   │ FastAPI: APY,    │     └────────▲──────────────────┘
└───▲────┘   │ risk, Fable 5.1  │              │
    │        └──────────────────┘              │
┌───┴─────────────────┐  ┌────────────────────┴─┐  ┌────────────────────┐
│ services/ingestion  │  │ services/indexer     │  │ services/keeper    │
│ scheduled pulls     │  │ reads Solana events  │  │ settle() bot +     │
│ DefiLlama, protocol │  │ -> Postgres          │  │ risk publisher     │
│ APIs, prices        │  └──────────┬───────────┘  └─────────┬──────────┘
└─────────────────────┘             │                        │ signs txs
                                    ▼                        ▼
                     ┌───────────────────────────────────────────────┐
                     │ Solana devnet                                 │
                     │  programs/yc_vault   (series, tranches, gate) │
                     │  programs/mock_yield (simulated strategy)     │
                     └───────────────────────────────────────────────┘
```

### Microservices

| Service      | Language         | Responsibility                                                                                               | Talks to                       |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `web`        | Next.js/TS       | UI, wallet connect, builds transactions client-side, shows term sheet + scenarios                            | api, Solana RPC                |
| `api`        | NestJS/TS        | Public REST API, DTO validation, Redis caching, aggregates analytics + chain data                            | analytics, Redis, Postgres     |
| `analytics`  | Python FastAPI   | Realized APY math, emissions filter, rule-based risk score, **Fable 5.1** document analysis and explanations | Anthropic API, Postgres, Redis |
| `ingestion`  | Node/TS + BullMQ | Scheduled jobs pulling pool snapshots, prices, and audit/doc text into Postgres                              | external APIs, Redis, Postgres |
| `indexer`    | Node/TS          | Subscribes to vault program logs/accounts, writes series and position state to Postgres                      | Solana RPC, Postgres           |
| `keeper`     | Node/TS          | (1) calls `settle()` when a series matures, (2) publishes risk entries from analytics to the chain           | Solana RPC, analytics          |
| `yc_vault`   | Rust/Anchor      | Series, tranche deposits, gate, waterfall, claims                                                            | Solana                         |
| `mock_yield` | Rust/Anchor      | Devnet yield source with `simulate_yield` / `simulate_loss`                                                  | Solana                         |

**If behind schedule:** merge `indexer` and `keeper` into one worker, and have `web` read chain state directly. Keep `analytics` as its own Python service (it's on the requirements list).

---

## 6. Onchain specification (Anchor)

### 6.1 `yc_vault`

**PDAs**

| Account                                                            | Seeds                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| `Config`                                                           | `["config"]`                                          |
| `Series`                                                           | `["series", series_id_le_bytes]`                      |
| `SeriesVault` (token account, authority = Series PDA)              | `["vault", series]`                                   |
| `SeniorMint` / `JuniorMint` (share tokens, authority = Series PDA) | `["senior_mint", series]` / `["junior_mint", series]` |
| `RiskEntry`                                                        | `["risk", protocol_id]`                               |

**Accounts**

```rust
#[account] pub struct Config {
    pub admin: Pubkey,            // can create series, pause; CANNOT move vault funds
    pub risk_authority: Pubkey,   // only key allowed to write RiskEntry
    pub paused: bool,
    pub bump: u8,
}

#[account] pub struct RiskEntry {
    pub protocol_id: [u8; 32],
    pub score: u8,                // 0-100, higher = safer
    pub realized_apy_bps: u32,
    pub emissions_bps: u16,       // share of headline yield from emissions
    pub updated_at: i64,
    pub expires_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Status { Open, Active, Settled, Cancelled }

#[account] pub struct Series {
    pub id: u64,
    pub underlying_mint: Pubkey,
    pub senior_mint: Pubkey,
    pub junior_mint: Pubkey,
    pub vault: Pubkey,
    pub strategy_pool: Pubkey,        // mock_yield pool
    pub risk_entry: Pubkey,           // required RiskEntry
    pub rate_bps: u16,                // senior target, annualized
    pub term_secs: i64,
    pub deposit_deadline: i64,
    pub start_ts: i64,
    pub maturity_ts: i64,
    pub min_junior_bps: u16,
    pub min_risk_score: u8,
    pub senior_principal: u64,
    pub junior_principal: u64,
    pub senior_payout: u64,
    pub junior_payout: u64,
    pub performance_fee_bps: u16,
    pub status: Status,
    pub bump: u8,
}
```

**Instructions**

| Instruction                     | Who                                          | What it does                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init_config`                   | deployer                                     | Sets admin and risk_authority                                                                                                                                                           |
| `set_risk_entry`                | risk_authority                               | Creates/updates a `RiskEntry` (score, apy, emissions, expiry)                                                                                                                           |
| `init_series`                   | admin                                        | Creates series, mints, vault; validates params (rate <= 5000 bps, term > 0, min_junior_bps in 500..=5000)                                                                               |
| `deposit_senior`                | user                                         | Status=Open, before deadline. Transfers underlying to vault, mints senior shares 1:1. **Enforces capacity rule**                                                                        |
| `deposit_junior`                | user                                         | Same, junior side                                                                                                                                                                       |
| `activate`                      | anyone, after deadline                       | Requires `junior_ratio_ok`, risk entry fresh (`now < expires_at`) **and** `score >= min_risk_score`. Moves funds to `mock_yield` via CPI, sets `start_ts`, `maturity_ts`, Status=Active |
| `cancel_series`                 | anyone, after deadline                       | If activation conditions unmet, Status=Cancelled                                                                                                                                        |
| `refund`                        | user                                         | If Cancelled: burn shares, return principal 1:1                                                                                                                                         |
| `settle`                        | **anyone** (keeper calls it), after maturity | Withdraws all from strategy via CPI, computes waterfall, stores payouts, Status=Settled                                                                                                 |
| `claim_senior` / `claim_junior` | user                                         | Burns shares, pays `claim_amount(...)`                                                                                                                                                  |
| `set_paused`                    | admin                                        | Blocks deposits and activation only. **Never blocks refund/claim**                                                                                                                      |

**Errors:** `Paused, InvalidParams, DepositWindowClosed, DepositWindowOpen, WrongStatus, JuniorBufferTooSmall, RiskEntryStale, RiskScoreTooLow, NotMatured, MathOverflow, NothingToClaim, Unauthorized`

**Events:** `SeriesCreated, Deposited{tranche}, Activated, Settled{senior_payout, junior_payout}, Claimed, RiskUpdated`

**Invariants (write tests for each)**

1. `senior_payout + junior_payout <= total_assets_at_settle` (equal when fee is 0).
2. `senior_payout <= senior_owed`.
3. No instruction can transfer vault funds to an arbitrary destination. Vault is only spent by `activate`, `settle`, `refund`, `claim_*`. The admin key has no withdraw path.
4. Sum of all claims <= payouts (rounding dust stays in the vault).
5. Capacity rule holds after every deposit.
6. `refund` and `claim_*` work even when paused.
7. All arithmetic is checked (u128 intermediates).

### 6.2 `mock_yield` (devnet only)

- `init_pool(mint)`, `deposit(amount)`, `withdraw_all()`, plus **`simulate_yield(bps)`** (moves tokens from a faucet reserve into the pool) and **`simulate_loss(bps)`** (moves tokens out to a burn/sink account).
- Clearly label as a test double in code and README.
- This lets the demo show +6%, +2%, 0%, and -10% outcomes in minutes.

### 6.3 Required tests (Rust/TS with `anchor-bankrun` or the Anchor test suite)

1. Waterfall unit tests for every row of the Section 4.3 table.
2. Property tests: random assets and principals, then invariants 1, 2, 4.
3. Capacity rule: senior deposit rejected when it would break the buffer.
4. Activation blocked with a stale risk entry; blocked with a low score; allowed when fresh and high.
5. Full lifecycle happy path with time warp: Open, deposits, activate, simulate_yield, warp past maturity, settle, claim.
6. Loss path: `simulate_loss` makes senior payout less than `senior_owed` only after junior is wiped.
7. Cancel and refund path.
8. Unauthorized callers rejected for `set_risk_entry`, `init_series`, `set_paused`.
9. Pause blocks deposit/activate but not claim/refund.
10. Double-claim rejected.

---

## 7. Off-chain specification

### 7.1 REST API (`apps/api`), all `/v1`

| Method | Path                                                                   | Returns                                                                    |
| ------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| GET    | `/pools?profile=conservative\|balanced\|aggressive&sort=risk_adjusted` | Ranked protocols with headline, realized, emissions share, TVL, risk score |
| GET    | `/pools/:id`                                                           | Detail with risk breakdown and explanation                                 |
| GET    | `/pools/:id/history?window=7d\|30d`                                    | Time series: APY, TVL                                                      |
| GET    | `/risk/:protocolId`                                                    | Score, per-factor breakdown, sources, `computed_at`                        |
| POST   | `/risk/:protocolId/explain`                                            | Fable 5.1 explanation (served from cache in demo)                          |
| POST   | `/wallet/positions` `{address}`                                        | Positions with advertised vs realized yield                                |
| GET    | `/series` and `/series/:id`                                            | Series state (from indexer)                                                |
| GET    | `/series/:id/quote?amount=100&tranche=senior`                          | Owed amount, maturity, scenarios table                                     |
| POST   | `/series/:id/simulate` `{yieldBps}`                                    | Waterfall result for the slider (pure math, same as Rust)                  |
| GET    | `/health`                                                              | Liveness (used by Docker/K8s probes)                                       |

Validate every DTO. Cache reads in Redis (TTL 60s for pools, 10s for series). Return `updated_at` on everything.

### 7.2 Analytics service (`services/analytics`, FastAPI)

| Endpoint                  | Purpose                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /apy/realized`      | Input: price/share-rate series and window. Output: realized APY, period return                  |
| `POST /apy/emissions`     | Input: base and reward APY, reward token price series. Output: emissions share, sustainable APY |
| `POST /risk/score`        | Input: factor values. Output: 0-100 score and per-factor breakdown (pure rules)                 |
| `POST /risk/analyze-docs` | Input: doc text and metadata. Output: structured factors and citations via Fable 5.1            |
| `POST /risk/explain`      | Input: score and factors. Output: plain-English explanation                                     |
| `GET /health`             | Probes                                                                                          |

**Formulas**

```
period_return = rate_end / rate_start - 1
realized_apy  = (1 + period_return) ^ (365 / days) - 1
emissions_share = reward_apy / (base_apy + reward_apy)
sustainable_apy = base_apy + reward_apy * haircut     # haircut from reward token 30d price change, floored at 0
risk_adjusted_yield = sustainable_realized_apy * (risk_score / 100)
```

**Risk score weights (sum = 100; higher = safer)**

| Factor                                     | Weight | Source                                  |
| ------------------------------------------ | ------ | --------------------------------------- |
| Smart-contract and audit quality           | 25     | Fable 5.1 reads audit reports           |
| TVL size and stability                     | 20     | Ingested data                           |
| Yield source quality (low emissions share) | 20     | Computed                                |
| Protocol maturity and incident history     | 10     | Fable 5.1 reads docs and incident posts |
| Oracle and dependency risk                 | 10     | Fable 5.1 reads docs                    |
| Withdrawal liquidity                       | 10     | Ingested data                           |
| Governance and admin-key risk              | 5      | Fable 5.1 reads docs                    |

**Design rule:** rules compute the number, Fable 5.1 extracts facts and writes explanations. Unit-test the scoring with fixed inputs so it is reproducible.

### 7.3 Fable 5.1 usage

Model string (from Anthropic's model list): `claude-fable-5-1`. Put it in `ANTHROPIC_MODEL` so it can be changed without code edits.
Precompute and cache all analyses for the demo protocols. **Never call the model live during the demo.**

**Extraction prompt (system):**

```
You are a DeFi risk analyst. You are given raw text from a protocol's audit report, documentation,
or governance posts. Extract ONLY facts stated in the text. Do not guess. For every field, include a
short verbatim quote (under 25 words) or the source URL that supports it. If the text does not
contain the information, set the field to null and reason to "not found in provided text".
Return ONLY valid JSON matching the schema. No prose, no markdown fences.
```

**Output schema:**

```json
{
  "protocol_id": "string",
  "audits": [
    {
      "firm": "string|null",
      "date": "string|null",
      "critical_findings_unresolved": "number|null",
      "quote": "string|null",
      "source": "string"
    }
  ],
  "upgrade_authority": {
    "type": "multisig|single_key|timelock|immutable|unknown",
    "quote": "string|null",
    "source": "string|null"
  },
  "oracle": {
    "provider": "string|null",
    "quote": "string|null",
    "source": "string|null"
  },
  "past_incidents": [
    { "date": "string|null", "summary": "string", "source": "string" }
  ],
  "notes": "string|null"
}
```

**Validation (do this in code):** reject and retry if JSON is invalid, drop any field whose quote does not appear in the input text,
and cap retries at 2. Feed the validated JSON into the rule-based scorer.

### 7.4 Data model (Postgres)

```sql
protocols(id text primary key, name text, category text, chain text, audit_urls jsonb, doc_urls jsonb);

pool_snapshots(
  protocol_id text references protocols(id), ts timestamptz,
  tvl_usd numeric, apy_headline numeric, apy_base numeric, apy_reward numeric,
  share_rate numeric,                       -- exchange rate / share price when available
  primary key (protocol_id, ts));

realized_apy(protocol_id text, window_days int, apy numeric, emissions_share numeric,
             computed_at timestamptz, primary key (protocol_id, window_days));

risk_scores(protocol_id text primary key, score int, breakdown jsonb, explanation text,
            sources jsonb, computed_at timestamptz);

series(id bigint primary key, status text, rate_bps int, term_secs bigint, maturity_ts timestamptz,
       senior_principal numeric, junior_principal numeric, senior_payout numeric, junior_payout numeric,
       updated_at timestamptz);

positions(series_id bigint, owner text, tranche text, principal numeric, claimed boolean,
          primary key (series_id, owner, tranche));
```

### 7.5 Jobs (BullMQ)

| Queue           | Schedule             | Job                                                                  |
| --------------- | -------------------- | -------------------------------------------------------------------- |
| `ingest-pools`  | every 5 min          | Pull pool data and write `pool_snapshots`                            |
| `compute-apy`   | after each ingest    | Call analytics, write `realized_apy`                                 |
| `analyze-docs`  | daily / manual       | Fetch docs, call analytics `/risk/analyze-docs`, write `risk_scores` |
| `publish-risk`  | when a score changes | Keeper writes `RiskEntry` onchain with a 24h expiry                  |
| `settle-series` | every 30s            | Find matured series and call `settle`                                |

Use retries with exponential backoff and idempotency keys so the keeper can't double-submit.

### 7.6 Data sources (verify each before relying on it)

DefiLlama yields API for pool APY/TVL history, protocol APIs/SDKs for exact share rates, Solana RPC (Helius or public devnet), a price API (Pyth/Jupiter/CoinGecko), and public audit/docs pages.
Always keep a **seed snapshot** in `data/seed/` so the demo never depends on live APIs.

---

## 8. Repo structure

```
yieldcompass/
├── CLAUDE.md                     # this file
├── apps/
│   ├── web/                      # Next.js
│   └── api/                      # NestJS gateway
├── services/
│   ├── analytics/                # FastAPI: apy.py, risk.py, llm.py, main.py, tests/
│   ├── ingestion/                # BullMQ workers
│   ├── indexer/                  # chain -> Postgres
│   └── keeper/                   # settle + risk publisher
├── programs/
│   ├── yc_vault/                 # Anchor: lib.rs, math.rs, state.rs, errors.rs, instructions/
│   └── mock_yield/
├── tests/                        # anchor tests
├── infra/
│   ├── docker-compose.yml
│   └── k8s/                      # deployments, services, configmap, redis, postgres
├── data/seed/                    # cached demo data + cached Fable 5.1 outputs
└── README.md
```

### Environment variables (`.env.example`)

```
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-fable-5-1
SOLANA_RPC_URL=https://api.devnet.solana.com
KEEPER_KEYPAIR_PATH=/run/secrets/keeper.json      # devnet-only key
RISK_AUTHORITY_KEYPAIR_PATH=/run/secrets/risk.json
DATABASE_URL=postgres://yc:yc@postgres:5432/yc
REDIS_URL=redis://redis:6379
ANALYTICS_URL=http://analytics:8000
YC_VAULT_PROGRAM_ID=
MOCK_YIELD_PROGRAM_ID=
DEMO_MODE=true                                    # read seed data + cached AI output
```

### docker-compose (starter)

```yaml
services:
  web: { build: ../apps/web, ports: ["3000:3000"], depends_on: [api] }
  api:
    {
      build: ../apps/api,
      ports: ["4000:4000"],
      env_file: ../.env,
      depends_on: [redis, postgres, analytics],
    }
  analytics:
    {
      build: ../services/analytics,
      ports: ["8000:8000"],
      env_file: ../.env,
      depends_on: [redis, postgres],
    }
  ingestion:
    {
      build: ../services/ingestion,
      env_file: ../.env,
      depends_on: [redis, postgres, analytics],
    }
  indexer:
    { build: ../services/indexer, env_file: ../.env, depends_on: [postgres] }
  keeper:
    {
      build: ../services/keeper,
      env_file: ../.env,
      depends_on: [redis, analytics],
    }
  redis: { image: "redis:7" }
  postgres:
    image: "postgres:16"
    environment: { POSTGRES_USER: yc, POSTGRES_PASSWORD: yc, POSTGRES_DB: yc }
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes: { pgdata: {} }
```

### Kubernetes (bonus, do last)

One `Deployment` + `Service` per service, a `ConfigMap` for non-secret env, `Secret` for keys, liveness/readiness probes on `/health`,
resource requests/limits, and `kind`/`minikube` instructions in the README. Example probe:

```yaml
livenessProbe:
  {
    httpGet: { path: /health, port: 8000 },
    initialDelaySeconds: 10,
    periodSeconds: 10,
  }
readinessProbe:
  {
    httpGet: { path: /health, port: 8000 },
    initialDelaySeconds: 5,
    periodSeconds: 5,
  }
```

---

## 9. Security and compliance guardrails (non-negotiable)

- **Devnet and test tokens only.** No mainnet deployment, no real user funds. Say "prototype, unaudited" in the UI and README.
- **No custody by us.** The vault program holds funds in a PDA-owned token account. **No admin withdraw path exists.**
- **No promised returns.** Copy uses "target" and "estimate". Banned words in UI copy: guaranteed, risk-free, assured, safe returns.
- **Disclaimers** on every vault and projection screen: _"Target rate, not guaranteed. Devnet prototype. Informational only, not financial advice."_
- **Checked math everywhere** in Rust. No `unwrap()` in program code. Validate every account constraint (owner, mint, seeds, signer).
- **Keys:** devnet keypairs only, loaded from secrets, never committed. `.env` in `.gitignore`.
- **Legal note:** pooled products with stated returns are regulated in many jurisdictions (including India). This is a hackathon prototype. Anything real needs legal review first.
- **LLM safety:** treat all fetched documents as untrusted data. Never let document text change instructions, and always validate model JSON against the schema and the source text.

---

## 10. Demo plan (3 minutes)

1. **Problem (15s):** "Dashboards show headline APY. Much of it is bonus tokens."
2. **Explorer (40s):** show a high-APY pool with the **gap bar** and red "Mostly bonus tokens" flag. Switch to Conservative profile and watch the ranking change.
3. **Risk (30s):** open a protocol, show the factor breakdown and the cited Fable 5.1 explanation. Say clearly what the model did (read audits/docs, returned cited JSON).
4. **Vault (60s):** open a 3-minute series, deposit 100 senior and 20 junior, show the term sheet and scenario slider, activate (risk gate passes), run `simulate_yield`, settle, claim.
5. **Gate moment (20s):** show a series pointed at a low-score or stale entry being **refused** by the program.
6. **Close (15s):** "Realized truth, risk-gated by design, explainable. Devnet prototype; real integrations next."

Backups: recorded video, seed data, cached AI outputs, and a pre-funded devnet wallet with a series already created.

### Submission blurb

> **YieldCompass** shows what Solana DeFi pools actually earned, not what they advertise, and scores their risk with cited Fable 5.1 analysis.
> A fixed-term senior/junior vault (Anchor, devnet) offers a _target_ return backed by a first-loss buffer, and its program only deploys funds
> into strategies whose onchain risk score is high enough and fresh. Built with Next.js, NestJS/BullMQ, a Python FastAPI analytics service,
> Redis, Postgres, Docker, and Rust/Anchor.

---

## 11. Build order for Claude Code (phases, time boxes, acceptance)

Team of 2-3 can run tracks in parallel: **Track A** onchain (P1-P2, P6), **Track B** data and analytics (P3-P4), **Track C** frontend and API (P5, P7). Agree the API JSON shapes in the first 30 minutes.

| Phase                  | Time box | Build                                                                                                                         | Acceptance check                                                                   |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **P0 Scaffold**        | 30 min   | Repo layout, docker-compose, `.env.example`, health endpoints for every service, Postgres migrations, README                  | `docker compose up` starts everything; every `/health` returns 200                 |
| **P1 Math and tests**  | 45 min   | `math.rs` from Section 4.4, table-driven and property tests. Mirror the same math in TS (`packages/waterfall`) for the slider | All Section 4.3 rows pass in Rust and TS; property invariants pass                 |
| **P2 Programs**        | 90 min   | `yc_vault` + `mock_yield` per Section 6, including CPI                                                                        | Lifecycle, loss, cancel/refund, pause, and unauthorized tests all green            |
| **P3 Data + APY**      | 75 min   | Ingestion for 5 protocols, `pool_snapshots`, `/apy/realized`, `/apy/emissions`, seed snapshot                                 | Realized APY for one protocol matches a hand calculation; seed mode works offline  |
| **P4 Risk engine**     | 60 min   | Rule scorer with unit tests, Fable 5.1 doc extraction with validation, cached outputs in `data/seed/`                         | Scores reproducible; every explanation has sources; invalid model JSON is rejected |
| **P5 API + Web**       | 90 min   | Endpoints from 7.1; explorer table, gap bar, detail page, profile filter                                                      | UI works entirely from seed data; no console errors                                |
| **P6 Keeper + gate**   | 45 min   | `set_risk_entry` publisher and `settle` bot; end-to-end gate demo                                                             | A matured series settles without manual action; stale entry blocks `activate`      |
| **P7 Vault UI**        | 60 min   | Term sheet, deposit flows, countdown, scenario slider, claim                                                                  | Full cycle works with a wallet on devnet in under 5 minutes                        |
| **P8 Polish + freeze** | 40 min   | Disclaimers, empty/error states, "last updated", demo script, backup video                                                    | **Feature freeze 4:00 PM.** Submit before 4:30 PM                                  |
| **P9 Bonus**           | if time  | Kubernetes manifests, alerts, chat box, one real read-only integration                                                        | Only after P8                                                                      |

### Cut lines (if behind schedule, cut in this order)

1. Kubernetes, alerts, chat box.
2. `wallet/positions` (keep the explorer).
3. Indexer service (web reads chain state directly).
4. Performance fee.
5. Onchain risk gate, replaced by an off-chain check plus a clear "phase 2" note. Only cut this if the vault itself is at risk.

**Never cut:** realized APY, the gap bar, cached AI risk explanations, the waterfall tests, the disclaimers.

---

## 12. Definition of done

- [ ] `docker compose up` brings up all services; all `/health` return 200
- [ ] Realized APY correct for at least 5 protocols (one hand-verified)
- [ ] Every score shows a factor breakdown and cited explanation; AI output is cached
- [ ] Anchor tests green, including loss, cancel, pause, and unauthorized cases
- [ ] Full vault cycle works on devnet: deposit, activate, simulate, settle, claim
- [ ] Risk gate demonstrably blocks a stale or low-score strategy
- [ ] No UI copy promises returns; disclaimers visible on every vault screen
- [ ] Demo works offline from seed data; backup video recorded
- [ ] Submission form filed before 4:30 PM
