#!/usr/bin/env bash
#
# Rebuild the public deployment of Hem on a fresh machine.
#
# Run this after a format, once Hermes itself is installed. It stands the whole
# thing back up: dependencies, the web build, a Cloudflare Tunnel, the Access
# gate, and the systemd services that bring it all back after a reboot.
#
#   bash setup_hermes_shsin_blog.sh
#
# WHAT THIS SCRIPT CANNOT DO, and why:
#
#   The Google OAuth client. Google exposes no API for creating Web-application
#   OAuth clients — not through gcloud either — so it is a browser step, once,
#   forever. It is also account-level: if the Cloudflare account survived, the
#   identity provider is still there and you will never be asked for it.
#
#   The nameserver change at the registrar. Only needed if the zone is not
#   already on Cloudflare, which it will be — DNS lives in the Cloudflare
#   account, not on this machine, so a format does not touch it.
#
# WHAT SURVIVES A FORMAT (and is therefore adopted, not recreated):
#   the zone and its DNS, the Zero Trust org, the Google identity provider,
#   the Access application and its policy.
#
# WHAT DOES NOT (and is therefore rebuilt every run):
#   the tunnel credentials. `tunnel_secret` is returned once at creation and is
#   not retrievable afterwards, so a machine that lost ~/.cloudflared cannot
#   rejoin its old tunnel. The script creates a fresh tunnel and repoints the
#   hostname at it — which is why it also deletes the stale one, rather than
#   leaving a graveyard of dead tunnels behind every rebuild.
#
# Safe to re-run. Every step checks before it acts.

set -euo pipefail

# --- what we are building ----------------------------------------------------

DOMAIN="shsin.blog"
SUBDOMAIN="hermes"
FQDN="${SUBDOMAIN}.${DOMAIN}"
TUNNEL_NAME="hermes"
APP_NAME="Hem"
# Who Access will admit, comma-separated Google accounts.
#
# Not hardcoded, because this file lives in a public repository and an
# allowlist is a list of real people's personal email addresses — including
# other people's, who did not choose to publish theirs. Pass it in:
#
#   ALLOWED_EMAILS="you@gmail.com,someone@gmail.com" bash setup_hermes_shsin_blog.sh
ALLOWED_EMAILS="${ALLOWED_EMAILS:-}"
SESSION_DURATION="720h"          # 30 days; keeps a standalone PWA from re-logging in

REPO_URL="https://github.com/shansin/hermes-webapp.git"
REPO_DIR="${REPO_DIR:-$HOME/code/hermes-webapp}"
PROXY_PORT="${PROXY_PORT:-3000}"
HERMES_PORT="${HERMES_PORT:-9119}"

CF_API="https://api.cloudflare.com/client/v4"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.cf-token}"

# --- output ------------------------------------------------------------------

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mx %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# --- cloudflare api ----------------------------------------------------------

cf() {
  local method="$1" path="$2" body="${3:-}"
  local -a args=(-sS -X "$method" -H "Authorization: Bearer ${CF_TOKEN}")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "${CF_API}${path}"
}

# Fail with the API's own words. A silent empty result here is how you end up
# debugging the wrong layer half an hour later.
cf_ok() {
  local out="$1" what="${2:-API call}"
  if [ "$(jq -r '.success' <<<"$out")" != "true" ]; then
    warn "${what} failed:"
    jq -r '.errors[]? | "    [\(.code)] \(.message)"' <<<"$out" >&2
    return 1
  fi
}

# --- 0. prerequisites --------------------------------------------------------

step "Checking prerequisites"

for cmd in curl jq git; do
  command -v "$cmd" >/dev/null || die "$cmd is required. sudo apt install $cmd"
done
bold "  ✓ curl, jq, git"

[ -n "${ALLOWED_EMAILS}" ] || die "Set ALLOWED_EMAILS to a comma-separated list of Google accounts, e.g.
  ALLOWED_EMAILS=\"you@gmail.com\" bash ${0##*/}"
bold "  ✓ allowlist: ${ALLOWED_EMAILS}"

