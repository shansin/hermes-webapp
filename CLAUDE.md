# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Hem** — a phone-first web app + LAN-facing Node proxy for driving a [Hermes Agent](https://github.com/NousResearch/hermes-agent) backend running on the same machine. pnpm workspace, two packages: `server` (Hono proxy, Node) and `web` (React 19 + Vite PWA).

There is **no agent logic here**. Hermes owns all of it, including the kanban board. This repo is transport, presentation, and the two pieces of state the proxy owns (push subscriptions, the updates feed).

## Commands

```bash
bash start.sh                # the real entry point: health-check/start Hermes, build web, run proxy
bash start.sh --bg           # detach, logs to .logs/hem.log
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

pnpm size                    # gzipped chunk report + budgets (needs a build)
pnpm analyze                 # rebuild with a treemap at web/dist/stats.html
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

**A custom provider's model list can be stale, silently.** `model.options` probes only the *current* custom endpoint on a normal open — Hermes' own policy, so one unreachable saved host cannot hang every model picker — and serves any other saved custom provider from the catalogue cached in `config.yaml`. That cache goes stale the moment a model is pulled on that machine, and the failure looks like nothing: the provider is present, lists models, and just omits the new ones. `ModelPicker` therefore carries a Refresh button that re-calls with `refresh: true` (60s timeout, since it dials every saved endpoint in turn) and writes the result into the shared `['model-options']` cache entry so all four pickers see it. A failed refresh leaves the existing list alone — a stale list still works, an empty one cannot pick anything.

Models carries two model settings, and they are not the same thing. **Default model** (`scope: "main"`) is what new chats start with. **Auxiliary model** (`scope: "auxiliary"`, no `task`) is the eleven side jobs Hermes runs behind every turn — titles, vision, approval checks, compression, memory query rewriting — which sit at `provider: "auto"` by default and therefore bill to whatever the main model is. `/api/model/set` also accepts a single `task`, deliberately not exposed: eleven pickers is a config screen, not a setting. `provider: "auto"` with an empty `model` is the factory state and the only way back, so the sheet offers it explicitly — otherwise choosing once is a one-way door.

The seven system screens (Memory, Skills, Cron, Models, Usage, Profiles, Settings) are separate routes; `/hub?tab=<id>` redirects for old bookmarks.

**The Activity pane spans profiles, and had to be made to.** Its three sources are not alike: the kanban board is one shared store and the cron list endpoint defaults to `profile=all`, but sessions are per-profile — so the pane used to show a card assigned to `research` while hiding the conversation it was running in. `useActiveSessionsAcrossProfiles` fans out one query per profile (own key, own refetch interval, so an idle profile settles to the slow poll) and merges. Unlike the Sessions screen this takes no picker: it is a short unpaginated list of live work and the point is seeing everything at once. `ActivityItem.owner` carries the profile (or the kanban assignee) and is rendered only when more than one profile exists; a session row's `url` carries `&profile=`, without which tapping another agent's row opens an empty chat. The fan-out is capped at `ACTIVITY_PROFILE_CAP` and the screen says so rather than quietly covering less.

**An image in a transcript is a path on the agent's machine, never a URL.** Both
directions of it, and neither can be handed to an `<img>`: a received
screenshot arrives as `![shot](file:///home/…/x.png)`, which a page served over
http cannot read and which react-markdown's URL sanitizer blanks before the
renderer sees it — the failure is an absent picture and nothing else. A sent
one is persisted by Hermes as an `@image:<path>` directive line appended to
your own message (its desktop client's own form, quoted by
`format_reference_value`'s rules when the path holds a space or a bracket), so
left alone it renders as a stray line of file path. `lib/localImages.ts` turns
both into an absolute path and `chat/LocalImage.tsx` fetches it through
`/api/fs/read-data-url` — the same authenticated read the file viewer uses,
because the transcript's origin is the proxy and a second origin for raw files
would need the credential the phone deliberately never holds. The composer
carries the same `@image:` ref into the message's *display* text (never the
prompt — the gateway already holds the bytes) so the live bubble and the
reloaded one are one renderer rather than two.

**Enter is a newline in the composer; Ctrl/Cmd+Enter sends.** A message to an
agent is a paragraph more often than a line. On a phone the key is a return key
either way and the button is the only way to send, so this only changes a
hardware keyboard. Enter still accepts a highlighted slash completion, because
there the list is what is in front of you.

The streaming bubble parses markdown **once per block, not once per tick**.
`lib/streamingMarkdown.ts` splits the accumulated text at the last blank line
that is safely a block boundary — outside any fence, and not in front of a list,
blockquote or table continuation, because splitting there turns one ordered list
into two that both start at 1. The finished half goes to a separate memoized
`Markdown` whose string does not change between ticks, so React skips it. Being
too careful there costs performance; being too clever corrupts a message while
it is streaming, which is the state hardest to reproduce. Its refusals are
tested.

**Sessions belong to a profile too, and nothing merges them.** Every `/api/sessions*` route takes `?profile=`, built by `sessionUrl` in `api/sessions.ts`; omitting it addresses the active profile. Unlike cron there is no `profile=all` — the backend rejects it — so the Sessions screen picks a profile rather than merging N paginated stores whose offsets do not align. The detail and messages routes **404 for a session in another profile**, which reads as "deleted", so the profile has to travel with the id everywhere a session is opened, deleted or flagged; `session.resume` takes one as well, which is what `/chat?resume=<id>&profile=<name>` is for. Kanban tasks are joined to their session by title correlation (`source: kanban` plus the task id), because Hermes leaves `session_id` null on the task row — so no match means "cannot tell", never "did not run".

The screen pages with `useSessionPages`, at the endpoint's own 100-row cap, so
first paint costs what one page always cost and older sessions are reachable
rather than merely counted in the header. The consequence to know about is in
the cache: there are now **two shapes** under the `['sessions']` prefix — the
plain lists and the paged `{ pages: [...] }` — and the undo toasts hide a row by
editing that cache before the delete is sent. `hideSessions` / `restoreSessions`
in `api/sessions.ts` handle both; a setter that knows only one fails silently,
leaving the row on screen while the delete goes through anyway.

**Every profile picker is the same two components.** `shared/SelectSheet.tsx` is single-select — a `SelectChip` trigger that names what is chosen and a bottom sheet of rows, the counterpart to `MultiSelectSheet` and stacking under it the same way (`useHistoryDismiss` nests, so back closes the picker and leaves a half-filled form alone). `shared/ProfileSelect.tsx` wraps it in the two shapes the app actually uses: `ProfileFilter` scopes a screen (Sessions, Skills — value `string | null`, null meaning the active profile, rendering nothing on a single-profile install) and `ProfileField` fills in a form (the cron job's store, a task's assignee — a plain name, since that is what gets sent). These were a chip per profile everywhere, which is fine for two agents and a wrapped block of controls at five; Sessions stacked three such rails above the list. Do not reintroduce a rail: the count grows with the number of profiles configured.

**Cron jobs belong to a profile, and the screen shows all of them.** A job is not tagged with a profile — it lives in that profile's own `cron/jobs.json` and runs against that profile's home (config, model, skills, memory). The selector is a `?profile=` query parameter, built by `cronUrl` in `api/hub.ts`. Two defaults differ and both bite: the *list* endpoint defaults to `profile=all`, so `/cron` is already a merged view the moment a second profile exists (hence the profile badge per row — it is not decoration); *create* and the per-job actions default to whichever profile is active. Always pass the profile on a per-job action: without it Hermes resolves the job by scanning every store and matching on id **or name**, so two profiles each holding a `morning-brief` act on whichever is found first. **A `no_agent` job is a script, and two things follow that are not visible from the screen.** Its run history is not a run log: `/api/cron/jobs/<id>/runs` lists *sessions* named `cron_<job_id>_<timestamp>`, so a job's history is the conversations it opened — and a script job never opens one. The endpoint therefore returns zero runs for a job that has fired every weekday for a month, which the sheet reported as "No runs recorded yet", i.e. exactly the opposite of the truth. What those runs leave behind is a file per run under `<hermes_home>/cron/output/<job_id>/` (including for a silent run, which records `Status: silent (empty output)` — usually the answer to "why have I not heard from this job"), so `components/hub/ScriptRuns.tsx` reads that directory over `/api/fs`. Second, the edit sheet's other fields are inert for it: the prompt is not read and model, skills and toolsets configure an agent that never runs, so the sheet names the script instead of rendering four empty controls.

Editing a job is `PUT /api/cron/jobs/<id>` carrying `{ updates }`, which Hermes **merges** over the stored record — so `lib/cronForm.ts` sends only the fields that changed. The sheet shows seven of the thirty a job holds, and a CLI- or blueprint-made job carries `script`, `deliver`, `context_from` and `no_agent` among the rest; posting a whole form back erases them where nothing on screen would show it. Two edits the backend refuses are refused in the sheet instead: a job cannot change profile (the profile *is* the store it lives in, so moving it means a new id and a lost run history), and a terminal job cannot be rescheduled. Note the reversal of the create rule — on create an absent key means "inherit", on update an absent key means "unchanged", and only an empty value (`model: ""`, `enabled_toolsets: []`) clears an existing pin. Jobs may also pin `skills` / `enabled_toolsets` — a narrowing of the profile's own set, where absent means inherit, so an empty list is never sent.

**A profile's `skill_count` is installed, not enabled.** It counts `SKILL.md` files on disk, and disabling a skill leaves the file there — so a profile deliberately narrowed to seven still reports eighty-six. The Profiles list shows the enabled count instead, fanned out one request per profile by `useProfileSkillCounts`, sharing its query keys with `useSkills(profile)` so the editor sheet reads a warm cache. A row whose request is still in flight shows nothing rather than `0`: "no skills enabled" is a real and alarming state that a loading row must not claim.

**The Skills screen picks a profile too, and a skill's category is its directory.** Skills are per-profile in both directions — the `SKILL.md` files live in that profile's `skills/` tree and the enabled set is `skills.disabled` in its config — so an omitted `?profile=` silently means "the active one" on the read *and* on every write. The screen carries the same picker as Sessions — `ProfileFilter`, the shared dropdown (null is the active profile, hidden entirely on a single-profile install), and `flip` and the hub install both pass it; a picker that only scoped the list would show one profile while the switches edited another. Two server-side details are worth knowing before touching this: Hermes derives `category` from the **parent directory** (`skills/<category>/<skill>/SKILL.md`) and ignores any `metadata.category` in the frontmatter, so an agent-authored skill written to the top level comes back with `category: null` — which used to throw while rendering the group heading and, with no error boundary anywhere in `App.tsx`, took every screen down with it. And hub install addresses a skill by `identifier` (`skills-sh/anthropics/skills/pdf`), never by `name`: one search for `pdf` returns the same name from three repos.

**Navigation has one rule and one breakpoint.** Back is `BackButton`/`useAppBack` everywhere: go back if `history.state.idx > 0`, otherwise go up to `/chat`. Do not reintroduce a `location.key === 'default'` check — a redirect replaces the entry, minting a fresh key without deepening the stack, so that test claims history a `standalone` install does not have and back leaves the app. Files overrides the action to walk up a directory while it has a parent, which is why the override exists at all.

Past 1000px `NavDrawer` renders *docked*: a permanent rail, no backdrop, no scroll lock, no drag, and crucially **no `useHistoryDismiss` sentinel** — a permanently-open overlay registering as dismissable eats the back button on every screen for ever. The docked rail also pushes instead of replacing, because there is no sentinel to land on and replacing would mean the stack never grows. The breakpoint is written twice on purpose (`WIDE_QUERY` in `lib/useMediaQuery.ts`, the media query in `global.css`); `matchMedia` cannot read a custom property, and if they drift the rail appears without the space reserved for it.

**Updates** (`/notifications`, the screen formerly called Cron Notifications) is the one channel carrying everything Hermes reports, and three writers feed it. `push/cron.ts` writes scheduled runs; `push/updates.ts` writes the agent's own announcements (`notification.show`, `background.complete`, `subagent.complete`) and the backend going up and down. All of it goes through `push/feed.ts`, which is the proxy's own record and therefore the part that survives nobody being connected — a push you did not see is gone, a row is not. Its writes are debounced on the **leading** edge: the first append of a burst is on disk before the call returns, so "appended" and "recorded" stay the same statement, and only a burst — `cron.changed` arriving four times a run, a catch-up appending run by run — is collapsed. `flushFeed()` is wired into the signal handler, without which a proxy stopping inside the cooldown drops the row explaining why.

Four things there are easy to get wrong:

- **The route stays `/notifications` despite the rename.** Every push payload already sitting on a phone points at it, as does the stored `url` of every entry written before the rename. `/updates` is an alias.
- **`handleFrame`'s early-out gates the feed, not just push.** It skips `JSON.parse` on the firehose unless the line contains one of the types that matter, so a type handled in `updates.ts` but missing from `FEED_EVENT_TYPES` simply never reaches the feed on a machine with no push devices — invisibly. The list is exported from `updates.ts` for exactly that reason, and `updates.test.ts` checks the two against each other.
- **`cron.changed` only ever speaks for one profile, so the signal cannot be the only trigger.** It is not emitted by whatever ran the job: it is a one-second file watcher inside the gateway's socket server stat-ing `<active profile home>/cron/jobs.json`, and `_watcher_home()` is process-wide. A job in `profiles/<name>/cron/jobs.json` therefore runs on time, writes its output, and moves nothing anybody is watching — silent from here whatever the gateway topology is. `startCronSweep()` re-runs the pass every 3 minutes for that reason, which also picks up runs that finished while the proxy was down. Both profile-scoped reads inside the pass matter as much as the trigger: the runs endpoint needs `?profile=` or Hermes resolves the job by scanning every store and matching id **or name**, and `/api/sessions/<run>/messages` needs it or the 404 leaves the notification standing with "<job> finished" where the agent's reply should be. The profile comes off the merged job list, which is already `profile=all`.
- **The backend watch has to stay quiet.** A row per Hermes restart trains you to ignore the row that means it has been down all night, so an outage is only recorded after a grace window, recovery is silent unless an outage was announced, and `stopPushListener` resets the watch — otherwise a proxy shutting down announces that the backend is offline on its way out.

What stays out of the feed is deliberate: `message.complete` would make it a second copy of every transcript, and `approval.request` / `clarify.request` block the agent and already have always-mounted sheets. All three still push.

The **share target** is Android-only (iOS has no Web Share Target) and needs the worker: a file-carrying target must be `POST`, which a SPA cannot receive, so `public/share-sw.js` intercepts the POST, files the parts in Cache Storage and 303s to `/chat?new=1&share=<id>`; the page claims that payload once via `lib/sharedIntake.ts` and the worker deletes it. `routers/share.ts` is the no-worker fallback and can only forward the text. Four files in three languages with no shared type between them — `test/deepLinks.test.ts` is what keeps the field names aligned.

The PWA layer (manifest, Workbox SW, `public/push-sw.js`, `public/share-sw.js`, offline session caching, push, share target, microphone) is fully built but **dormant on plain HTTP** — browsers gate all of it on a secure context. Tailscale is the recommended way to switch it on.

## Conventions

- **File-header doc comments carry the reasoning.** Nearly every source file opens with a block explaining *why* the code is shaped that way — a constraint from Hermes, a browser behaviour, a bug that came back. Match that when adding files, and read them before changing anything; they are where the non-obvious constraints live.
- **Bundle size is measured, not argued.** `web/scripts/size.mjs` reports every
  chunk gzipped and, separately, the **eager** total — the entry plus everything
  the HTML tells the browser to `modulepreload`, which is what decides time to
  first paint and the number a refactor can inflate without any single chunk
  changing enough to notice. It carries budgets and exits non-zero, so this can
  regress loudly. The `manualChunks` note in `vite.config.ts` is why it exists:
  a size change made by reasoning that measurably did the opposite. `ANALYZE=1`
  adds a treemap saying which module is responsible.

- **Syntax highlighting is local, deliberately.** `components/chat/highlight.ts`
  replaces `rehype-highlight`, which imports lowlight's `common` set — 37
  grammars — at module scope, so its `languages` option can only add and no
  bundler can drop any. The local plugin registers the ten a transcript
  actually contains and cost 30% of the Markdown chunk. Auto-detection stays
  off there for the same reason it was off before.

- **Every build is stamped.** `vite.config.ts` bakes `__BUILD_ID__` (`YYYY-MM-DD HH:MMZ <short-sha>`, `+` when the tree was dirty) into the bundle and writes the same value to `dist/build.json`. `/healthz` reports that file as `webBuild` plus `serverStartedAt`; Settings → BUILD shows both. The point is the comparison: the bundle says what the browser is *running*, `build.json` says what the server is *serving*, and a mismatch is a service worker holding an old copy — otherwise invisible from either end, and previously diagnosed by grepping the built bundle by hand. The server re-reads the file per request because `SKIP_BUILD=1` in the unit means rebuilds happen without a restart.
- **`cf-ray` is the join key between logs.** The WS proxy records Cloudflare's request id on the bridged, closed and refused lines. Correlating a browser capture with the server log by timestamp does not work — the machines are tens of milliseconds apart, enough to make a socket look like it predates the bridge carrying it.
- **The app is Hem; the backend is Hermes.** Two products share this repo's vocabulary and the split is not cosmetic. "Hem" is this app — the PWA title and manifest, the drawer, the push titles on a lock screen, the composer placeholder, the proxy's own boot log — and anything the user thinks of as the thing they are talking to. "Hermes" stays wherever the string names the [Hermes Agent](https://github.com/NousResearch/hermes-agent) backend they installed separately: `HERMES_TOKEN`, `~/.hermes`, `hermes serve`, the kanban plugin, its `config.yaml`, the Settings row under BACKEND, and the backend up/down rows in the feed. Renaming those would send someone looking for a service that does not exist under that name — an outage row saying "Hem backend offline" names nothing they can restart. The deployment keeps the old identity too, deliberately: the repo directory, `hermes-webapp.service`, the `hermes.shsin.blog` hostname, and the proxy's state files `.hermes-push.json` / `.hermes-cron-feed.json` — renaming the last two would orphan every push subscription and the entire updates feed.

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
