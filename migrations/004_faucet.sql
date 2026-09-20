-- Test-token faucet cooldown: at most one drip per address per cooldown window.
CREATE TABLE IF NOT EXISTS faucet_log (
  address text PRIMARY KEY,
  last_at timestamptz NOT NULL DEFAULT now(),
  drips int NOT NULL DEFAULT 1
);
