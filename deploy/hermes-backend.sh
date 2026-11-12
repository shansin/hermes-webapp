#!/usr/bin/env bash
#
# ExecStart of hermes-backend.service: run `hermes serve` for Hem's proxy.
#
# A wrapper rather than an EnvironmentFile= because the backend must adopt the
# token the proxy holds — HERMES_DASHBOARD_SESSION_TOKEN=$HERMES_TOKEN — and an
# EnvironmentFile cannot express A=$B. It loads the same files, in the same
# order, as start.sh, so the two cannot disagree about the token.
#
# It ends in `exec`, so systemd's main PID is Hermes itself and a stop signals
# Hermes directly.
#
# Exit 78 (EX_CONFIG) is a configuration error the unit does not retry.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

say() { printf 'hermes-backend: %s\n' "$*" >&2; }

# --- config: .env, then ENV_FILE on top (later wins) — exactly as start.sh ----
# Exported (set -a) as before, when start.sh launched Hermes from its own
# environment: anything put in .env reaches Hermes the same way it always did.
[ -f .env ] && { set -a; . ./.env; set +a; }

ENV_FILE="${ENV_FILE:-}"
if [ -n "${ENV_FILE}" ]; then
  [ -f "${ENV_FILE}" ] || { say "ENV_FILE=${ENV_FILE} not found in $(pwd)"; exit 78; }
  set -a; . "./${ENV_FILE#./}"; set +a
fi

HERMES_HOST="${HERMES_HOST:-127.0.0.1}"
HERMES_PORT="${HERMES_PORT:-9119}"
LOG_DIR="${LOG_DIR:-./.logs}"

# start.sh used to mint a random token per run when none was set and hand it to
# both processes. Two independently started units cannot share a minted value,
# so under systemd the token has to be written down. setup_hermes_shsin_blog.sh
# (via deploy/install.sh) puts one in .env.
if [ -z "${HERMES_TOKEN:-}" ]; then
  say "HERMES_TOKEN is empty. Set it in .env — the proxy authenticates with it,"
  say "and this backend adopts it. e.g.:"
  say "  printf 'HERMES_TOKEN=%s\\n' \"\$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)\" >> .env"
  exit 78
fi
export HERMES_DASHBOARD_SESSION_TOKEN="${HERMES_TOKEN}"

command -v hermes >/dev/null 2>&1 || { say "hermes not found on PATH (${PATH})"; exit 78; }

# Somebody else already on the port — the pre-migration backend still inside
# hermes-webapp's cgroup, or a hand-started `hermes serve`. Starting a second
# one only produces a bind error buried in the log; say it plainly here and let
# Restart= try again until the port is free. start.sh reclaims a foreign
# backend that rejects our token.
if curl -fsS -m 3 "http://${HERMES_HOST}:${HERMES_PORT}/api/health" >/dev/null 2>&1; then
  say "port ${HERMES_PORT} is already served by another process; retrying shortly."
  exit 1
fi

# --- log ----------------------------------------------------------------------
# Appended, not truncated: this start usually follows a backend that died, and
# its last lines are the only account of why. Rotated once past 5 MB so
# appending forever cannot fill the disk; one generation back is enough.
mkdir -p "${LOG_DIR}"
SERVE_LOG="${LOG_DIR}/hermes-serve.log"
if [ -f "${SERVE_LOG}" ] && [ "$(wc -c < "${SERVE_LOG}")" -gt $((5 * 1024 * 1024)) ]; then
  mv -f "${SERVE_LOG}" "${SERVE_LOG}.1"
fi
printf '\n=== hermes-backend.service: hermes serve starting %s ===\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "${SERVE_LOG}"
say "starting hermes serve on ${HERMES_HOST}:${HERMES_PORT}; output in $(pwd)/${SERVE_LOG#./}"

exec hermes serve --port "${HERMES_PORT}" --host "${HERMES_HOST}" --skip-build \
  >> "${SERVE_LOG}" 2>&1 < /dev/null
