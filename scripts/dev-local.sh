#!/usr/bin/env bash
# Docker-free local infrastructure for development and integration tests.
#   scripts/dev-local.sh up     start Postgres (5433), Redis (6380), analytics (8000)
#   scripts/dev-local.sh down   stop everything
# Requires Homebrew postgres + redis and services/analytics/.venv (python -m venv .venv && pip install -r requirements-dev.txt)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
L="$ROOT/.local"
mkdir -p "$L"
case "${1:-up}" in
  up)
    if [ ! -d "$L/pg" ]; then initdb -D "$L/pg" -U yc --auth=trust >/dev/null; fi
    pg_ctl -D "$L/pg" -o "-p 5433 -k $L" -l "$L/pg.log" -w start >/dev/null || true
    createdb -h localhost -p 5433 -U yc yc 2>/dev/null || true
    (redis-cli -p 6380 ping >/dev/null 2>&1) || redis-server --port 6380 --dir "$L" --daemonize yes >/dev/null
    if ! curl -sf localhost:8000/health >/dev/null; then
      (cd "$ROOT/services/analytics" && SEED_DIR="$ROOT/data/seed" DEMO_MODE="${DEMO_MODE:-true}" \
        nohup .venv/bin/uvicorn app.main:app --port 8000 >"$L/analytics.log" 2>&1 & echo $! >"$L/analytics.pid")
      for _ in $(seq 1 30); do curl -sf localhost:8000/health >/dev/null && break; sleep 0.5; done
    fi
    echo "postgres=postgres://yc@localhost:5433/yc  redis=redis://localhost:6380  analytics=http://localhost:8000"
    ;;
  down)
    [ -f "$L/analytics.pid" ] && kill "$(cat "$L/analytics.pid")" 2>/dev/null || true
    redis-cli -p 6380 shutdown nosave 2>/dev/null || true
    pg_ctl -D "$L/pg" stop -m fast 2>/dev/null || true
    ;;
esac
