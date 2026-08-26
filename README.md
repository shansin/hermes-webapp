# Hem

A phone-first web app (and dormant PWA) for driving the [Hermes Agent](https://github.com/NousResearch/hermes-agent)
running on your own machine — from your phone on the same LAN, over Tailscale,
or from anywhere behind a Google sign-in.

Chat with live token streaming, browse and resume sessions, run the kanban
board, edit memory, toggle skills, manage cron jobs, and watch usage — all from
a thumb.

```
Phone (LAN) ──http──> Node proxy :3000            Hermes backend :9119
                       ├─ serves the built React app   ├─ REST /api/*
                       ├─ /api/*   HTTP proxy ────────>├─ JSON-RPC WS /api/ws
                       └─ /api/ws  WS proxy ──────────>└─ kanban plugin API
```

Published, the same proxy sits behind Cloudflare, which does the sign-in before
anything reaches your machine:

```
Phone (anywhere) ──https──> Cloudflare Access ──tunnel──> proxy :3000 (loopback)
                              └─ Google sign-in, one allowed account
```

## Why the proxy exists

Hermes deliberately refuses to be exposed on a LAN: binding it to a non-loopback
address forces OAuth, and it validates the `Host` header (and the `Origin` on
WebSocket upgrades) against the interface it bound. Pointing a phone at it
directly fails the guard with close code 4403.

So Hermes stays on `127.0.0.1:9119`, and this proxy — which *is* LAN-facing —
forwards to it server-side, rewriting `Host`/`Origin` to the loopback address
and injecting the `Authorization: Bearer` token. Your phone never holds a
credential.

## Quick start

```bash
corepack enable pnpm     # once, if you don't have pnpm
cp .env.example .env     # optional — the defaults work
bash start.sh
```

`start.sh` health-checks the Hermes backend and starts it if needed, rebuilds
the web app, then runs the proxy. It prints the LAN URL to open on your phone
(`SKIP_BUILD=1` reuses the existing `web/dist` when the tree hasn't changed):

```
Hem
  On this machine: http://localhost:3000
  On your phone:   http://192.168.1.42:3000
```

Add it to your home screen for an app-like launch.

Re-running it is safe. Each step checks before it acts, and the proxy step
takes the port back from an already-running instance — which is what you want,
since the run just rebuilt the bundle that instance was serving.

```bash
bash start.sh --bg        # detach; logs to .logs/hem.log
bash start.sh --status    # report what's up, change nothing
```

### Two config files, one per deployment

`.env` is the base. A deployment layers on top of it through `ENV_FILE`, rather
than being edited into `.env` and edited back out again:

```bash
bash start.sh                        # .env alone — LAN, and Tailscale if it's up
ENV_FILE=.env.public bash start.sh   # .env + .env.public — Cloudflare, gated
```

Later file wins, and both are read before the proxy starts, so switching
between LAN and public is a choice at launch instead of a diff to remember.
`.env.public` is what [Going public](#going-public-a-real-domain-behind-google-sign-in)
below fills in; `.env*` is gitignored.

Everything is optional and documented in `.env.example`.

### The session token

Hermes protects its API with a per-process session token. There are two paths:

- **We start Hermes** (the usual case): `start.sh` generates a token, exports it
  as `HERMES_DASHBOARD_SESSION_TOKEN`, and the backend adopts it.
- **Hermes is already running**: if it's `hermes dashboard`, the proxy scrapes
  the token out of the SPA HTML it serves on loopback. If it's a headless
  `hermes serve` you started yourself, set `HERMES_TOKEN` in `.env` to the value
  you launched it with — a headless server has no HTML to scrape.

`GET /healthz` reports which state you're in.

### After `hermes update`: "connected", but nothing works

An in-place Hermes update restarts the backend out from under you, and the
replacement mints a **new** session token. That token is `token_urlsafe(32)`
held in memory and never written to disk, and a headless `hermes serve` publishes
no HTML to scrape it from — so it is, in the strict sense, unknowable. The proxy
carries on presenting the old one, and every call comes back `401` while every
WebSocket upgrade comes back `403`.

The confusing part is that nothing looks down. `/healthz` probes Hermes'
`/api/health`, which needs no credential, so it keeps answering `backend: up`.
The app shows a connection banner because its socket is failing — the one
surface that *does* need the token.

`start.sh` handles this: it probes an authenticated endpoint as well as the
health one, and a backend that is up but refuses our token gets stopped and
restarted with the token exported, since that is the only way the two can agree
again. So the fix is to re-run it:

```bash
bash start.sh --bg       # reclaims the backend and reports what it did
bash start.sh --status   # says "up but rejecting our token" rather than a tick
```

Only the listener on `HERMES_PORT` is touched. `hermes-gateway.service` — the
messaging gateway, which holds no port — is left alone.

## Development

Three terminals:

```bash
hermes serve --port 9119 --host 127.0.0.1        # T1: the agent backend
pnpm dev:server                                  # T2: proxy on :3000, watch mode
pnpm dev:web                                     # T3: Vite on :5173, LAN-exposed
```

The Vite dev server proxies `/api` (including WebSocket upgrades) to the proxy
on `:3000`, so hit `http://<LAN-IP>:5173` from the phone for hot reload.

```bash
pnpm typecheck    # both packages
pnpm build        # production build into web/dist
```

## Features

**Chat** — streaming replies with markdown and syntax-highlighted, copyable code;
collapsible reasoning blocks; animated tool cards showing arguments and output;
a blocking approval sheet for risky tools; a clarify sheet for when the agent
asks you a question mid-turn, which stays in the transcript afterwards as a card
showing what was asked and what you picked; interrupt button; model / reasoning /
approval-mode pickers; a context-fill ring that opens a token breakdown and can
compact the conversation; voice input and per-reply playback; file attachments,
from the paperclip or from the Android share sheet.

**Slash commands** — typing `/` completes against the live registry (the gateway
ranks names *and* descriptions, and orders skills by how much you use them), and
the `/ Commands` chip opens the whole catalog grouped by category. Each command
runs on the surface that fits a phone: `/model` opens the model sheet, `/skills`
goes to the Skills page, `/compress` uses the dedicated RPC, skill commands expand into
a normal turn (the transcript keeps showing what you typed, not the expanded
prompt), and terminal-only commands like `/mouse` say so instead of failing.

**Sessions** — date-grouped history, full-text search, swipe right to resume and
left to delete, long-press to bulk-select, pull-to-refresh.

**Kanban** — the real Hermes board. One column at a time on a phone, chips to
switch, swipe a card right to advance a stage or left to delete, a detail sheet
with comments and run history, and a create sheet. Polls every 10s so cards the
agent moves show up on their own.

**Cron Notifications** — a read-only transcript of what your scheduled jobs
reported, in the working group of the drawer beside Files. See the section
below.

**Usage** — where the tokens went, over 24h / 7d / 30d / 90d. Tokens,
conversations and API calls up top, then a chart, then ranked breakdowns:
*Machinery* (what naming sessions, judging approvals and compacting transcripts
cost you — visible nowhere else), by model, by tool, by skill, and, for the day
view, by surface and the heaviest conversations.

Two things about it are deliberate. It leads with **tokens, not money**: a
locally served model has no rate card, so Hermes writes `estimated_cost_usd = 0`
on every session and a cost-led page would be a column of `$0.00`. The cost
tiles appear only when there is a price to show. And the **24h view is hourly**,
which the analytics endpoint cannot do — it groups by date — so those bars are
built here from session rows, bucketed by the hour each conversation started.
That leaves out sub-agent runs and compaction continuations, which the session
list hides; the screen reports the resulting gap rather than drawing a chart
that is quietly short.

**Memory, Skills, Cron, Models, Usage, Profiles, Settings** — seven destinations
in the navigation drawer, under a SYSTEM divider below the working surfaces.
Editable memory files; skill toggles plus hub search/install; cron job control
with run history; the default model for new chats; and settings (three themes,
haptics, a QR code to open the app on another phone, and a hidden raw-frame dev
panel behind a triple-tap on the "Appearance" heading).

These were one "Hub" screen behind a segmented control, which cost two taps to
reach any of them. `/hub?tab=<id>` still redirects to the matching page, since
those URLs live on in bookmarks and home-screen installs.

## The PWA: install it over Tailscale

The manifest, icons, share target, shortcuts, and a Workbox service worker with
offline session-history caching are all built and shipped — but browsers only
enable service workers, installability, push, and the **microphone** in a
**secure context**. Over plain HTTP on a LAN IP none of it activates, and the
app degrades to a browser bookmark with in-app toasts instead of push.

Tailscale is the simplest way to switch all of it on, with no code change and
no certificate to install on the phone (the other is
[going public](#going-public-a-real-domain-behind-google-sign-in), which gives
you HTTPS on your own domain instead of a `ts.net` name): `tailscale serve` terminates TLS under this
machine's MagicDNS name using a real Let's Encrypt cert, and forwards to the
proxy over loopback. It also makes the app reachable when you're away from the
house.

```bash
TAILSCALE=1 bash start.sh
```

That publishes the proxy, prints the `https://<host>.<tailnet>.ts.net` URL, and
tells the server to hand that address out in the QR code and install hint
instead of the LAN IP. Open it on the phone and use "Add to Home Screen" — it
launches standalone, caches session history for offline reading, and unlocks
voice input.

Offline, the session list comes from the service worker cache and opening a
conversation shows its stored transcript read-only, with a banner saying so —
the live transcript arrives over the WebSocket, which is exactly what is
missing, so the app reads the REST copy instead and goes live again on
reconnect.

Two one-time prerequisites, both of which `start.sh` will name if they're
missing:

```bash
sudo tailscale set --operator=$USER    # manage serve config without root
```

…and **HTTPS Certificates** enabled for the tailnet, in the admin console under
[DNS](https://login.tailscale.com/admin/dns).

To take it down again: `tailscale serve reset`.

For LAN-only HTTPS without Tailscale, mkcert works too — the proxy terminates
TLS itself when you point it at a keypair:

```bash
mkcert -install
mkcert -cert-file certs/lan.pem -key-file certs/lan-key.pem <LAN-IP> localhost
# then set HTTPS_CERT and HTTPS_KEY in .env
```

The phone must trust the mkcert root for that to count as a secure context,
which is the reason Tailscale is the recommended path.

### Share to Hermes

Once the app is installed, it appears in the Android share sheet. Share a
photo, a screenshot, a link or a selection to **Hermes**, and it opens on a new
chat with the file already attached and the text in the composer — ready to
send, or to type a question above first.

Images go to the gateway as vision tiles, exactly as the paperclip's do;
anything else lands in the session workspace and comes back as an `@file:` ref
the agent's file tools can read.

Two things about it are worth knowing.

**It is Android only.** iOS does not implement Web Share Target at all — there
is no "share to a web app" on iPhone, installed or otherwise. The composer's
paperclip is the path there, and it already opens the photo library.

**It needs the service worker**, so the same HTTPS prerequisite as everything
else in this section applies. And the reason is structural rather than
incidental: a share target that carries files must be `method: "POST"`, and a
POST navigation is something a single-page app cannot receive — the browser
posts a multipart body and expects a document back, with no JavaScript of ours
running to intercept it. `web/public/share-sw.js` takes that POST inside the
worker, files the parts in Cache Storage, and answers with a 303 to
`/chat?new=1&share=<id>`; the page claims the payload from the worker, once,
and the worker deletes it as it hands it over.

If the worker isn't there to catch the POST — mid-update, most likely — the
proxy answers instead and forwards the *text* to the same screen. The files
cannot survive that path, since attaching one needs a gateway session, so the
app says the share didn't come through rather than opening a blank chat.

### Push notifications

Once the app is served over HTTPS and installed, turn on **Settings →
Notifications → Push**. Banners arrive with the app closed for:

| Event | Notification |
| --- | --- |
| `message.complete` | the first ~140 characters of the reply |
| `background.complete` | "Nightly index finished" |
| `subagent.complete` | "Researcher finished" |
| `notification.show` | whatever the agent asked to say |
| `cron.changed` | the job's name, plus the agent's own reply — see below |
| `approval.request` | "Approval needed: Bash — rm -rf …" |
| `clarify.request` | "Question from Hermes: Which data source?" |

The first and last two are the reasons to bother: send a prompt, put the phone
away, and the answer arrives as a banner — and an approval or a clarify blocks
the turn until it is answered, which is not something to discover an hour
later. (An hour is literal for a clarify: the gateway gives up at
`agent.clarify_timeout`, 3600s by default, and the agent proceeds without you.)

A reply that was interrupted, errored, or produced no prose stays silent
rather than announcing an answer that isn't there. Markdown is flattened for
the lock screen and code fences collapse to `[code]`.

### Cron Notifications

Scheduled runs land in a **Cron Notifications** feed, reachable from the drawer
or `/notifications`. It reads like a conversation and deliberately isn't one:
there is no composer, because there is no session behind it. Tapping an entry
opens the run's actual conversation.

The banner says what the job *did* — "Feed smoke test / OK" — rather than that
it ran, because the reply is the thing worth waking a phone for.

Getting there takes a fetch. The `cron.changed` event is empty on the wire:

    {"type":"cron.changed","session_id":"","payload":{}}

— no job, no status, no session, and four of them fire per run (create,
trigger, start, finish). So `push/cron.ts` treats it as a "go and look" signal:
it debounces the burst, then reconciles the gateway's run history against what
the feed already knows, keyed on run id. A cron run record doubles as a session
record, which is where the job name, the `end_reason` and — via
`/api/sessions/<runId>/messages` — the agent's reply come from.

Consequences worth knowing:

* Job edits (creating, pausing, deleting) fire the same empty event, but
  reconcile finds no new *finished run*, so they produce no banner.
* The first pass on a fresh install adopts existing history silently rather
  than announcing months of past runs.
* Clearing the feed does not re-announce anything: the seen-run ids outlive
  the entries in `.hermes-cron-feed.json` (last 300 kept).

Notifications are tagged per conversation, so a second event in the same
session replaces the first rather than stacking — one row per chat, however
chatty the turn was. Approvals are exempt: a pending one is never replaced.

There is nothing to configure. A VAPID keypair is generated on first boot and
stored in `.hermes-push.json` next to `.env`, along with the devices that have
subscribed; `.env.example` documents how to pin your own keypair instead, and
`PUSH_ENABLED=0` switches the whole thing off.

Two things behave differently than you might expect:

- **iOS only gives push to an installed app**, never to a Safari tab. Add to
  Home Screen and open it from there; Settings says so explicitly on iPhone
  rather than leaving you with a switch that does nothing.
- **The Notifications section hides itself** when the proxy has no push to
  offer — `PUSH_ENABLED=0`, or a proxy still running a build from before push
  existed. Neither is fixable from the phone, so there is nothing to show. If
  you expected the toggle and don't see it, restart the proxy on the host.
- **The proxy holds its own gateway socket** for this. Push has to deliver when
  no browser is connected, so it cannot ride on the per-client socket
  `wsProxy` opens — see `server/src/push/events.ts`.

With the app open and visible, the service worker suppresses its banner and
hands the text to the page instead, so an event never arrives twice.

## Going public: a real domain behind Google sign-in

Tailscale covers "reachable when I'm out"; this covers "on my own domain, from
any device, without installing anything". **Cloudflare Tunnel** carries traffic
to the box and **Cloudflare Access** does the Google sign-in at the edge, so an
unauthorised request is refused before it reaches your machine at all. Both are
free, and no router port is opened — `cloudflared` dials *out*, so your home IP
never appears in DNS.

The domain's nameservers have to point at Cloudflare (free; registration can
stay wherever it is). Then, roughly:

```bash
cloudflared tunnel login
cloudflared tunnel create hermes
cloudflared tunnel route dns hermes hermes.example.com
```

…with `~/.cloudflared/config.yml` pointing the hostname at `http://127.0.0.1:3000`,
and an Access **self-hosted application** on that hostname whose policy allows
exactly the Google addresses you name. WebSockets need no special configuration:
an `http://` service forwards the `Upgrade` header, which `/api/ws` depends on.

Copy the application's **Audience (AUD) tag** out of Access, and write
`.env.public`:

```bash
# .env.public
PROXY_HOST=127.0.0.1                       # cloudflared reaches it over loopback
PUBLIC_URL=https://hermes.example.com
ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com
ACCESS_AUD=<the 64-hex audience tag>
ACCESS_ALLOWED_EMAILS=you@gmail.com,backup@gmail.com
```

```bash
ENV_FILE=.env.public bash start.sh
```

`PROXY_HOST=127.0.0.1` is the line that makes the gate mean something: it closes
the LAN port, so the tunnel becomes the only way in. Your phone at home then
uses the public URL too — which is no loss, because it finally gets HTTPS
everywhere and the whole dormant PWA layer (install, offline, push, microphone)
wakes up on every device without Tailscale.

### The proxy checks the sign-in too

Setting those three `ACCESS_*` values also makes the proxy verify Access's
signed assertion itself, on every request **and** every WebSocket upgrade.

That is not redundant. Cloudflare's check is the one doing the work, but without
a second one, a tunnel pointed at the wrong port, a `cloudflared` that died, or
a stray client on the LAN each leaves the agent wide open — and every screen in
the app looks perfectly healthy while it happens. With it, all of those fail
closed. `bash start.sh --status` reports both the gate and the tunnel, so a dead
`cloudflared` is visible instead of showing a green `/healthz` behind an
unreachable URL.

Enforcement is off unless all three are set, so `.env` alone — dev, LAN,
Tailscale — behaves exactly as it always did.

Cloudflare closes an idle proxied WebSocket at 100 seconds, and the gateway
socket is idle between turns — so the proxy pings the browser every 45s to keep
it from looking idle. Without that the app works but spends its life flashing
"Reconnecting…". Nothing is logged when it happens, which is why it is pinned
down by a test.

Signing out is handled: when the Access session lapses the app says "Signed
out" and offers a button, rather than sitting on "Reconnecting…" forever. It has
to work that way because an expired session and a dead network are
indistinguishable in a browser — see `web/src/lib/accessSession.ts` for why the
detection looks the way it does.

### Rebuilding from scratch

`setup_hermes_shsin_blog.sh` stands the whole public deployment back up on a
fresh machine — dependencies, web build, `cloudflared`, the tunnel, the Access
application and its policy, `.env.public`, and both systemd services. It assumes
only that Hermes itself is installed, needs no root, and is safe to re-run.

```bash
bash setup_hermes_shsin_blog.sh
```

It asks for a Cloudflare API token once and caches it at `~/.cf-token`.

What it *adopts* rather than recreates, because those live in the Cloudflare
account and a format does not touch them: the zone and its DNS, the Zero Trust
organisation, the Google identity provider, and the Access application — the
last of these matters, since recreating the app would mint a new Audience tag
and silently invalidate every live session.

What it always rebuilds: the tunnel credentials. `tunnel_secret` is returned
once at creation and never again, so a machine that lost `~/.cloudflared` cannot
rejoin its old tunnel. The script notices, stops the connector, deletes the
stale tunnel, waits for the name to come free, creates a new one and repoints
the hostname at it. (Skipping the stop leaves the tunnel live-connected and the
name reserved, and the next step fails with a mystifying `1013`.)

The one thing no script can do is the Google OAuth client — Google exposes no
API for creating Web-application OAuth clients. If the identity provider is
missing, the script prints the exact steps and the redirect URI, then stops.

It finishes with seven checks, including the one that matters most: that
`/api/sessions` on the origin returns **401**. A 200 there would mean the proxy
is trusting the tunnel blindly.

### Surviving a reboot

`start.sh` alone does not: it detaches the proxy, which dies with the machine,
and the tunnel would come back up to find nothing behind it — a Cloudflare 502
that looks like Cloudflare's fault when nothing is listening. Two systemd
**user** services close that (no root; `loginctl enable-linger $USER` is what
makes user services start at boot without logging in):

```bash
systemctl --user enable --now cloudflared      # the tunnel
systemctl --user enable --now hermes-webapp    # start.sh, which also starts Hermes
```

`hermes-webapp.service` runs `start.sh` in the foreground with
`ENV_FILE=.env.public` and `SKIP_BUILD=1`, so it health-checks the Hermes
backend and starts it if needed, then execs the proxy. Skipping the build keeps
boot fast — run `pnpm build` yourself after changing code.

```bash
systemctl --user status hermes-webapp
journalctl --user -u hermes-webapp -f
```

To take it down: `systemctl --user disable --now hermes-webapp`, then drop
`ENV_FILE` and run `bash start.sh`. Nothing about the LAN setup was changed.

## Security

The proxy has no user accounts of its own: reaching `:3000` is full control of
your agent. What stands in front of that port is the entire security model, and
there are two supported answers.

**LAN / Tailscale (default).** Nothing authenticates callers, so this assumes a
trusted home network. Don't port-forward it; use Tailscale if you want in from
outside.

**Public (Cloudflare Tunnel + Access).** Cloudflare refuses anyone outside your
allowlist at the edge, the proxy binds loopback so the tunnel is the only route
in, and it re-verifies the signed assertion itself as described above.

Either way, credentials for the Hermes backend stay server-side — the phone
never holds one.

## Layout

```
server/src/
  index.ts             app wiring, HTTPS when configured, graceful shutdown
  config.ts            zod-validated env + token discovery
  auth.ts              the Cloudflare Access gate (off unless configured)
  routers/apiProxy.ts  /api/* → loopback, Host + Bearer rewrite, streamed bodies
  routers/wsProxy.ts   WS upgrade forwarding with the Origin rewrite
  routers/push.ts      /push/* — subscribe, unsubscribe, send a test
  routers/share.ts     POST /share, for when the worker didn't catch it
  push/events.ts       the proxy's own gateway socket: events → notifications
  push/send.ts         VAPID identity and the web-push fan-out
  push/store.ts        subscriptions + generated keypair, atomically on disk
  static.ts            web/dist with SPA fallback and traversal containment
web/src/
  ws/                  JSON-RPC client (id↔promise, framing, backoff) + zod types
  lib/slashCommands.ts the command table: which surface fulfils each command
  store/               streaming accumulator (session), preferences (ui)
  api/                 TanStack Query hooks per domain
  screens/             Chat, Sessions, Kanban, Files, and the Hub pages
  lib/push.ts          permission, subscription, and what to say when it fails
  lib/sharedIntake.ts  claiming a shared photo back off the service worker
  lib/accessSession.ts telling an expired sign-in apart from a dead network
  components/          chat, composer, sessions, kanban, hub, shared
    chat/ClarifySheet.tsx  the agent's own question, asked mid-turn
web/public/
  push-sw.js           push + notificationclick, imported by the Workbox worker
  share-sw.js          the share-target POST, filed for the page to claim
.env                   the base config (LAN / Tailscale)
.env.public            layered on top for the Cloudflare deployment, via ENV_FILE
```

### A note on the protocol

The gateway's JSON-RPC payloads aren't documented anywhere, so the shapes in
`web/src/ws/types.ts` were captured from live frames and are validated with
permissive zod schemas — an added field won't break the app, and an unknown
event type is ignored rather than thrown. The dev panel shows raw frames when
something looks wrong.

Two things worth knowing if you extend it:

- `clarify.request` parks the agent thread on an Event until `clarify.respond`
  carries an answer back with the same `request_id` — it is not an approval and
  has no safe default, so only an answer or `session.interrupt` releases it. A
  batch (`questions: [{qid, …}]`) needs one `clarify.respond` per `qid`; the
  gateway completes the request on the last one. Multi-select answers go out as
  a JSON array, since a choice is prose and may contain a comma.
- `reasoning.delta` carries the model's actual chain of thought.
  `thinking.delta` is only a decorative "pondering…" placeholder and should
  never be appended to the transcript.
- The gateway session handle from `session.create` (8 hex chars) is **not** the
  stored session id used by the REST endpoints; both are tracked separately.
