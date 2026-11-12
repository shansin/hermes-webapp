#!/usr/bin/env bash
#
# ExecStart of hermes-serve.service: run `hermes serve` for Hem's proxy.
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

say() { printf 'hermes-serve: %s\n' "$*" >&2; }

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
# one only produces a bind error buried in the log. Wait here instead: the
# usual holder is the old backend on its way out (the migration's restart of
# hermes-webapp), gone within its stop timeout. One line for the whole wait —
# exiting at once had Restart= relaunch this every 5s, a journal line each
# time, for as long as a hand-started backend lived. After two minutes, exit 1
# and let RestartSec (30s) pace the next look. start.sh reclaims a foreign
# backend that rejects our token.
port_held() {
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -tlnH "sport = :${HERMES_PORT}" 2>/dev/null)" ]
  else
    curl -fsS -m 3 "http://${HERMES_HOST}:${HERMES_PORT}/api/health" >/dev/null 2>&1
  fi
}

if port_held; then
  pid="$(ss -tlnpH "sport = :${HERMES_PORT}" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -n 1 | cut -d= -f2 || true)"
  # Its unit, from the cgroup — the same reading as start.sh's pid_unit.
  unit="$([ -n "${pid}" ] && grep -oE '[^/]+\.service' "/proc/${pid}/cgroup" 2>/dev/null | tail -n 1 || true)"
  say "port ${HERMES_PORT} is held by another process${pid:+ (pid ${pid}${unit:+, ${unit}})}; waiting up to 2 minutes for it to free."
  for _ in $(seq 1 24); do
    sleep 5
    port_held || break
  done
  if port_held; then
    say "port ${HERMES_PORT} is still held; giving up for now (systemd retries in 30s)."
    exit 1
  fi
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
printf '\n=== hermes-serve.service: hermes serve starting %s ===\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "${SERVE_LOG}"
say "starting hermes serve on ${HERMES_HOST}:${HERMES_PORT}; output in $(pwd)/${SERVE_LOG#./}"

exec hermes serve --port "${HERMES_PORT}" --host "${HERMES_HOST}" --skip-build \
  >> "${SERVE_LOG}" 2>&1 < /dev/null