if ! command -v pnpm >/dev/null; then
  command -v corepack >/dev/null || die "Node.js is required (with corepack, for pnpm)."
  corepack enable pnpm || die "Could not enable pnpm via corepack."
fi
bold "  ✓ pnpm $(pnpm --version)"

# Hermes is the one thing this script assumes rather than installs.
command -v hermes >/dev/null || [ -x "$HOME/.hermes/hermes-agent/hermes" ] \
  || die "Hermes is not installed. Install it first, then re-run."
bold "  ✓ hermes"

# --- 1. the token ------------------------------------------------------------

step "Cloudflare API token"

if [ -s "$TOKEN_FILE" ]; then
  CF_TOKEN="$(cat "$TOKEN_FILE")"
  bold "  ✓ read from ${TOKEN_FILE}"
else
  cat <<'HELP'
  Create one at https://dash.cloudflare.com/profile/api-tokens
  ("Create Custom Token"), with these permissions:

      Account | Cloudflare Tunnel                                    | Edit
      Account | Access: Apps and Policies                            | Edit
      Account | Access: Organizations, Identity Providers, and Groups| Read
      Zone    | DNS                                                  | Edit
      Zone    | Zone                                                 | Read

  Account Resources: your account.   Zone Resources: all zones.

HELP
  read -rsp "  Paste the token (not echoed): " CF_TOKEN
  echo
  [ -n "$CF_TOKEN" ] || die "No token given."
  ( umask 077; printf '%s' "$CF_TOKEN" > "$TOKEN_FILE" )
  bold "  ✓ saved to ${TOKEN_FILE} (0600)"
fi

out=$(cf GET /user/tokens/verify)
cf_ok "$out" "Token verification" || die "That token is not usable."
bold "  ✓ token active"

# --- 2. locate the account and zone ------------------------------------------

step "Finding the ${DOMAIN} zone"

out=$(cf GET "/zones?name=${DOMAIN}")
cf_ok "$out" "Zone lookup" || die "Could not list zones."
ZONE_ID="$(jq -r '.result[0].id // empty' <<<"$out")"
[ -n "$ZONE_ID" ] || die "${DOMAIN} is not in this Cloudflare account. Add it in the dashboard and point the registrar's nameservers at Cloudflare first."

ZONE_STATUS="$(jq -r '.result[0].status' <<<"$out")"
ACCOUNT_ID="$(jq -r '.result[0].account.id' <<<"$out")"
bold "  ✓ zone ${ZONE_ID} (${ZONE_STATUS})"
[ "$ZONE_STATUS" = "active" ] || warn "  ! zone is '${ZONE_STATUS}' — DNS will not resolve until it is active."

# --- 3. the repo -------------------------------------------------------------

step "Repository"

if [ -d "$REPO_DIR/.git" ]; then
  bold "  ✓ already at ${REPO_DIR}"
else
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone "$REPO_URL" "$REPO_DIR" || die "Clone failed."
  bold "  ✓ cloned to ${REPO_DIR}"
fi
cd "$REPO_DIR"

pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null || die "pnpm install failed."
bold "  ✓ dependencies"

pnpm build >/dev/null 2>&1 || die "Web build failed. Run 'pnpm build' to see why."
bold "  ✓ web/dist built"

# --- 4. cloudflared ----------------------------------------------------------

step "cloudflared"

CLOUDFLARED="$HOME/.local/bin/cloudflared"
if [ -x "$CLOUDFLARED" ]; then
  bold "  ✓ already installed ($("$CLOUDFLARED" --version | head -1))"
elif command -v cloudflared >/dev/null; then
  CLOUDFLARED="$(command -v cloudflared)"
  bold "  ✓ found at ${CLOUDFLARED}"
else
  # Deliberately the standalone binary rather than the apt package: this needs
  # no root, which keeps the whole script runnable without a password prompt.
  mkdir -p "$HOME/.local/bin"
  arch="$(uname -m)"
  case "$arch" in
    x86_64) cfarch=amd64 ;;
    aarch64|arm64) cfarch=arm64 ;;
    *) die "Unsupported architecture: ${arch}" ;;
  esac
  curl -fsSL -o "$CLOUDFLARED" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cfarch}" \
    || die "Download failed."
  chmod 755 "$CLOUDFLARED"
  bold "  ✓ installed $("$CLOUDFLARED" --version | head -1)"
