#!/usr/bin/env bash
#
# Install Hem's systemd user units from deploy/ — and change nothing that runs.
#
#   bash deploy/install.sh
#
# What it does, every time (safe to re-run):
#   - copies deploy/hermes-serve.service and deploy/hermes-webapp.service into
#     ~/.config/systemd/user/, keeping a .bak.<timestamp> of any copy that
#     differs (a hand-edited unit is never lost silently)
#   - writes <unit>.d/override.conf with this machine's PATH and repo directory
#     ONLY IF that file does not exist yet, so hand edits there survive re-runs
#   - makes sure .env has a HERMES_TOKEN (both units read it; see
#     deploy/hermes-serve.sh)
#   - daemon-reload, and `enable` both units (start at boot) — EXCEPT while the
#     pre-split layout is running (Hermes inside hermes-webapp's cgroup): then
#     it enables without reloading and prints the commands to run when idle
#
# What it does NOT do: start, stop or restart anything. Applying the change is a
# separate, deliberate step — see deploy/README.md for why the first one
# matters.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_DIR="$(pwd -P)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNITS=(hermes-serve.service hermes-webapp.service)

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mx %s\033[0m\n' "$*" >&2; exit 1; }

command -v systemctl >/dev/null 2>&1 || die "systemctl not found — these are systemd user units."

# --- PATH for the units -------------------------------------------------------
# systemd runs no login shell, so nvm's node is invisible to a unit unless named.
# Resolved from the shell running this script; run it from a shell where `node`
# and `hermes` work.
NODE="$(command -v node || true)"
[ -n "${NODE}" ] || die "node is not on PATH. Run this from a shell where node works (nvm loaded)."
NODE_BIN="$(dirname "${NODE}")"
PNPM_BIN="$(dirname "$(command -v pnpm 2>/dev/null || echo "${NODE}")")"
if command -v hermes >/dev/null 2>&1; then
  HERMES_BIN="$(dirname "$(command -v hermes)")"
elif [ -x "$HOME/.local/bin/hermes" ]; then
  HERMES_BIN="$HOME/.local/bin"
else
  die "hermes is not on PATH. Install Hermes first."
fi

unit_path=""
for d in "${NODE_BIN}" "${PNPM_BIN}" "${HERMES_BIN}" "$HOME/.local/bin" /usr/local/bin /usr/bin /bin; do
  case ":${unit_path}:" in *":${d}:"*) ;; *) unit_path="${unit_path:+${unit_path}:}${d}" ;; esac
done

# --- units --------------------------------------------------------------------
mkdir -p "${UNIT_DIR}"
stamp="$(date +%Y%m%d_%H%M%S)"

for u in "${UNITS[@]}"; do
  src="deploy/${u}"
  dst="${UNIT_DIR}/${u}"
  if [ -f "${dst}" ] && ! cmp -s "${src}" "${dst}"; then
    cp -p "${dst}" "${dst}.bak.${stamp}"
    bold "  ✓ backed up the previous ${u} → ${u}.bak.${stamp}"
  fi
  install -m 0644 "${src}" "${dst}"
  bold "  ✓ ${dst}"

  od="${UNIT_DIR}/${u}.d"
  ov="${od}/override.conf"
  if [ -f "${ov}" ]; then
    bold "  ✓ kept existing ${ov} (hand edits are never overwritten)"
    continue
  fi
  mkdir -p "${od}"
  {
    cat <<EOF
# Per-machine settings for ${u}, written once by deploy/install.sh and never
# overwritten by it. Edit freely (or: systemctl --user edit ${u%.service}),
# then: systemctl --user daemon-reload && systemctl --user restart ${u%.service}
#
# Delete this file and re-run deploy/install.sh to regenerate it.
[Service]
WorkingDirectory=${REPO_DIR}
Environment=PATH=${unit_path}
EOF
    if [ "${u}" = hermes-serve.service ]; then
      cat <<'EOF'

# The unit ships GNOME/Wayland defaults for computer use (DISPLAY, XAUTHORITY,
# WAYLAND_DISPLAY, CUA_DRIVER_RS_ENABLE_WAYLAND, …). Override any that differ
# here, e.g. on an X11 session:
#Environment=CUA_DRIVER_RS_ENABLE_WAYLAND=0
#Environment=XDG_SESSION_TYPE=x11
#
# Hermes resolves cua-driver from its own pinned store and ignores PATH; to use
# a separately installed driver (as hermes-gateway.service's drop-in does):
#Environment=HERMES_CUA_DRIVER_CMD=%h/.local/bin/cua-driver
EOF
    fi
  } > "${ov}"
  bold "  ✓ wrote ${ov}"
