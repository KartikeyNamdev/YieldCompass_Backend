#!/usr/bin/env bash
# Create DEVNET-ONLY keypairs for the keeper and the risk authority in ./secrets (gitignored). Never use these on mainnet.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p secrets
for k in keeper risk admin; do
  [ -f "secrets/$k.json" ] || solana-keygen new --no-bip39-passphrase --silent -o "secrets/$k.json"
  echo "$k: $(solana-keygen pubkey "secrets/$k.json")"
done
echo "Fund them on devnet:  solana airdrop 2 <pubkey> --url devnet"
