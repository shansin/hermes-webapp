# Hermes Control

A phone-first web app (and dormant PWA) for driving the [Hermes Agent](https://github.com/NousResearch/hermes-agent)
running on your own machine, from your phone on the same LAN.

Chat with live token streaming, browse and resume sessions, run the kanban
board, edit memory, toggle skills, manage cron jobs, and watch usage — all from
a thumb.

```
Phone (LAN) ──http──> Node proxy :3000            Hermes backend :9119
                       ├─ serves the built React app   ├─ REST /api/*
                       ├─ /api/*   HTTP proxy ────────>├─ JSON-RPC WS /api/ws
                       └─ /api/ws  WS proxy ──────────>└─ kanban plugin API
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
Hermes Control
  On this machine: http://localhost:3000
  On your phone:   http://192.168.1.42:3000
```

Add it to your home screen for an app-like launch.

Re-running it is safe. Each step checks before it acts, and the proxy step
takes the port back from an already-running instance — which is what you want,
since the run just rebuilt the bundle that instance was serving.

```bash
bash start.sh --bg        # detach; logs to .logs/hermes-control.log
bash start.sh --status    # report what's up, change nothing
```

### The session token

Hermes protects its API with a per-process session token. There are two paths:

- **We start Hermes** (the usual case): `start.sh` generates a token, exports it
  as `HERMES_DASHBOARD_SESSION_TOKEN`, and the backend adopts it.
- **Hermes is already running**: if it's `hermes dashboard`, the proxy scrapes
  the token out of the SPA HTML it serves on loopback. If it's a headless
  `hermes serve` you started yourself, set `HERMES_TOKEN` in `.env` to the value
  you launched it with — a headless server has no HTML to scrape.

`GET /healthz` reports which state you're in.

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
a blocking approval sheet for risky tools; interrupt button; model / reasoning /
approval-mode pickers; a context-fill ring that opens a token breakdown and can
compact the conversation; voice input and per-reply playback; file attachments.

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

**Memory, Skills, Cron, Models, Profiles, Settings** — six destinations in the
navigation drawer, under a SYSTEM divider below the working surfaces. Editable
memory files; skill toggles plus hub search/install; cron job control with run
history; an active-model card with usage charts; and settings (the default model
for new chats, three themes, haptics, a QR code to open the app on another
phone, and a hidden raw-frame dev panel behind a triple-tap on the "Appearance"
heading).

These were one "Hub" screen behind a segmented control, which cost two taps to
reach any of them. `/hub?tab=<id>` still redirects to the matching page, since
those URLs live on in bookmarks and home-screen installs.

## The PWA: install it over Tailscale

The manifest, icons, share target, shortcuts, and a Workbox service worker with
offline session-history caching are all built and shipped — but browsers only
enable service workers, installability, push, and the **microphone** in a
**secure context**. Over plain HTTP on a LAN IP none of it activates, and the
app degrades to a browser bookmark with in-app toasts instead of push.

Tailscale is the way to switch all of it on, with no code change and no
certificate to install on the phone: `tailscale serve` terminates TLS under this
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

The first and last are the reasons to bother: send a prompt, put the phone
away, and the answer arrives as a banner — and an approval blocks the turn
until it is answered, which is not something to discover an hour later.

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

## Security

There is no user authentication — this is designed for a trusted home LAN, and
anyone who can reach `:3000` gets full control of your agent. Don't port-forward
it. If you want access from outside, use Tailscale rather than opening a port.

## Layout

```
server/src/
  index.ts             app wiring, HTTPS when configured, graceful shutdown
  config.ts            zod-validated env + token discovery
  routers/apiProxy.ts  /api/* → loopback, Host + Bearer rewrite, streamed bodies
  routers/wsProxy.ts   WS upgrade forwarding with the Origin rewrite
  routers/push.ts      /push/* — subscribe, unsubscribe, send a test
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
  components/          chat, composer, sessions, kanban, hub, shared
web/public/
  push-sw.js           push + notificationclick, imported by the Workbox worker
```

### A note on the protocol

The gateway's JSON-RPC payloads aren't documented anywhere, so the shapes in
`web/src/ws/types.ts` were captured from live frames and are validated with
permissive zod schemas — an added field won't break the app, and an unknown
event type is ignored rather than thrown. The dev panel shows raw frames when
something looks wrong.

Two things worth knowing if you extend it:

- `reasoning.delta` carries the model's actual chain of thought.
  `thinking.delta` is only a decorative "pondering…" placeholder and should
  never be appended to the transcript.
- The gateway session handle from `session.create` (8 hex chars) is **not** the
  stored session id used by the REST endpoints; both are tracked separately.