done

# --- the token both units share ----------------------------------------------
# start.sh used to mint one per run and hand it to both processes; two units
# started independently cannot share a minted value, so it is written down.
if [ ! -f .env ]; then
  cp .env.example .env
  bold "  ✓ .env from .env.example"
fi
if ! grep -qE '^HERMES_TOKEN=.+' .env; then
  token="$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | head -c 32)"
  if grep -qE '^HERMES_TOKEN=' .env; then
    tmp="$(mktemp)"
    sed "s|^HERMES_TOKEN=.*|HERMES_TOKEN=${token}|" .env > "${tmp}"
    cat "${tmp}" > .env && rm -f "${tmp}"
  else
    printf '\nHERMES_TOKEN=%s\n' "${token}" >> .env
  fi
  unset token
  bold "  ✓ generated HERMES_TOKEN in .env"
else
  bold "  ✓ HERMES_TOKEN already set in .env"
fi

# --- the layout running now ---------------------------------------------------
# Pre-split: the Hermes on the backend port lives in hermes-webapp.service's
# cgroup, because start.sh used to nohup it from there. A daemon-reload applies
# the new hermes-webapp definition to the RUNNING cgroup at once — MemoryHigh/
# MemoryMax sized for a proxy, a 15s stop timeout — and that cgroup still holds
# `hermes serve`, its MCP servers and its tools (~900 MB on the live box): the
# agent gets throttled and OOM-killed mid-turn. So in that layout nothing here
# reloads, and `enable` gets --no-reload, since it reloads implicitly too.
#
# Found the way start.sh --status finds it: the listener's PID, then the unit
# named in its cgroup. The port is the last HERMES_PORT= in .env, then
# .env.public (start.sh's order), unquoted.
env_port() {
  { sed -n 's/^HERMES_PORT=//p' .env .env.public 2>/dev/null || true; } | tr -d "\"'" | tail -n 1
}
HERMES_PORT="${HERMES_PORT:-$(env_port)}"
HERMES_PORT="${HERMES_PORT:-9119}"
backend_listener_unit() {
  local pid
  pid="$(ss -tlnpH "sport = :${HERMES_PORT}" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -n 1 | cut -d= -f2 || true)"
  [ -n "${pid}" ] && grep -oE '[^/]+\.service' "/proc/${pid}/cgroup" 2>/dev/null | tail -n 1
  return 0
}

if [ "$(backend_listener_unit)" = hermes-webapp.service ]; then
  systemctl --user enable --no-reload "${UNITS[@]}" >/dev/null 2>&1 || die "systemctl --user enable failed."
  bold "  ✓ hermes-serve + hermes-webapp enabled — NOT reloaded, nothing restarted"
  echo
  warn "  The Hermes on :${HERMES_PORT} still runs inside hermes-webapp.service (the pre-split"
  warn "  layout). Reloading would put it under the proxy's memory caps mid-turn, so that"
  warn "  is left to you. After 'pnpm install --frozen-lockfile && pnpm build', when NO turn"
  warn "  is running, run together:"
  warn ""
  warn "    systemctl --user daemon-reload && systemctl --user restart hermes-webapp"
  warn "    systemctl --user enable --now hermes-serve"
  warn ""
  warn "  The restart stops the old cgroup (ending the old hermes serve, once), then starts"
  warn "  the proxy, which pulls hermes-serve in on the freed port. See deploy/README.md."
  exit 0
fi

# --- activate the definitions (not the services) ------------------------------
systemctl --user daemon-reload
systemctl --user enable "${UNITS[@]}" >/dev/null 2>&1 || die "systemctl --user enable failed."
bold "  ✓ daemon-reload; hermes-serve + hermes-webapp enabled (nothing restarted)"

if systemctl --user is-active --quiet hermes-webapp; then
  echo
  warn "  hermes-webapp is running with the definition it started with. To apply:"
  warn "    systemctl --user restart hermes-webapp     # the proxy only — turns survive"
fi
