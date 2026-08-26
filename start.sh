#!/usr/bin/env bash
#
# Start Hem.
#
#   1. make sure the Hermes backend is up on loopback (start it if not)
#   2. make sure the web app is built
#   3. optionally publish it over Tailscale (TAILSCALE=1)
#   4. run the LAN-facing proxy, replacing one already on the port
#
# Safe to re-run: every step checks before it acts, and step 4 takes the port
# back rather than failing on it.
#
#   bash start.sh              # foreground
#   bash start.sh --bg         # detach, log to .logs/hem.log
#   bash start.sh --status     # report, change nothing
#   TAILSCALE=1 bash start.sh  # with the HTTPS front
#   ENV_FILE=.env.public bash start.sh   # the Cloudflare Tunnel + Access deployment
#
# Everything is configurable through .env — see .env.example.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# --- config ------------------------------------------------------------------

# `.env` is the base; ENV_FILE layers a deployment on top of it. The public
# (Cloudflare) setup lives in `.env.public` rather than being edited into
# `.env`, so the LAN config stays intact and switching between them is a
# choice at launch rather than a diff to remember. Later file wins — the
# proxy reads real env before its own .env, so exported values take priority.
[ -f .env ] && set -a && . ./.env && set +a || true

ENV_FILE="${ENV_FILE:-}"

# Inherit the running service's ENV_FILE when none was given.
#
# The systemd unit launches this script with ENV_FILE=.env.public, so a bare
# `bash start.sh` used to load `.env` instead and describe — or start — a
# completely different deployment: PROXY_HOST=0.0.0.0 with no Access gate,
# against a service running on loopback behind Cloudflare. `--status` reported
# the live public deployment as plain-HTTP LAN mode and advertised a URL that
# was refused, and a manual run bound the agent to the LAN and killed the
# backend out of the unit's cgroup on its way past.
#
# Reading the unit's own value keeps a hand-run consistent with what is already
# running. Explicit ENV_FILE still wins, and nothing here fails if systemd is
# absent.
if [ -z "${ENV_FILE}" ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-active --quiet hermes-webapp 2>/dev/null; then
    _unit_env="$(systemctl --user show hermes-webapp -p Environment --value 2>/dev/null || true)"
    for _kv in ${_unit_env}; do
      case "${_kv}" in
        ENV_FILE=*) ENV_FILE="${_kv#ENV_FILE=}" ;;
      esac
    done
    [ -n "${ENV_FILE}" ] && echo "  Using ENV_FILE=${ENV_FILE} from the running hermes-webapp service."
  fi
fi

if [ -n "${ENV_FILE}" ]; then
  [ -f "${ENV_FILE}" ] || { echo "ENV_FILE=${ENV_FILE} not found" >&2; exit 1; }
  set -a && . "./${ENV_FILE#./}" && set +a
fi

HERMES_HOST="${HERMES_HOST:-127.0.0.1}"
HERMES_PORT="${HERMES_PORT:-9119}"
PROXY_PORT="${PROXY_PORT:-3000}"
HERMES_TOKEN="${HERMES_TOKEN:-}"
BACKEND="http://${HERMES_HOST}:${HERMES_PORT}"
LOG_DIR="${LOG_DIR:-./.logs}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

BACKGROUND=0
STATUS_ONLY=0

for arg in "$@"; do
  case "${arg}" in
    --bg|--background) BACKGROUND=1 ;;
    --status)          STATUS_ONLY=1 ;;
    -h|--help)         sed -n '3,18p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *)                 die "Unknown option: ${arg}" ;;
  esac
done

healthy() {
  curl -fsS -m 3 "${BACKEND}/api/health" >/dev/null 2>&1
}

# Does the backend on the port accept the token we hold?
#
# `healthy` above is not enough, and the difference has bitten twice. Hermes'
# session token lives only in the memory of the process that minted it
# (`secrets.token_urlsafe(32)`, never written to disk), and `/api/health` needs
# no credential — so a backend somebody else restarted answers that probe
# perfectly while rejecting every real call with a 401 and every WS upgrade
# with a 403. The app reports "connected", then nothing works.
#
# That is exactly what an in-place `hermes update` leaves behind: the gateway
# rewrites its own systemd unit, exits 75, systemd restarts it, and the
# replacement backend comes up with a token nobody else knows.
authed() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
    ${HERMES_TOKEN:+-H "Authorization: Bearer ${HERMES_TOKEN}"} \
    "${BACKEND}/api/sessions?limit=1" 2>/dev/null || echo 000)"
  [ "${code}" = "200" ]
}

