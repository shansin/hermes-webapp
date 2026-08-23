# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A phone-first web app + LAN-facing Node proxy for driving a [Hermes Agent](https://github.com/NousResearch/hermes-agent) backend running on the same machine. pnpm workspace, two packages: `server` (Hono proxy, Node) and `web` (React 19 + Vite PWA).

There is **no agent logic here**. Hermes owns all of it, including the kanban board. This repo is transport, presentation, and the two pieces of state the proxy owns (push subscriptions, the updates feed).

## Commands

```bash
bash start.sh                # the real entry point: health-check/start Hermes, build web, run proxy
bash start.sh --bg           # detach, logs to .logs/hermes-control.log
bash start.sh --status       # report, change nothing
SKIP_BUILD=1 bash start.sh   # reuse web/dist
TAILSCALE=1 bash start.sh    # publish over `tailscale serve` (HTTPS ⇒ PWA/push/mic activate)

pnpm dev:server              # proxy on :3000, tsx watch
pnpm dev:web                 # Vite on :5173, LAN-exposed, proxies /api (+ws) to :3000
pnpm typecheck               # both packages
pnpm build                   # web/dist

pnpm test                    # both vitest projects
npx vitest run --project server        # or --project web
npx vitest run web/test/usage.test.ts  # a single file
```

Requires a Hermes backend on `127.0.0.1:9119` (`hermes serve --port 9119 --host 127.0.0.1`).

## Architecture

### Why the proxy exists

Hermes refuses to be LAN-exposed: a non-loopback bind forces OAuth, and it validates `Host` (and `Origin` on WS upgrades) against the interface it bound. So Hermes stays on loopback and the proxy forwards server-side, rewriting `Host`/`Origin` to `127.0.0.1:9119` and injecting `Authorization: Bearer`. **The phone never holds a credential.** Any change to header handling in `routers/apiProxy.ts` or `routers/wsProxy.ts` risks breaking that disguise — the tests there exist because the failure is invisible from the app.

### The session token

Hermes mints a per-process `token_urlsafe(32)` held only in memory. Three states, all handled in `server/src/config.ts` (`resolveToken`, `getToken`, `clearToken`):

- `start.sh` starts Hermes → it exports `HERMES_DASHBOARD_SESSION_TOKEN` and the backend adopts it.
- A `hermes dashboard` we didn't start → the proxy scrapes the token out of the SPA HTML on loopback (lazy, hence the mutable module-level token).
- A headless `hermes serve` someone else started → unknowable; set `HERMES_TOKEN` in `.env`.

The trap: `/api/health` needs no credential, so a backend with a token we don't hold looks *up* while every real call 401s and every WS upgrade 403s. `/healthz` therefore reports `backend: up | down | unauthorized`, and `start.sh` probes an authenticated endpoint too.

### Data flow

```
phone → :3000 ─┬─ /api/*  → REST, streamed both ways
               ├─ /api/ws → JSON-RPC gateway socket
               ├─ /healthz /push/* /push/feed   (proxy's own)
               └─ /*      → web/dist (SPA fallback)
```

Two independent client paths in the web app, and they are not interchangeable:

- **REST** (`web/src/api/*.ts`, TanStack Query hooks per domain) over `api/client.ts`.
- **JSON-RPC over WS** (`web/src/ws/client.ts`) — one socket opened once in `App.tsx` for the app's lifetime. `client.ts` does only correlation, newline-delimited frame splitting (one WS message can carry many JSON lines), backoff, and event fan-out. Streaming state lives in `store/session.ts`, never in the client.

  Its one invariant: **a socket may only touch client state while it is still `this.ws`.** Every handler is guarded on that, because a superseded socket's `onclose` nulls the reference to its own replacement and schedules a reconnect — so the app sits on "Reconnecting…" holding nothing while the socket it just opened is perfectly fine, and the proxy's keepalive means that orphan never dies on its own. Each retry then opens the next orphan, so the state feeds itself until the app is reloaded. `readyState === CLOSING` is the usual way in (background the tab, lose the radio, come back), and it is why `connect()` treats CLOSING as unusable rather than falling through.

The proxy holds a **second, separate** gateway socket for push (`server/src/push/events.ts`), because push must fire when no browser is connected.

### Protocol gotchas

The gateway's JSON-RPC shapes are undocumented; `web/src/ws/types.ts` was captured from live frames and validated with permissive zod (unknown fields tolerated, unknown event types ignored). The hidden dev panel (triple-tap "Appearance" in Settings) shows raw frames.

