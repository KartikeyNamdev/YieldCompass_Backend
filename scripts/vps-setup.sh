#!/usr/bin/env bash
# One-shot setup of the whole backend on a fresh Ubuntu/Debian server (2 GB RAM or more, 4 GB is comfortable).
#
#   1. From your laptop, once the server exists:   ssh root@SERVER_IP 'mkdir -p ~/YieldCompass_Backend'
#                                                  scp -r secrets root@SERVER_IP:~/YieldCompass_Backend/
#   2. On the server:  curl -fsSL https://raw.githubusercontent.com/KartikeyNamdev/YieldCompass_Backend/main/scripts/vps-setup.sh | \
#                        SOLANA_RPC_URL='https://devnet.helius-rpc.com/?api-key=...' bash
#
# It installs Docker, opens ports 80/443, builds everything and prints the public HTTPS URL. Re-running it updates the deployment.
set -euo pipefail

REPO="${REPO:-https://github.com/KartikeyNamdev/YieldCompass_Backend.git}"
DIR="${DIR:-$HOME/YieldCompass_Backend}"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "==> Docker"
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | $SUDO sh; fi

echo "==> Firewall (only if ufw is installed)"
if command -v ufw >/dev/null 2>&1; then $SUDO ufw allow 22/tcp >/dev/null; $SUDO ufw allow 80/tcp >/dev/null; $SUDO ufw allow 443/tcp >/dev/null; $SUDO ufw --force enable >/dev/null; fi

echo "==> Code"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else mkdir -p "$DIR"; git clone "$REPO" "$DIR.tmp" && cp -a "$DIR.tmp/." "$DIR/" && rm -rf "$DIR.tmp"; fi
cd "$DIR"

echo "==> Devnet keys (copied from your laptop)"
for k in keeper risk admin; do
  if [ ! -f "secrets/$k.json" ]; then echo "missing secrets/$k.json. Run from your laptop:  scp -r secrets root@THIS_SERVER:$DIR/"; exit 1; fi
done
chmod 600 secrets/*.json

echo "==> Config"
[ -f .env ] || cp .env.example .env
setenv() { if grep -q "^$1=" .env; then sed -i.bak "s#^$1=.*#$1=$2#" .env && rm -f .env.bak; else echo "$1=$2" >> .env; fi; }
[ -n "${SOLANA_RPC_URL:-}" ] && setenv SOLANA_RPC_URL "$SOLANA_RPC_URL"
if [ -z "${DOMAIN:-}" ]; then
  IP="$(curl -fsS https://api.ipify.org)"
  DOMAIN="${IP//./-}.sslip.io"   # works without owning a domain
fi
setenv DOMAIN "$DOMAIN"
export DOMAIN

echo "==> Build and start (first build takes several minutes)"
$SUDO docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml up -d --build

echo "==> Waiting for the API"
for _ in $(seq 1 60); do
  if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
    echo; echo "API is live:  https://$DOMAIN"; echo "Vercel:       BACKEND_URL=https://$DOMAIN  and  NEXT_PUBLIC_DEMO_MODE=false"; exit 0
  fi
  sleep 5
done
echo "The API did not answer over HTTPS yet. Check:  docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml logs --tail 50 caddy api"
exit 1
