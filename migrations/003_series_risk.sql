-- Series rows also carry the gating risk entry (read from chain by the indexer) and a first-seen timestamp.
ALTER TABLE series ADD COLUMN IF NOT EXISTS protocol_id text;
ALTER TABLE series ADD COLUMN IF NOT EXISTS risk_score int;
ALTER TABLE series ADD COLUMN IF NOT EXISTS risk_expires_at timestamptz;
ALTER TABLE series ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
