CREATE TABLE IF NOT EXISTS protocols (
  id text PRIMARY KEY, name text NOT NULL, category text, chain text,
  audit_urls jsonb DEFAULT '[]', doc_urls jsonb DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS pool_snapshots (
  protocol_id text REFERENCES protocols(id), ts timestamptz,
  tvl_usd numeric, apy_headline numeric, apy_base numeric, apy_reward numeric,
  share_rate numeric,
  PRIMARY KEY (protocol_id, ts)
);
CREATE TABLE IF NOT EXISTS realized_apy (
  protocol_id text, window_days int, apy numeric, emissions_share numeric,
  computed_at timestamptz, PRIMARY KEY (protocol_id, window_days)
);
CREATE TABLE IF NOT EXISTS risk_scores (
  protocol_id text PRIMARY KEY, score int, breakdown jsonb, explanation text,
  sources jsonb, computed_at timestamptz
);
CREATE TABLE IF NOT EXISTS series (
  id bigint PRIMARY KEY, status text, rate_bps int, term_secs bigint, maturity_ts timestamptz,
  senior_principal numeric, junior_principal numeric, senior_payout numeric, junior_payout numeric,
  updated_at timestamptz
);
CREATE TABLE IF NOT EXISTS positions (
  series_id bigint, owner text, tranche text, principal numeric, claimed boolean DEFAULT false,
  PRIMARY KEY (series_id, owner, tranche)
);
