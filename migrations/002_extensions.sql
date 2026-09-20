-- Extensions to the CLAUDE.md 7.4 schema. All idempotent so services can re-run migrations on boot.
ALTER TABLE protocols ADD COLUMN IF NOT EXISTS launched date;
ALTER TABLE protocols ADD COLUMN IF NOT EXISTS synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE protocols ADD COLUMN IF NOT EXISTS defillama_pool text;

ALTER TABLE pool_snapshots ADD COLUMN IF NOT EXISTS reward_price numeric;
ALTER TABLE pool_snapshots ADD COLUMN IF NOT EXISTS liquidity_ratio numeric;

ALTER TABLE realized_apy ADD COLUMN IF NOT EXISTS basis text;
ALTER TABLE realized_apy ADD COLUMN IF NOT EXISTS period_return numeric;
ALTER TABLE realized_apy ADD COLUMN IF NOT EXISTS sustainable_realized_apy numeric;

ALTER TABLE risk_scores ADD COLUMN IF NOT EXISTS explanation_source text;

ALTER TABLE series ADD COLUMN IF NOT EXISTS pubkey text;
ALTER TABLE series ADD COLUMN IF NOT EXISTS underlying_mint text;
ALTER TABLE series ADD COLUMN IF NOT EXISTS decimals int NOT NULL DEFAULT 6;
ALTER TABLE series ADD COLUMN IF NOT EXISTS senior_mint text;
ALTER TABLE series ADD COLUMN IF NOT EXISTS junior_mint text;
ALTER TABLE series ADD COLUMN IF NOT EXISTS vault text;
ALTER TABLE series ADD COLUMN IF NOT EXISTS strategy_pool text;
ALTER TABLE series ADD COLUMN IF NOT EXISTS risk_entry text;
ALTER TABLE series ADD COLUMN IF NOT EXISTS deposit_deadline timestamptz;
ALTER TABLE series ADD COLUMN IF NOT EXISTS start_ts timestamptz;
ALTER TABLE series ADD COLUMN IF NOT EXISTS min_junior_bps int;
ALTER TABLE series ADD COLUMN IF NOT EXISTS min_risk_score int;
ALTER TABLE series ADD COLUMN IF NOT EXISTS performance_fee_bps int NOT NULL DEFAULT 0;

-- Keeper idempotency + audit trail: one row per submitted on-chain action.
CREATE TABLE IF NOT EXISTS tx_log (
  idempotency_key text PRIMARY KEY,
  kind text NOT NULL,
  signature text,
  status text NOT NULL DEFAULT 'pending',
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- What the keeper last wrote to each on-chain RiskEntry.
CREATE TABLE IF NOT EXISTS risk_publications (
  protocol_id text PRIMARY KEY,
  score int NOT NULL,
  expires_at timestamptz NOT NULL,
  signature text,
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS indexer_state (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexer: each transaction's events are applied exactly once.
CREATE TABLE IF NOT EXISTS processed_signatures (
  signature text PRIMARY KEY,
  slot bigint,
  processed_at timestamptz NOT NULL DEFAULT now()
);