- `clarify.request` is the agent asking *you* a question and blocking its turn on the answer — not an approval, no safe default, released only by `clarify.respond` with the same `request_id` or by `session.interrupt`. A batch needs one respond per `qid`. It reaches the shell via `ClarifySheet` (mounted in `App.tsx`, like `ApprovalSheet`, so it's answerable from any screen) and is cleared on `message.complete` so a server-side timeout can't strand a non-dismissible modal.
- `reasoning.delta` is the real chain of thought. `thinking.delta` is a decorative "pondering…" placeholder and must **never** be appended to the transcript.
- The gateway session handle from `session.create` (8 hex chars) is **not** the stored session id used by REST. Both are tracked separately.
- `cron.changed` arrives empty (no job, no status, no session) and fires ~4× per run. `push/cron.ts` treats it as a "go and look" signal: debounce, then reconcile run history against the feed keyed on run id.

### Web app structure

`store/session.ts` folds gateway events into a message list; deltas accumulate in `streamingText` rather than rewriting the array. `store/ui.ts` holds preferences (hand-rolled localStorage, synchronous hydration so the theme never paints wrong for a frame) plus connection state.

Routes are `React.lazy` in `App.tsx` — deliberately, so Rollup splits along dynamic-import boundaries. Do **not** reintroduce `manualChunks`: it produced separate files still statically reachable from the entry, so Vite preloaded everything before first paint. `ChatScreen` stays eager (landing route). Mermaid's ~40 chunks go to `assets/diagrams/` so the service worker can `globIgnores` them by directory.

Models carries two model settings, and they are not the same thing. **Default model** (`scope: "main"`) is what new chats start with. **Auxiliary model** (`scope: "auxiliary"`, no `task`) is the eleven side jobs Hermes runs behind every turn — titles, vision, approval checks, compression, memory query rewriting — which sit at `provider: "auto"` by default and therefore bill to whatever the main model is. `/api/model/set` also accepts a single `task`, deliberately not exposed: eleven pickers is a config screen, not a setting. `provider: "auto"` with an empty `model` is the factory state and the only way back, so the sheet offers it explicitly — otherwise choosing once is a one-way door.

The seven system screens (Memory, Skills, Cron, Models, Usage, Profiles, Settings) are separate routes; `/hub?tab=<id>` redirects for old bookmarks.

**Updates** (`/notifications`, the screen formerly called Cron Notifications) is the one channel carrying everything Hermes reports, and three writers feed it. `push/cron.ts` writes scheduled runs; `push/updates.ts` writes the agent's own announcements (`notification.show`, `background.complete`, `subagent.complete`) and the backend going up and down. All of it goes through `push/feed.ts`, which is the proxy's own record and therefore the part that survives nobody being connected — a push you did not see is gone, a row is not.

Three things there are easy to get wrong:

- **The route stays `/notifications` despite the rename.** Every push payload already sitting on a phone points at it, as does the stored `url` of every entry written before the rename. `/updates` is an alias.
- **`handleFrame`'s early-out gates the feed, not just push.** It skips `JSON.parse` on the firehose unless the line contains one of the types that matter, so a type handled in `updates.ts` but missing from `FEED_EVENT_TYPES` simply never reaches the feed on a machine with no push devices — invisibly. The list is exported from `updates.ts` for exactly that reason, and `updates.test.ts` checks the two against each other.
- **The backend watch has to stay quiet.** A row per Hermes restart trains you to ignore the row that means it has been down all night, so an outage is only recorded after a grace window, recovery is silent unless an outage was announced, and `stopPushListener` resets the watch — otherwise a proxy shutting down announces that the backend is offline on its way out.

What stays out of the feed is deliberate: `message.complete` would make it a second copy of every transcript, and `approval.request` / `clarify.request` block the agent and already have always-mounted sheets. All three still push.

The **share target** is Android-only (iOS has no Web Share Target) and needs the worker: a file-carrying target must be `POST`, which a SPA cannot receive, so `public/share-sw.js` intercepts the POST, files the parts in Cache Storage and 303s to `/chat?new=1&share=<id>`; the page claims that payload once via `lib/sharedIntake.ts` and the worker deletes it. `routers/share.ts` is the no-worker fallback and can only forward the text. Four files in three languages with no shared type between them — `test/deepLinks.test.ts` is what keeps the field names aligned.

The PWA layer (manifest, Workbox SW, `public/push-sw.js`, `public/share-sw.js`, offline session caching, push, share target, microphone) is fully built but **dormant on plain HTTP** — browsers gate all of it on a secure context. Tailscale is the recommended way to switch it on.

## Conventions

- **File-header doc comments carry the reasoning.** Nearly every source file opens with a block explaining *why* the code is shaped that way — a constraint from Hermes, a browser behaviour, a bug that came back. Match that when adding files, and read them before changing anything; they are where the non-obvious constraints live.
- **Every build is stamped.** `vite.config.ts` bakes `__BUILD_ID__` (`YYYY-MM-DD HH:MMZ <short-sha>`, `+` when the tree was dirty) into the bundle and writes the same value to `dist/build.json`. `/healthz` reports that file as `webBuild` plus `serverStartedAt`; Settings → BUILD shows both. The point is the comparison: the bundle says what the browser is *running*, `build.json` says what the server is *serving*, and a mismatch is a service worker holding an old copy — otherwise invisible from either end, and previously diagnosed by grepping the built bundle by hand. The server re-reads the file per request because `SKIP_BUILD=1` in the unit means rebuilds happen without a restart.
- **`cf-ray` is the join key between logs.** The WS proxy records Cloudflare's request id on the bridged, closed and refused lines. Correlating a browser capture with the server log by timestamp does not work — the machines are tens of milliseconds apart, enough to make a socket look like it predates the bridge carrying it.
- **Commit messages state the user-visible effect**, imperative, sentence-cased, no prefix or scope: "Stop a notification tap landing in an empty session", "Keep one conversation's stream out of another".
- Tests target logic where being wrong is invisible until someone is affected. Whole-screen render tests are deliberately absent — see `TESTING.md`, which explains what each suite covers and why.
- The server's test projects run `isolate: true, pool: 'forks'` because its stores are module-level singletons keyed to a state directory.

## Security posture

The proxy itself has no user accounts: reaching `:3000` is full control of the agent. Which door is in front of that port is the whole security model, and there are two supported ones.

**LAN / Tailscale (default).** Nothing authenticates callers. Trusted home LAN only; remote access is Tailscale, never a forwarded port.

**Public endpoint (Cloudflare Tunnel + Access).** `cloudflared` dials out from this machine, so no router port is opened and the home IP never appears in DNS. Cloudflare Access runs the Google sign-in at the edge and refuses anyone outside `ACCESS_ALLOWED_EMAILS` before a packet arrives. In this mode `PROXY_HOST=127.0.0.1`, so the tunnel is the only way in.

`server/src/auth.ts` then verifies Access's signed assertion *again*, here. That is not belt-and-braces: it is what makes the edge's absence non-fatal. A tunnel pointed at the wrong port, a `cloudflared` that died, a stray LAN client — without the second check each of those is a silently wide-open agent that looks healthy from every screen in the app, which is the same class of invisible failure the header-disguise tests exist for. Enforcement is on only when `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `ACCESS_ALLOWED_EMAILS` are all set, so the LAN and Tailscale paths are untouched.

Two things about it are easy to get wrong:

- **Upgrades never reach Hono.** `attachWsProxy` is bolted to the raw Node server, so `app.use('*', requireAccess)` does not cover it and the gateway socket needs its own check. Gating REST while leaving `/api/ws` open would gate nothing that matters.
- **A refused upgrade must answer before hanging up.** A bare `socket.destroy()` is a TCP reset, which reaches the browser as close code 1006 — indistinguishable from the network being down, so `ws/client.ts` retries it for ever instead of prompting for a login.

A third, which only bites once published: **Cloudflare closes an idle proxied
WebSocket at 100s.** The gateway socket is idle between turns, so `wsProxy.ts`
pings the browser every 45s — protocol-level, answered automatically, no script
involved. `push/events.ts` already did the same for the proxy's own upstream
socket, for the same reason. Without it the app reconnects endlessly and logs
nothing.

`/healthz` is the one exemption: `start.sh` polls it unauthenticated over loopback, and it is the first thing to check when the tunnel is the suspect.

### Losing the session

An expired Access session is invisible from inside the app, for two compounding reasons, and `web/src/lib/accessSession.ts` exists for both. The login page Access redirects to sends no CORS headers, so a cross-origin-redirected `fetch` rejects with a bare `TypeError` — identical to an offline phone, and `response.redirected` is never observed because there is no response. And Workbox's `navigateFallback` answers a plain reload out of the precache, so the redirect never even reaches the network.

So expiry is detected with a probe using `redirect: 'manual'` (which surfaces the bounce as an `opaqueredirect` without tripping CORS), and recovery is a top-level navigation carrying a `?cf_login=` marker — which is listed in `navigateFallbackDenylist` in `vite.config.ts` specifically so the service worker lets it through. That denylist entry is load-bearing; without it the whole mechanism is inert.

There is a **third state** the same probe distinguishes: this device cannot reach the origin at all. A failing client-side DNS resolver produces a rejected `fetch` and a WebSocket that dies in milliseconds — identical to a dead backend — and `navigator.onLine` stays `true` throughout, so it is no help. The discriminator is already in hand: a probe that *throws* never reached Cloudflare, while one that returns anything (a 401, a login redirect) completed the round trip. Two consecutive throws surface "This device can't reach <host>", unlatched unlike expiry. **What clears it is the gateway socket opening**, not just a probe: probes run from the reconnect path, which by definition stops the moment a socket comes back — relying on them alone left the banner up over a live, streaming session. The banner is additionally gated on `connection !== 'open'`, because an open socket and an unreachable host cannot honestly disagree and the socket is the one telling the truth. Without it the banner says "Reconnecting…" through a total client-network failure, which reads as "the agent is broken" when the agent is fine.