fi

# --- 5. the tunnel -----------------------------------------------------------

step "Tunnel"

# A tunnel whose credentials we no longer hold is useless to us, and its name is
# taken. Remove it so the name is free, then make a new one.
out=$(cf GET "/accounts/${ACCOUNT_ID}/cfd_tunnel?name=${TUNNEL_NAME}&is_deleted=false")
OLD_ID="$(jq -r '.result[0].id // empty' <<<"$out")"
if [ -n "$OLD_ID" ]; then
  if [ -s "$HOME/.cloudflared/${OLD_ID}.json" ]; then
    TUNNEL_ID="$OLD_ID"
    bold "  ✓ reusing tunnel ${TUNNEL_ID} (credentials still on disk)"
  else
    warn "  ! tunnel '${TUNNEL_NAME}' exists but its secret is not on this machine"
    warn "    (tunnel_secret is returned once at creation and never again)"

    # A tunnel with live connections is not deleted, only marked — and the name
    # stays reserved, so the create below then fails with 1013. Stop the local
    # connector first; anything else holding it will be waited out next.
    systemctl --user stop cloudflared >/dev/null 2>&1 || true

    cf DELETE "/accounts/${ACCOUNT_ID}/cfd_tunnel/${OLD_ID}" >/dev/null 2>&1 || true

    # Deletion is not instant. Poll for the name to actually come free rather
    # than racing it, because the failure is a confusing 1013 several lines later.
    freed=0
    for _ in $(seq 1 15); do
      probe=$(cf GET "/accounts/${ACCOUNT_ID}/cfd_tunnel?name=${TUNNEL_NAME}&is_deleted=false")
      if [ -z "$(jq -r '.result[0].id // empty' <<<"$probe")" ]; then freed=1; break; fi
      cf DELETE "/accounts/${ACCOUNT_ID}/cfd_tunnel/${OLD_ID}" >/dev/null 2>&1 || true
      sleep 2
    done
    [ "$freed" = "1" ] || die "Tunnel '${TUNNEL_NAME}' would not release its name. Delete it in the Zero Trust dashboard (Networks -> Tunnels) and re-run."
    bold "  ✓ removed the stale tunnel"
    TUNNEL_ID=""
  fi
fi

if [ -z "${TUNNEL_ID:-}" ]; then
  SECRET="$(head -c 32 /dev/urandom | base64 -w0)"
  out=$(cf POST "/accounts/${ACCOUNT_ID}/cfd_tunnel" \
    "$(jq -n --arg n "$TUNNEL_NAME" --arg s "$SECRET" \
       '{name:$n, tunnel_secret:$s, config_src:"local"}')")
  cf_ok "$out" "Tunnel creation" || die "Could not create the tunnel."
  TUNNEL_ID="$(jq -r '.result.id' <<<"$out")"

  mkdir -p "$HOME/.cloudflared"
  # Exactly what `cloudflared tunnel login` would have written — building it
  # here is what lets this script skip the interactive browser step.
  ( umask 077; jq -n --arg a "$ACCOUNT_ID" --arg t "$TUNNEL_ID" --arg s "$SECRET" \
      '{AccountTag:$a, TunnelID:$t, TunnelSecret:$s}' \
      > "$HOME/.cloudflared/${TUNNEL_ID}.json" )
  unset SECRET
  bold "  ✓ created tunnel ${TUNNEL_ID}"
fi

cat > "$HOME/.cloudflared/config.yml" <<YAML
# Cloudflare Tunnel for ${FQDN}. Written by setup_hermes_shsin_blog.sh.
#
# cloudflared dials out to Cloudflare, so no router port is opened and the home
# IP never appears in DNS. The proxy it points at binds loopback only, which
# makes this the single way in.
#
# WebSockets need no flag: an http:// service forwards the Upgrade header
# transparently, which /api/ws depends on.
tunnel: ${TUNNEL_ID}
credentials-file: ${HOME}/.cloudflared/${TUNNEL_ID}.json