# The proxy's own endpoint, as opposed to the backend's /api/health above: a
# 200 here means the thing on the port is Hem and not something else.
# Is the public endpoint actually being served? With the Access gate configured
# the proxy binds loopback, so a dead tunnel means the app is unreachable from
# everywhere except this machine — while `/healthz` stays perfectly green. The
# symptom has no signal attached unless we go and look.
tunnel_up() {
  command -v cloudflared >/dev/null || return 1
  systemctl is-active --quiet cloudflared 2>/dev/null && return 0
  pgrep -x cloudflared >/dev/null 2>&1
}

access_configured() {
  [ -n "${ACCESS_TEAM_DOMAIN:-}" ] && [ -n "${ACCESS_AUD:-}" ] && [ -n "${ACCESS_ALLOWED_EMAILS:-}" ]
}

proxy_up() {
  curl -fsS -m 3 "http://127.0.0.1:${PROXY_PORT}/healthz" >/dev/null 2>&1
}

# Whatever holds the proxy port, found through the listening socket.
#
# Not by command line and not by environment: the server reads PROXY_PORT out
# of .env itself, so it does not reliably appear in the process environment,
# and the tree is pnpm -> tsx -> node.
#
# The trailing `|| true` matters: `grep` exits non-zero when nothing is
# listening, and under `set -o pipefail` that would propagate out of the
# command substitution in `stop_proxy` and take the whole script down under
# `set -e` — precisely in the case where the port is free and everything is
# fine. "Nothing found" is an ordinary answer here, not a failure.
pids_on_port() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnpH "sport = :${port}" 2>/dev/null |
      grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | sort -u || true
  fi
}

port_pids() { pids_on_port "${PROXY_PORT}"; }

port_free() { [ -z "$(port_pids)" ]; }

# Take the port back. We have just rebuilt web/dist, so an already-running proxy
# is serving the previous build — leaving it alone would silently ship the old
# app to a phone that has no way to tell.
stop_proxy() {
  local pids
  pids="$(port_pids)"
  [ -z "${pids}" ] && return 0

  bold "-> Stopping the proxy already on port ${PROXY_PORT} (${pids//$'\n'/ })..."
  # shellcheck disable=SC2086
  kill ${pids} 2>/dev/null || true

  # Killing the listener is enough: tsx exits with it and pnpm follows.
  for _ in $(seq 1 20); do
    port_free && return 0
    sleep 0.5
  done

  warn "  ! Did not shut down cleanly - forcing."
  pids="$(port_pids)"
  # shellcheck disable=SC2086
  [ -n "${pids}" ] && kill -9 ${pids} 2>/dev/null || true

  for _ in $(seq 1 10); do
    port_free && return 0
    sleep 0.5
  done
  die "Port ${PROXY_PORT} is still held by: $(port_pids | tr '\n' ' ')"
}

# Read the published HTTPS URL without touching the serve config.
tailscale_url() {
  command -v tailscale >/dev/null 2>&1 || return 0
  timeout 10 tailscale serve status 2>/dev/null |
    grep -m1 -oE 'https://[^ ]+' || true
}

report() {
  local lan_ip scheme
  lan_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I 2>/dev/null | awk '{print $1}')"
  scheme="http"
  [ -n "${HTTPS_CERT:-}" ] && [ -n "${HTTPS_KEY:-}" ] && scheme="https"

  echo
  bold "Hem"
  [ -n "${ENV_FILE:-}" ] && echo "  Config:          .env + ${ENV_FILE}"
  echo "  On this machine: ${scheme}://localhost:${PROXY_PORT}"
  # Only when the proxy is actually listening on the LAN. Bound to loopback
  # (the Cloudflare deployment), that address refuses connections, and printing
  # it sends you off to debug a phone that was never going to reach it.
  case "${PROXY_HOST:-0.0.0.0}" in
    127.0.0.1|localhost|::1) ;;
    *) [ -n "${lan_ip}" ] && echo "  On your phone:   ${scheme}://${lan_ip}:${PROXY_PORT}" ;;
  esac
  if access_configured && [ -n "${PUBLIC_URL:-}" ]; then
    echo "  Public:          ${PUBLIC_URL}   <- Google sign-in, open this one"
    tunnel_up || warn "  ! cloudflared is not running - that URL will not resolve to this box."
  elif [ -n "${TS_URL}" ]; then
    echo "  Over Tailscale:  ${TS_URL}   <- open this one to install the PWA"
  elif [ "${scheme}" = "http" ]; then
    warn "  HTTP mode - install/offline/push stay dormant (see README)."
    warn "  TAILSCALE=1 bash start.sh puts an HTTPS front on it."
  fi
  [ "${BACKGROUND}" = "1" ] && echo "  Logs:            ${LOG_DIR}/hem.log"
  echo
}

