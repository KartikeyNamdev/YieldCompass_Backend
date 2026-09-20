#!/usr/bin/env bash
# Runs the on-chain-facing end-to-end tests (keeper, indexer), each against a FRESH local validator with both
# programs preloaded. (Config is a global PDA, so suites cannot share one chain.)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
"$ROOT/scripts/dev-local.sh" up
YC=$(solana-keygen pubkey target/deploy/yc_vault-keypair.json)
MY=$(solana-keygen pubkey target/deploy/mock_yield-keypair.json)
VPID=""
stop_validator() { [ -n "$VPID" ] && kill "$VPID" 2>/dev/null && wait "$VPID" 2>/dev/null || true; VPID=""; }
trap stop_validator EXIT

run_suite() {
  local pkg="$1"
  rm -rf .local/ledger
  solana-test-validator --reset --quiet --ledger .local/ledger --rpc-port 8899 --gossip-port 18000 --dynamic-port-range 18001-18100 \
    --bpf-program "$YC" target/deploy/yc_vault.so --bpf-program "$MY" target/deploy/mock_yield.so \
    >.local/validator.log 2>&1 &
  VPID=$!
  for _ in $(seq 1 60); do
    curl -sf -X POST -H 'content-type: application/json' localhost:8899 -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q ok && break
    sleep 1
  done
  YC_VAULT_PROGRAM_ID=$YC MOCK_YIELD_PROGRAM_ID=$MY \
  TEST_RPC_URL=http://localhost:8899 TEST_DATABASE_URL=postgres://yc@localhost:5433/yc \
    npm -w "$pkg" test
  stop_validator
}

for pkg in "${@:-@yc/keeper @yc/indexer}"; do for p in $pkg; do run_suite "$p"; done; done