ingress:
  - hostname: ${FQDN}
    service: http://127.0.0.1:${PROXY_PORT}
    originRequest:
      connectTimeout: 30s
  - service: http_status:404
YAML
"$CLOUDFLARED" tunnel ingress validate >/dev/null || die "config.yml did not validate."
bold "  ✓ ${HOME}/.cloudflared/config.yml"

# --- 6. dns ------------------------------------------------------------------

step "DNS for ${FQDN}"

TARGET="${TUNNEL_ID}.cfargotunnel.com"
out=$(cf GET "/zones/${ZONE_ID}/dns_records?type=CNAME&name=${FQDN}")
REC_ID="$(jq -r '.result[0].id // empty' <<<"$out")"
# Proxied, unlike the apex: this hostname MUST go through Cloudflare's proxy so
# that Access has somewhere to intercept before traffic reaches the machine.
BODY="$(jq -n --arg n "$SUBDOMAIN" --arg c "$TARGET" \
  '{type:"CNAME", name:$n, content:$c, ttl:1, proxied:true, comment:"Hem via Cloudflare Tunnel"}')"

if [ -n "$REC_ID" ]; then
  out=$(cf PUT "/zones/${ZONE_ID}/dns_records/${REC_ID}" "$BODY")
  cf_ok "$out" "DNS update" || die "Could not update the DNS record."
  bold "  ✓ repointed at ${TARGET}"
else
  out=$(cf POST "/zones/${ZONE_ID}/dns_records" "$BODY")
  cf_ok "$out" "DNS creation" || die "Could not create the DNS record."
  bold "  ✓ created -> ${TARGET}"
fi

# --- 7. the access gate ------------------------------------------------------

step "Cloudflare Access"

out=$(cf GET "/accounts/${ACCOUNT_ID}/access/organizations")
TEAM_DOMAIN="$(jq -r '.result.auth_domain // empty' <<<"$out")"
[ -n "$TEAM_DOMAIN" ] || die "No Zero Trust organisation on this account. Create one at https://one.dash.cloudflare.com (choose a team name), then re-run."
bold "  ✓ team ${TEAM_DOMAIN}"

out=$(cf GET "/accounts/${ACCOUNT_ID}/access/identity_providers")
IDP_ID="$(jq -r '[.result[] | select(.type=="google")][0].id // empty' <<<"$out")"
if [ -z "$IDP_ID" ]; then
  cat <<HELP

  No Google identity provider configured, and this is the one step no API can
  do for you — Google does not expose an API for creating Web-application
  OAuth clients.

    1. https://console.cloud.google.com -> APIs & Services -> Credentials
       -> Create Credentials -> OAuth client ID -> Web application
    2. Authorized redirect URI, exactly:
         https://${TEAM_DOMAIN}/cdn-cgi/access/callback
    3. Zero Trust -> Settings -> Authentication -> Login methods
       -> Add new -> Google, and paste the client ID and secret.

  Then re-run this script.

HELP
  die "Google identity provider missing."
fi
bold "  ✓ Google identity provider ${IDP_ID}"

# Find-or-create the application. Adopting an existing one matters: its
# Audience tag is baked into .env.public, and recreating the app would mint a
# new tag and silently invalidate every live session.
out=$(cf GET "/accounts/${ACCOUNT_ID}/access/apps")
APP_ID="$(jq -r --arg d "$FQDN" '[.result[] | select(.domain==$d)][0].id // empty' <<<"$out")"

APP_BODY="$(jq -n --arg n "$APP_NAME" --arg d "$FQDN" --arg s "$SESSION_DURATION" --arg i "$IDP_ID" '{
  name:$n, domain:$d, type:"self_hosted", session_duration:$s,
  allowed_idps:[$i],
  auto_redirect_to_identity:true,
  app_launcher_visible:false,
  http_only_cookie_attribute:true,
  enable_binding_cookie:false
}')"

if [ -n "$APP_ID" ]; then
  out=$(cf PUT "/accounts/${ACCOUNT_ID}/access/apps/${APP_ID}" "$APP_BODY")
  cf_ok "$out" "Access app update" || die "Could not update the Access application."
  bold "  ✓ adopted existing application"