# --- 0. status --------------------------------------------------------------
#
# Report and change nothing. Deliberately ahead of every step below so it never
# starts a backend or kicks off a build as a side effect of being asked.

TS_URL=""

if [ "${STATUS_ONLY}" = "1" ]; then
  if healthy; then
    if authed; then
      bold "* Hermes backend up on ${HERMES_HOST}:${HERMES_PORT}"
    else
      # Green on the port, red on every call that matters. Worth its own line:
      # this is the state that reads as "connected" in the app and then fails.
      warn "! Hermes backend up on ${HERMES_HOST}:${HERMES_PORT} but rejecting our token"
      warn "  Someone else started it — probably an update restart. Re-run start.sh to reclaim it."
    fi
  else
    warn "x Hermes backend down"
  fi
  proxy_up  && bold "* Proxy up on ${PROXY_PORT}"                          || warn "x Proxy not running"
  if access_configured; then
    bold "* Access gate configured (${ACCESS_TEAM_DOMAIN})"
    tunnel_up && bold "* Cloudflare tunnel running" \
              || warn "x Cloudflare tunnel NOT running - ${PUBLIC_URL:-the public URL} is unreachable"
    [ "${PROXY_HOST}" = "0.0.0.0" ] && \
      warn "! PROXY_HOST=0.0.0.0 - :${PROXY_PORT} is open on the LAN, where Access cannot see it"
  fi
  TS_URL="$(tailscale_url)"
  report
  exit 0
fi

# --- 1. Hermes backend -------------------------------------------------------

# Stop whatever is listening on the backend port. Only ever called for a
# backend that is up and refusing the token we hold — see the block below.
stop_backend() {
  local pids
  pids="$(pids_on_port "${HERMES_PORT}")"
  [ -z "${pids}" ] && return 0

  bold "-> Stopping the backend on port ${HERMES_PORT} (${pids//$'\n'/ })..."
  # shellcheck disable=SC2086
  kill ${pids} 2>/dev/null || true

  for _ in $(seq 1 20); do
    healthy || return 0
    sleep 0.5
  done

  warn "  ! Did not shut down cleanly - forcing."
  pids="$(pids_on_port "${HERMES_PORT}")"
  # shellcheck disable=SC2086
  [ -n "${pids}" ] && kill -9 ${pids} 2>/dev/null || true
  sleep 1
}

if healthy && ! authed && [ -n "${HERMES_TOKEN}" ]; then
  # We hold a token, the backend will not take it, and its own token is
  # unknowable — headless `hermes serve` mints it in memory and serves no HTML
  # to scrape it from. Restarting is the only way the two can agree again, and
  # we can do it safely because we are about to hand it the token ourselves.
  #
  # This kills only the listener on ${HERMES_PORT}. `hermes-gateway.service` is
  # a separate process on no port and is left alone.
  warn "! The backend on ${HERMES_PORT} is up but rejects our token — reclaiming it."
  stop_backend
fi

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

# Always rebuild: the proxy serves the prebuilt bundle, so reusing a stale
# `web/dist` silently ships yesterday's app to a phone that has no way to tell.
# SKIP_BUILD=1 opts out when restarting the proxy against an unchanged tree.
if [ "${SKIP_BUILD:-0}" = "1" ] && [ -f web/dist/index.html ]; then
  bold "→ Skipping the web build (SKIP_BUILD=1)"
else
  bold "→ Building the web app…"
  pnpm build
fi

# --- 3. tailscale serve (optional HTTPS front) -------------------------------
#
# The PWA layer only wakes up in a secure context. `tailscale serve` terminates
# TLS under this node's MagicDNS name with a real Let's Encrypt cert and
# forwards to the proxy over loopback, so the phone gets HTTPS with nothing to
# install — and it keeps working off the LAN. The proxy itself stays plain HTTP.
#
# Managing serve config needs root unless the operator was set once:
#   sudo tailscale set --operator=$USER
# and the tailnet needs HTTPS certificates enabled (admin console → DNS).

