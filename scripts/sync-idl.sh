#!/usr/bin/env bash
# Copy freshly built Anchor IDLs into the shared package (run after `anchor build`).
set -euo pipefail
cd "$(dirname "$0")/.."
cp target/idl/yc_vault.json target/idl/mock_yield.json packages/shared/src/idl/
echo "IDLs synced to packages/shared/src/idl"
