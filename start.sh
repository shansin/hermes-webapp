#!/usr/bin/env bash
#
# Start Hermes Control.
#
#   1. make sure the Hermes backend is up on loopback (start it if not)
#   2. make sure the web app is built
#   3. run the LAN-facing proxy
#
# Everything is configurable through .env — see .env.example.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# --- config ------------------------------------------------------------------

[ -f .env ] && set -a && . ./.env && set +a || true

HERMES_HOST="${HERMES_HOST:-127.0.0.1}"
HERMES_PORT="${HERMES_PORT:-9119}"
PROXY_PORT="${PROXY_PORT:-3000}"
HERMES_TOKEN="${HERMES_TOKEN:-}"
BACKEND="http://${HERMES_HOST}:${HERMES_PORT}"
LOG_DIR="${LOG_DIR:-./.logs}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

healthy() {
  curl -fsS -m 3 "${BACKEND}/api/health" >/dev/null 2>&1
}

# --- 1. Hermes backend -------------------------------------------------------

if healthy; then
  bold "✓ Hermes backend already running on ${HERMES_HOST}:${HERMES_PORT}"

  # A backend we didn't start has its own random token unless one was given.
  # `hermes dashboard` embeds it in its SPA HTML, which the proxy can scrape;
  # headless `hermes serve` does not, so we ask for it explicitly.
  if [ -z "${HERMES_TOKEN}" ]; then
    if curl -fsS -m 3 "${BACKEND}/" 2>/dev/null | grep -q '__HERMES_DASHBOARD_SESSION_TOKEN__'; then
      bold "  Token will be auto-discovered from the running dashboard."
    else
      warn "  ! This backend is headless and was not started by us, so its"
      warn "    session token cannot be discovered. Set HERMES_TOKEN in .env to"
      warn "    the value it was launched with, or stop it and re-run start.sh."
    fi
  fi
else
  command -v hermes >/dev/null || die "hermes not found on PATH."

  # We're launching it, so we choose the token. Generate one if none is set.
  if [ -z "${HERMES_TOKEN}" ]; then
    HERMES_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
    bold "  Generated a session token for this run."
  fi
  export HERMES_TOKEN
  export HERMES_DASHBOARD_SESSION_TOKEN="${HERMES_TOKEN}"

  mkdir -p "${LOG_DIR}"
  bold "→ Starting Hermes backend on ${HERMES_HOST}:${HERMES_PORT}…"
  nohup hermes serve --port "${HERMES_PORT}" --host "${HERMES_HOST}" --skip-build \
    > "${LOG_DIR}/hermes-serve.log" 2>&1 &

  for _ in $(seq 1 60); do
    healthy && break
    sleep 1
  done
  healthy || die "Hermes did not become healthy. See ${LOG_DIR}/hermes-serve.log"
  bold "✓ Hermes backend ready"
fi

export HERMES_TOKEN

# --- 2. web build ------------------------------------------------------------

command -v pnpm >/dev/null || die "pnpm not found. Install it: corepack enable pnpm"

[ -d node_modules ] || { bold "→ Installing dependencies…"; pnpm install; }

if [ ! -f web/dist/index.html ] || [ "${REBUILD:-0}" = "1" ]; then
  bold "→ Building the web app…"
  pnpm build
fi

# --- 3. proxy ----------------------------------------------------------------

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I 2>/dev/null | awk '{print $1}')"
SCHEME="http"
[ -n "${HTTPS_CERT:-}" ] && [ -n "${HTTPS_KEY:-}" ] && SCHEME="https"

echo
bold "Hermes Control"
echo "  On this machine: ${SCHEME}://localhost:${PROXY_PORT}"
[ -n "${LAN_IP}" ] && echo "  On your phone:   ${SCHEME}://${LAN_IP}:${PROXY_PORT}"
[ "${SCHEME}" = "http" ] && warn "  HTTP mode — install/offline/push stay dormant (see README)."
echo

exec pnpm --filter @hermes-webapp/server start
