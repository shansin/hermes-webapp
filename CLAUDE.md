# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A phone-first web app + LAN-facing Node proxy for driving a [Hermes Agent](https://github.com/NousResearch/hermes-agent) backend running on the same machine. pnpm workspace, two packages: `server` (Hono proxy, Node) and `web` (React 19 + Vite PWA).

There is **no agent logic here**. Hermes owns all of it, including the kanban board. This repo is transport, presentation, and the two pieces of state the proxy owns (push subscriptions, the cron feed).

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

The seven system screens (Memory, Skills, Cron, Models, Usage, Profiles, Settings) are separate routes; `/hub?tab=<id>` redirects for old bookmarks.

The **share target** is Android-only (iOS has no Web Share Target) and needs the worker: a file-carrying target must be `POST`, which a SPA cannot receive, so `public/share-sw.js` intercepts the POST, files the parts in Cache Storage and 303s to `/chat?new=1&share=<id>`; the page claims that payload once via `lib/sharedIntake.ts` and the worker deletes it. `routers/share.ts` is the no-worker fallback and can only forward the text. Four files in three languages with no shared type between them — `test/deepLinks.test.ts` is what keeps the field names aligned.

The PWA layer (manifest, Workbox SW, `public/push-sw.js`, `public/share-sw.js`, offline session caching, push, share target, microphone) is fully built but **dormant on plain HTTP** — browsers gate all of it on a secure context. Tailscale is the recommended way to switch it on.

## Conventions

- **File-header doc comments carry the reasoning.** Nearly every source file opens with a block explaining *why* the code is shaped that way — a constraint from Hermes, a browser behaviour, a bug that came back. Match that when adding files, and read them before changing anything; they are where the non-obvious constraints live.
- **Commit messages state the user-visible effect**, imperative, sentence-cased, no prefix or scope: "Stop a notification tap landing in an empty session", "Keep one conversation's stream out of another".
- Tests target logic where being wrong is invisible until someone is affected. Whole-screen render tests are deliberately absent — see `TESTING.md`, which explains what each suite covers and why.
- The server's test projects run `isolate: true, pool: 'forks'` because its stores are module-level singletons keyed to a state directory.

## Security posture

No user authentication. Anyone who can reach `:3000` has full control of the agent. Designed for a trusted home LAN; remote access is Tailscale, never a forwarded port.
