# Feature-parity plan vs. `nesquena/hermes-webui`

Gap analysis of this app (phone-first React + Node proxy) against the feature list in
[hermes-webui's README](https://github.com/nesquena/hermes-webui/blob/master/README.md),
plus a phased plan for the gaps worth closing.

The two projects are unrelated codebases — hermes-webui is Python stdlib HTTP + vanilla
JS against a Hermes *dashboard* server; this is a Node proxy + React SPA against
`hermes serve`. Nothing is portable at the code level. What transfers is the **feature
list**, and only the parts that make sense on a phone.

Everything below was checked against the live backend's OpenAPI spec
(`curl http://127.0.0.1:9119/openapi.json` — 255 paths, Hermes 0.20.0), so each item
names the endpoint that will implement it. Where no endpoint exists, that's called out.

---

## 1. Already at parity

No work needed. Present in both:

| Upstream feature | Where it lives here |
| --- | --- |
| Token streaming | `web/src/ws/client.ts`, `store/session.ts` |
| Tool call cards | `components/chat/ToolCallCard.tsx` |
| Thinking / reasoning blocks | `components/chat/ThinkingBlock.tsx` |
| Approval card for risky tools | `components/chat/ApprovalSheet.tsx` |
| Cancel a running task | interrupt button in `components/composer/Composer.tsx` |
| Context usage indicator + compact | `components/composer/CostRing.tsx`, `ContextSheet.tsx` |
| Code copy button, syntax highlighting | `components/chat/Markdown.tsx` |
| Slash autocomplete + catalog | `lib/slashCommands.ts`, `composer/SlashPopover.tsx`, `CommandPalette.tsx` |
| Session search, date grouping, delete, bulk-select | `screens/SessionsScreen.tsx` |
| Cron jobs: view/create/run/history | `components/hub/CronTab.tsx` |
| Skills: list, toggle, hub search/install | `components/hub/SkillsTab.tsx` |
| Memory file editing | `components/hub/MemoryTab.tsx` |
| Token/cost usage display | `components/hub/ModelsTab.tsx`, `/usage` |
| Theme switching | `components/hub/SettingsTab.tsx`, `store/ui.ts` |
| Mobile layout, 44px targets | throughout — this app is phone-first by design |

This app also has features upstream doesn't: the kanban board, haptics, pull-to-refresh,
swipe gestures, the QR-code handoff, and the raw-frame dev panel.

---

## 2. Explicitly out of scope

Not gaps — decisions. Listing them so they don't get re-litigated later.

- **Password auth / passkeys / OIDC / signed cookies / login page.** The README's
  security section states the LAN-trust model deliberately. Adding auth to the proxy is a
  different project; Tailscale remains the answer for off-LAN access.
- **Docker, NixOS module, WSL autostart, `ctl.sh` daemon lifecycle.** `start.sh` covers
  the single-machine case this app targets.
- **11 named skins** (`ares`, `catppuccin`, `poseidon`, …). Three themes is the right
  number for a phone. `GET /api/dashboard/themes` exists if this ever changes.
- **Desktop-shaped panels**: drag-resizable right panel, breadcrumbs, hamburger overlay
  sidebar. This app uses a bottom tab bar and full-screen sheets instead — the phone
  equivalents already exist.
- **Multi-provider model dropdown.** Already covered by `ModelSheet.tsx` reading
  `model.options`; upstream frames it as a feature because it lacks one.
- **Public read-only share links.** Requires a public HTTP surface, which contradicts
  the no-auth LAN model.

---

## 3. Gaps, prioritized

### Phase 1 — Chat correctness and session management ✅ done

Highest value per unit of work. All backend support verified.

Implementation notes from building it:

- `GET /api/sessions` takes `archived` ∈ `exclude` | `only` | `include`, and
  `order` ∈ `created` | `recent` — there is **no** pinned-first ordering, so pinning is
  sorted client-side in `SessionsScreen`.
- The list endpoint returns `pinned`/`archived` as booleans but
  `GET /api/sessions/{id}` returns SQLite's `0`/`1`. `isOn()` in `api/sessions.ts`
  normalizes both; don't test these fields directly.
- Retry and edit both go through `command.dispatch name=undo`, **not** the `session.undo`
  RPC. The two differ: `session.undo` only truncates in-memory history and returns a
  count, while the dispatch path soft-deletes the rows, reloads the transcript, notifies
  memory providers of the rewind, and returns `{type:"prefill", message}` — the user text
  needed to resubmit. Verified live against the gateway.
- `session.history` projects role/text only, with no timestamps, so replayed messages
  carry `at: null` and render without a clock rather than showing the load time.
- The backend refuses undo mid-turn (code 4009), so retry/edit are disabled while running.

What shipped:

- **1.1 Pin & archive** — `⋯` action sheet per row; pinned float to a "Pinned" group;
  header chip swaps the list between active and archived.
- **1.2 Retry** — on the newest reply only.
- **1.3 Edit & resend** — tap a user bubble, edit, resubmit; the sheet states that the
  rewind drops everything after it.
- **1.4 Queued send** — send stays available mid-turn and holds the message; an
  interrupted turn keeps it queued rather than firing at an agent the user just stopped.
- **1.5 Timestamps** — on live messages; absent on replayed ones (see note above).
- **1.6 Export** — Markdown and JSON, via the native share sheet with a download fallback.

### Phase 2 — Voice ✅ already implemented (this section was wrong)

**Correction to the original plan.** I wrote this section believing server-side voice was
missing. It isn't — `web/src/lib/audio.ts` already does all of it, and has since before
this plan was written:

- `startRecording()` records with `MediaRecorder` and POSTs the blob to
  `/api/audio/transcribe`.
- `speak()` already prefers `/api/audio/speak`, falling back to `speechSynthesis` only
  when Hermes doesn't answer.
- `probeAudio()` already gates on `isSecureContext` via `canRecord()`, and `Composer`
  already prefers server STT over Web Speech when both are available.

Both endpoints are live and configured on this install (verified: `/api/audio/transcribe`
rejects an empty payload with 400 rather than 404, and `/api/audio/speak` returns real
MP3 audio).

The mic is hidden over plain HTTP because `MediaRecorder` and `getUserMedia` are
genuinely withheld outside a secure context — a browser constraint, not a code gap. It
appears automatically under the README's Tailscale or mkcert setup, with no code change.

Only minor polish remains, and none of it is worth doing while the default deployment
can't record at all: live interim transcription in the textarea, and auto-stop after
~2s of silence.

### Phase 3 — Workspace file browser ✅ done

Built as a fifth top-level tab (`web/src/screens/FilesScreen.tsx`), with
`components/files/FileViewer.tsx` for preview and editing.

Implementation notes:

- **`read-text` truncates at 512KB and still returns a `text` field.** A 3MB file comes
  back as a 512KB prefix with `truncated: true`. Editing is refused whenever that flag is
  set — saving the prefix back would have silently destroyed the rest of the file. This is
  the one genuinely dangerous edge in this phase.
- The server classifies files itself (`binary`, `mimeType`, `language`), so nothing guesses
  from the extension.
- `DELETE /api/files` takes its path in a **JSON body**, not the query string — a bodyless
  request 422s. `api.delBody` was added for it.
- `GET /api/git/status` returns JSON `null` (with a 200) for a path outside a repo.
- Downloads go through the authenticated client rather than a plain `<a download>`: the
  proxy injects the credential in the default setup, but a user-supplied token lives in a
  header the browser would never attach to a link navigation.

Backend support used:

| Need | Endpoint |
| --- | --- |
| Directory listing | `GET /api/fs/list` |
| Text preview | `GET /api/fs/read-text` (already used by the memory tab) |
| Image preview | `GET /api/fs/read-data-url` |
| Edit / save | `POST /api/fs/write-text` (already used) |
| Create folder | `POST /api/files/mkdir` |
| Delete | `DELETE /api/files` |
| Download binary | `GET /api/files/download` |
| Upload | `POST /api/files/upload` |
| Git branch + dirty count | `GET /api/git/status`, `GET /api/fs/git-root` |
| Default directory | `GET /api/fs/default-cwd` |

Shipped as a single-column drill-down rather than a tree — trees don't work under a
thumb. Git branch and dirty count show as a header chip, and `workspace://path` links in
the transcript now resolve against the session's cwd and open the viewer.

### Phase 4 — Profiles ✅ done

`/api/profiles` is a large, fully-featured surface: `GET,POST /api/profiles`,
`GET,POST /api/profiles/active`, `PATCH,DELETE /api/profiles/{name}`,
`PUT /api/profiles/{name}/model`, `GET,PUT /api/profiles/{name}/soul`.

Only `KanbanScreen.tsx` mentions profiles today, and only for kanban's own
`/api/plugins/kanban/profiles`.

Shipped as a Hub sub-tab (`components/hub/ProfilesTab.tsx`): list with active indicator,
gateway-running dot, model and skill count; switch; create with clone-from; delete behind
a confirmation that spells out what goes with it.

**Scope correction:** the plan claimed create supports "custom endpoint fields — Base URL
and API key" for Ollama/LMStudio. `ProfileCreate` on this backend (0.20.0) has no such
fields — only `provider` and `model`. That part was not built because it doesn't exist.

Switching invalidates the entire query cache, since a profile reload changes config,
skills, memory, cron and models all at once.

Still deferred: the `soul` editor, and profile `export`/`import`.

### Phase 5 — Rendering and organization polish

**5.1 Mermaid diagrams** ✅ done — lazy-loaded on first diagram, scrolls sideways, taps to
full-screen. Only an explicit ` ```mermaid ` fence qualifies: hljs' `detect` guesses
languages, and feeding a guess to mermaid would mangle real code.

Mermaid ships ~56 chunks (one per diagram type, plus cytoscape and katex). Left alone they
quadrupled the PWA precache from 1.2MB to 4.5MB — an install cost paid by everyone for
diagrams most users never see. `chunkFileNames` now routes anything mermaid-derived into
`assets/diagrams/`, which the service worker excludes from precache and runtime-caches on
first use instead. Net precache growth: ~45KB.

**5.2 Subagent delegation cards** ✅ done — the event shape came from the gateway source
rather than the dev panel. On the *parent* session these arrive: `subagent.start`,
`subagent.tool`, `subagent.thinking`, `subagent.complete`, carrying goal, model, depth,
tool name, summary, duration, token rollups and files written.

`subagent.text` is deliberately **never** relayed to the parent — the gateway skips that
emit because the child's reply tokens are meaningless there. Its source comments warn
against adding a parent-side catch-all for it; `ws/types.ts` now records that so nobody
re-adds one.

Cards key on `subagent_id`, falling back to `child_session_id` and then to a single flat
card, matching the gateway's own note that all identity fields are optional.

**5.3 Session tags** ✅ done — `#tag` is parsed out of titles into chips with a stable
per-tag colour, plus a filter rail above the list. Tags live in the title string because
that's the only writable field, which means they survive being set from the CLI, Discord,
or by the agent naming its own session.

**Projects** remain skipped: they need grouping storage `SessionRename` doesn't provide.

**5.4 Todos panel** — still blocked. `GET /api/todos` 404s on `hermes serve` with
"Headless backend — use `hermes dashboard` for the browser UI". Not buildable against this
backend mode.

**5.5 CLI session bridge** ✅ already working — the check came back positive and then some.
This install's sessions are `discord: 25, cli: 16, cron: 13, web: 7, tui: 1`. CLI sessions
already appear in the list and already resume, and `SessionRow`'s `SOURCE_ICON` map already
badges every one of those sources. Nothing to build.

---

## 4. Suggested order

```
Phase 1  ✅ session pin/archive, retry, edit+regenerate, queued send, timestamps, export
Phase 2  ✅ already implemented before this plan was written — see the correction above
Phase 3  ✅ workspace file browser (new Files tab)
Phase 4  ✅ profiles (new Hub sub-tab)
Phase 5  ✅ mermaid, tags, subagent cards, CLI sessions — except 5.4 todos (blocked)
```

Everything in this plan is now built except **5.4 Todos**, which `hermes serve` cannot
serve at all, and the two Phase-4 deferrals (`soul` editor, profile export/import).

## 5. Resolved questions

- *Does `GET /api/sessions` ever return `source: "cli"`?* Yes — 16 of them, plus discord,
  cron and tui. They already render and resume. 5.5 needed no work.
- *What event does the gateway emit for subagent lifecycle?* `subagent.start` / `.tool` /
  `.thinking` / `.complete` on the parent session; `.text` is deliberately withheld from
  the parent. Read from the gateway source rather than captured frames.

## 6. Still open

- Should voice default to server-side transcription even under HTTPS, where Web Speech
  would work? Server-side is more consistent and works on Firefox; Web Speech has lower
  latency and no round-trip. Currently server-side wins when both are available.
- Pin sorting and tag filtering both operate on the fetched page (100 rows max). With more
  sessions than that, a pinned or tagged session outside the window won't surface. Worth
  revisiting if it bites.
- The subagent card is built from the gateway's event contract but has not been seen
  against a live delegation run — no session in this install has spawned one yet.