else
  out=$(cf POST "/accounts/${ACCOUNT_ID}/access/apps" "$APP_BODY")
  cf_ok "$out" "Access app creation" || die "Could not create the Access application."
  APP_ID="$(jq -r '.result.id' <<<"$out")"
  bold "  ✓ created application"
fi
APP_AUD="$(jq -r '.result.aud' <<<"$out")"
[ -n "$APP_AUD" ] || die "No audience tag returned."
bold "  ✓ audience ${APP_AUD:0:16}…"

# The policy. Google only — the one-time-PIN provider is deliberately excluded,
# because with it enabled anyone who can receive mail at an allowed address
# gets in without ever touching Google.
INCLUDE="$(jq -n --arg e "$ALLOWED_EMAILS" \
  '[$e | split(",") | .[] | {email:{email:(.|ltrimstr(" ")|rtrimstr(" "))}}]')"
POLICY_BODY="$(jq -n --argjson inc "$INCLUDE" '{name:"Only me", decision:"allow", include:$inc}')"

out=$(cf GET "/accounts/${ACCOUNT_ID}/access/apps/${APP_ID}/policies")
POL_ID="$(jq -r '.result[0].id // empty' <<<"$out")"
if [ -n "$POL_ID" ]; then
  out=$(cf PUT "/accounts/${ACCOUNT_ID}/access/apps/${APP_ID}/policies/${POL_ID}" "$POLICY_BODY")
else
  out=$(cf POST "/accounts/${ACCOUNT_ID}/access/apps/${APP_ID}/policies" "$POLICY_BODY")
fi
cf_ok "$out" "Policy" || die "Could not write the Access policy."
bold "  ✓ policy allows: $(jq -r '[.result.include[].email.email] | join(", ")' <<<"$out")"

# --- 8. configuration --------------------------------------------------------

step "Configuration"

if [ ! -f .env ]; then
  cp .env.example .env
  bold "  ✓ .env from .env.example"
else
  bold "  ✓ .env already present (left alone)"
fi

# Deliberately a separate file rather than edits into .env: the LAN config stays
# intact, so switching deployments is a flag at launch, not a diff to reverse.
( umask 077; cat > .env.public <<EOF
# --- The public deployment: Cloudflare Tunnel + Cloudflare Access -------------
#
# Written by setup_hermes_shsin_blog.sh. Layered on top of .env:
#     ENV_FILE=.env.public bash start.sh
#
# Setting the three ACCESS_* values makes the proxy verify Access's signed
# assertion itself, on every request and every WebSocket upgrade — which is what
# makes a dead tunnel or a stray LAN client fail closed rather than silently
# handing over the agent.

# Loopback only. cloudflared reaches the proxy over loopback, so closing the LAN
# port removes the one way in that Access cannot see. This is the line that
# makes the gate meaningful rather than decorative.
PROXY_HOST=127.0.0.1

PUBLIC_URL=https://${FQDN}

ACCESS_TEAM_DOMAIN=${TEAM_DOMAIN}
ACCESS_AUD=${APP_AUD}
ACCESS_ALLOWED_EMAILS=${ALLOWED_EMAILS}
EOF
)
bold "  ✓ .env.public (0600)"

# --- 9. services -------------------------------------------------------------

step "systemd user services"

# User services, not system ones: no root anywhere in this script. Lingering is
# what makes them start at boot without logging in.
loginctl enable-linger "$USER" >/dev/null 2>&1 || \
  warn "  ! could not enable lingering — run: sudo loginctl enable-linger $USER"
bold "  ✓ linger: $(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo unknown)"

mkdir -p "$HOME/.config/systemd/user"

cat > "$HOME/.config/systemd/user/cloudflared.service" <<UNIT
[Unit]
Description=Cloudflare Tunnel for ${FQDN}
After=network-online.target
Wants=network-online.target
# Never stop retrying: this is the only route in, so a crash loop that gives up
# would take the app off the internet with nothing to notice it.
StartLimitIntervalSec=0