if [ "${TAILSCALE:-0}" = "1" ]; then
  command -v tailscale >/dev/null || die "TAILSCALE=1 but tailscale is not on PATH."

  bold "→ Publishing over Tailscale…"

  # Reading the serve config is unprivileged; *writing* it needs root, or the
  # operator bit. So look before leaping — once the mapping exists it survives
  # reboots, making "already correct" the normal case on every run after the
  # first, and blindly re-asserting it would fail noisily for nothing.
  ts_serve="$(timeout 10 tailscale serve status 2>/dev/null || true)"

  if ! grep -qE "proxy +https?://(127\.0\.0\.1|localhost):${PROXY_PORT}\b" <<<"${ts_serve}"; then
    # </dev/null so the first-run prompt (it asks before enabling HTTPS certs
    # tailnet-wide) fails fast instead of hanging the script forever.
    if timeout 30 tailscale serve --bg "${PROXY_PORT}" </dev/null >/dev/null 2>&1; then
      ts_serve="$(timeout 10 tailscale serve status 2>/dev/null || true)"
    else
      warn "  ! Could not publish port ${PROXY_PORT}. Writing serve config needs root:"
      warn "      sudo tailscale serve --bg ${PROXY_PORT}       # once — it persists"
      warn "      sudo tailscale set --operator=\$USER        # …or grant it for good"
      warn "    The tailnet also needs HTTPS certificates enabled:"
      warn "      https://login.tailscale.com/admin/dns"
    fi
  fi

  TS_URL="$(grep -m1 -oE 'https://[^ ]+' <<<"${ts_serve}" || true)"
  if [ -n "${TS_URL}" ]; then
    # The server can't see past the front, so tell it the address to hand out
    # for the QR code and the install hint.
    export PUBLIC_URL="${TS_URL}"
  else
    warn "  ! No HTTPS URL from tailscale — falling back to plain LAN HTTP."
  fi

elif [ -z "${PUBLIC_URL:-}" ]; then
  # --- already published, but nobody said TAILSCALE=1 -------------------------
  #
  # `tailscale serve` config persists across reboots, so once this node has been
  # published the mapping is simply *there* — and every later run without
  # TAILSCALE=1 would ignore it, leave PUBLIC_URL unset, and hand the phone the
  # plain LAN HTTP address as the install target. A service worker cannot
  # register on that origin, so installing from it produces a bookmark rather
  # than a PWA, and nothing off the LAN works at all.
  #
  # That is a trap with no signal attached: the HTTPS front is up and serving
  # correctly the whole time, so the only symptom is an installed app that will
  # not open. Reading the existing mapping costs one unprivileged call and
  # changes no state, so adopt it rather than making the flag load-bearing on
  # every subsequent run.
  adopted="$(tailscale_url)"
  if [ -n "${adopted}" ] && grep -qE "proxy +https?://(127\.0\.0\.1|localhost):${PROXY_PORT}\b" \
      <<<"$(timeout 10 tailscale serve status 2>/dev/null || true)"; then
    TS_URL="${adopted}"
    export PUBLIC_URL="${TS_URL}"
    bold "→ Adopting the existing Tailscale front: ${TS_URL}"
  fi
fi

# --- 4. proxy ----------------------------------------------------------------
#
# Take the port before binding it. Step 2 just rebuilt `web/dist`, so a proxy
# already running here is serving the previous build; replacing it is the whole
# point of having run this script. Without this the script died of EADDRINUSE
# whenever it was run twice — every step above is happy to be repeated, and
# this was the one that was not.

stop_proxy
port_free || die "Port ${PROXY_PORT} is in use by: $(port_pids | tr '\n' ' ')"

if [ "${BACKGROUND}" = "1" ]; then
  mkdir -p "${LOG_DIR}"
  bold "→ Starting the proxy in the background…"
  # setsid so it outlives this shell and its terminal.
  setsid nohup pnpm --filter @hem/server start \
    >> "${LOG_DIR}/hem.log" 2>&1 < /dev/null &

  for _ in $(seq 1 60); do
    proxy_up && break
    sleep 1
  done
  if ! proxy_up; then
    warn "  ! Proxy did not come up. Last lines of ${LOG_DIR}/hem.log:"
    tail -n 15 "${LOG_DIR}/hem.log" >&2 || true
    die "Startup failed."
  fi
  bold "✓ Proxy up on ${PROXY_PORT}"
  report
else
  report
  exec pnpm --filter @hem/server start
fi