[Service]
Type=notify
ExecStart=${CLOUDFLARED} --no-autoupdate --config %h/.cloudflared/config.yml tunnel run
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
UNIT

NODE_BIN="$(dirname "$(command -v node)")"
PNPM_BIN="$(dirname "$(command -v pnpm)")"

cat > "$HOME/.config/systemd/user/hermes-webapp.service" <<UNIT
[Unit]
Description=Hem — proxy + Cloudflare Access gate
After=network-online.target
Wants=network-online.target
After=cloudflared.service
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
# systemd does not run a login shell, so nvm's PATH additions are absent and
# pnpm would not be found. Name the paths rather than sourcing a profile — a
# service that depends on shell rc files breaks the first time one changes.
Environment=PATH=${PNPM_BIN}:${NODE_BIN}:/usr/local/bin:/usr/bin:/bin
Environment=ENV_FILE=.env.public
# Boot stays fast; 'pnpm build' is a deliberate step after changing code.
Environment=SKIP_BUILD=1
# Foreground: start.sh health-checks the Hermes backend, starts it if needed,
# then execs the proxy — so this one unit covers both.
ExecStart=/bin/bash start.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now cloudflared >/dev/null 2>&1
systemctl --user enable --now hermes-webapp >/dev/null 2>&1
bold "  ✓ cloudflared + hermes-webapp enabled and started"

# --- 10. verification --------------------------------------------------------

step "Verifying"

fail=0
ok()  { bold "  ✓ $*"; }
bad() { warn "  x $*"; fail=$((fail+1)); }

for i in $(seq 1 40); do
  curl -fsS -m 2 "http://127.0.0.1:${PROXY_PORT}/healthz" >/dev/null 2>&1 && break
  sleep 2
done

code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${PROXY_PORT}/healthz" || echo 000)
[ "$code" = "200" ] && ok "proxy up (/healthz 200)" || bad "proxy not answering (/healthz ${code})"

# The point of the in-proxy gate: reaching the origin directly must NOT be
# enough. A 200 here would mean the tunnel is trusted blindly.
code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${PROXY_PORT}/api/sessions" || echo 000)
[ "$code" = "401" ] && ok "gate refuses unauthenticated origin requests (401)" \
                    || bad "expected 401 from /api/sessions, got ${code} — THE GATE IS NOT ENFORCING"

ss -ltn 2>/dev/null | grep -q "127.0.0.1:${PROXY_PORT}" \
  && ok "bound to loopback only" \
  || bad "proxy is not bound to loopback — the LAN port is open"

systemctl --user is-active --quiet cloudflared && ok "cloudflared running" || bad "cloudflared not running"
systemctl --user is-active --quiet hermes-webapp && ok "hermes-webapp running" || bad "hermes-webapp not running"

ip=$(dig +short "${FQDN}" @1.1.1.1 2>/dev/null | head -1)
if [ -n "$ip" ]; then
  ok "${FQDN} resolves (${ip})"
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 --resolve "${FQDN}:443:${ip}" "https://${FQDN}/" || echo 000)
  [ "$code" = "302" ] && ok "Access is gating the public URL (302 to sign-in)" \
                      || warn "  ! expected 302 from https://${FQDN}/, got ${code}"
else
  warn "  ! ${FQDN} does not resolve yet — DNS may still be propagating"
fi

# --- done --------------------------------------------------------------------

echo
if [ "$fail" -gt 0 ]; then
  warn "${fail} check(s) failed — see above."
  warn "Logs:  journalctl --user -u hermes-webapp -n 50"
  exit 1
fi

bold "Hem is up."
cat <<EOF

  Open:     https://${FQDN}
  Sign in:  Google — ${ALLOWED_EMAILS}

  The installed PWA is bound to the origin it was installed from, so if you
  previously installed it from a different address, uninstall it and add it
  again from the URL above.

  Status:   bash start.sh --status   (from ${REPO_DIR})
  Logs:     journalctl --user -u hermes-webapp -f
  Restart:  systemctl --user restart hermes-webapp

  After changing code:  pnpm build && systemctl --user restart hermes-webapp
  (the service runs with SKIP_BUILD=1, so it will not rebuild for you)

EOF
