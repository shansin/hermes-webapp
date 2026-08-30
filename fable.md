# fable.md — Usability, UI & Performance Improvement Plan

A deep review of hermes-webapp (`web` React 19 + Vite PWA, `server` Hono proxy), 2026-08-24.
Every claim below was read from source; file paths are cited so items can be verified before work starts.
Effort: **S** (< half a day), **M** (a day or two), **L** (multi-day / needs design).

> **Status: all items implemented.** Two landed differently from the proposal and
> the reason is recorded with the item: **B2** could not be done by passing
> `languages` (see below), and **B3**'s audit found nothing safe to move. The
> measured baseline B1 asked for is in §3.2.

---

## 1. What is already strong — do not "fix" these

These are deliberate, and several are documented in file-header comments or CLAUDE.md:

- **Streaming isolation.** `StreamingTail` in `web/src/components/chat/MessageList.tsx` is the only subscriber to `streamingText`/`streamingReasoning`, throttled to ~10fps via `useThrottled` (100ms). Historical bubbles never re-render per token.
- **Delta fast path.** `ws/client.ts` discriminates response-vs-event before zod (measured 27.9µs → 2.5µs per delta), and `store/session.ts` extracts `.text` manually instead of `safeParse` on the firehose.
- **Route splitting.** Everything except `ChatScreen` is `React.lazy`; `manualChunks` is deliberately absent (it defeated itself via modulepreload — see comment in `vite.config.ts:85`). Mermaid's 56 chunks (3.4 MB) are quarantined in `assets/diagrams/` and excluded from the SW precache.
- **CSS containment instead of JS virtualization.** `.srow` uses `content-visibility: auto` because windowing fights touch gestures and pull-to-refresh (documented in `global.css`).
- **Touch targets.** `.icon-btn`, `.btn--sm`, `.chip`, `header__sub` all expand to 48dp via `::after`.
- **Sheet a11y.** `shared/Sheet.tsx` has a complete focus trap, focus return, `aria-modal`, drag/Escape/backdrop dismissal, and converts to a centered dialog past 1000px.
- **Streaming proxy.** `server/src/routers/apiProxy.ts` pipes bodies both directions with no buffering; `push/events.ts` `handleFrame` substring-scans before `JSON.parse` so token deltas never get parsed.
- **Theming.** Three themes + six accents as tokens, `theme-color` meta kept in sync, AMOLED deliberately unreachable from `system`.

---

## 2. Usability & UI improvements

### 2.1 Quick wins

| # | Problem | Evidence | Proposed change | Effort |
|---|---------|----------|-----------------|--------|
| U1 | Files row `⋯` "armed delete" state never disarms — tapping elsewhere leaves the red trash icon showing until another row is tapped | `web/src/screens/FilesScreen.tsx` | Disarm on outside pointerdown / scroll / blur | S |
| U2 | Updates screen has no pull-to-refresh and no refresh button; only refresh is `markRead` on mount | `web/src/screens/NotificationsScreen.tsx` (uses `.chat__list`, no `PullToRefresh` wrapper) | Wrap list in existing `shared/PullToRefresh.tsx` like Sessions/Activity/Files/Kanban | S |
| U3 | Kanban task delete has no Undo, while Sessions and Cron deletes offer one | `web/src/screens/KanbanScreen.tsx` (`removeById` → plain toast) | Reuse the toast-with-action Undo pattern already used by Sessions/Cron | S |
| U4 | Bulk session delete has no Undo (single swipe delete does) | `web/src/screens/SessionsScreen.tsx` | Same Undo-toast pattern; restore the batch | S |
| U5 | Settings push section renders `null` while loading — the section pops out and back in | `web/src/components/hub/SettingsTab.tsx` (`NotificationsSection` returns null when `state === 'loading'`) | Render a skeleton row instead of nothing | S |
| U6 | Skills hub-search error is bare red inline text with no retry | `web/src/components/hub/SkillsTab.tsx` (`Hub search unavailable` div) | Use shared `ErrorNote` + retry, as every other screen does | S |
| U7 | Mermaid diagram has `role="img"` but no `aria-label`; zoomed diagram dialog has `aria-modal` but no focus move or trap | `web/src/components/chat/MermaidBlock.tsx` | Add `aria-label` (diagram type or first line of source); move focus into the zoom dialog on open, return on close, mirroring `Sheet` | S |
| U8 | Reduced-motion gaps: mic `pulse-rec` animation and PullToRefresh height transition ignore `prefers-reduced-motion` | `web/src/styles/chat.css`, `shared/PullToRefresh.tsx` | Add the missing overrides | S |
| U9 | Cron create form validates name/prompt (disabled submit) but not the schedule — an invalid cron expression only fails at save with a toast | `web/src/components/hub/CronTab.tsx` | Client-side cron validation with inline error below the field, reusing the pattern from ProfilesTab (the app's only true inline validation today) | S–M |

### 2.2 Consistency pass

The app has good shared components (`Empty`, `ErrorNote`, `SkeletonList`, `Loader`, `Switch`, `Sheet`, toasts) but several screens bypass them:

| # | Problem | Evidence | Proposed change | Effort |
|---|---------|----------|-----------------|--------|
| C1 | Two toggle implementations: SkillsTab has a local `Toggle` (inline styles) duplicating shared `Switch` | `SkillsTab.tsx` vs `shared/misc.tsx` | Delete the local one, use `Switch` | S |
| C2 | Plain-text loading states — "Loading…" (MemoryTab file cards, Cron run history), "Searching…" (SkillsTab), "counting skills…" (ProfilesTab) — where other screens use `SkeletonList`/`Loader` | `MemoryTab.tsx`, `SkillsTab.tsx`, `CronTab.tsx`, `ProfilesTab.tsx` | Consolidate on shared skeleton/loader components | S–M |
| C3 | List group headers styled four different ways: Sessions and SkillsTab use ad-hoc inline styles, Activity/Notifications use `.msg-divider`, Cron run rows use bare borders | `SessionsScreen.tsx`, `SkillsTab.tsx`, `ActivityScreen.tsx`, `CronTab.tsx` | One `.group-head` class in `global.css`; migrate | S–M |
| C4 | Sessions search-hit card is the only card-like element built from inline styles instead of `.card` | `SessionsScreen.tsx` | Use `.card` | S |
| C5 | Kanban lane empty state differs by layout: wide shows bare `.lane__empty` "Empty", phone shows the `Empty` component | `KanbanScreen.tsx` | Pick one (the `Empty` component, smaller variant) | S |
| C6 | Typography drift: inline `fontSize: 11.5 / 12.5 / 13 / 13.5 / 14.5` across hub tabs sit between the defined `--type-*` slots | all `components/hub/*.tsx` | Map to the existing type scale; add a token only if a real gap exists | M |
| C7 | No spacing tokens at all — `gap: 7`, `padding: 11px 13px`, `marginBottom: 9` everywhere | throughout | Add a 4px-grid spacing scale to `global.css` (`--space-1..6`); migrate opportunistically, not as a big-bang rewrite | M (ongoing) |

### 2.3 Larger UX items

| # | Problem | Evidence | Proposed change | Effort |
|---|---------|----------|-----------------|--------|
| X1 | Sessions list loads one capped page (limit=100) with no "load more" — older sessions unreachable from the UI | `web/src/api/sessions.ts:154`, `SessionsScreen.tsx` | Incremental pagination ("Show more" row or infinite scroll respecting the CSS-containment approach) | M |
| X2 | ApprovalSheet "Always allow" is a single tap with no confirmation — a permanent grant next to one-shot options | `web/src/components/chat/ApprovalSheet.tsx` | Two-step confirm on that button only (tap → "Tap again to always allow") | S |
| X3 | File attachment upload shows only a `◌` spinner in the pill, no progress, no cancel | `web/src/components/composer/` | Progress if the transport allows; at minimum a cancel affordance | M |
| X4 | Blank `Suspense` route fallback (`.route-pending`) is right for LAN but shows a dead screen on slow Tailscale/tunnel links | `App.tsx` | Delayed skeleton: render nothing for ~300ms, then a minimal header + `SkeletonList` | S |

---

## 3. Performance optimizations

### 3.1 Streaming hot path

| # | Problem | Evidence | Proposed change | Effort |
|---|---------|----------|-----------------|--------|
| P1 | `thinkingHint` is read **unthrottled** in `StreamingTail` — `thinking.delta` arrives at 30–60/s, so during the thinking phase the tail re-renders at full event rate while `streamingText`/`streamingReasoning` are throttled to 10fps | `MessageList.tsx:780` (verified), `store/session.ts` sets it per `thinking.delta` | Pass it through the same `useThrottled(…, 100)` | S |
| P2 | The entire accumulated partial markdown is re-parsed through the unified pipeline every 100ms tick — cost grows with message length for the whole stream duration | `StreamingTail` renders `<Markdown>{throttledText}</Markdown>` | Either (a) render the tail as plain text + cheap inline code/bold styling until `message.complete`, then parse once; or (b) split on block boundaries and memoize the stable prefix, re-parsing only the last open block. (b) keeps live formatting; prototype both | M–L |
| P3 | `tool.complete`, subagent updates map the full `messages` array per event — O(n) per tool call, degrades in long tool-heavy sessions | `store/session.ts` (`s.messages.map(...)`) | Index-based replace (find index once, splice-copy) or a Map keyed on tool id with ordered ids | S–M |

### 3.2 Bundle

**Recorded baseline** (B1's deliverable). `pnpm size` prints this; `pnpm analyze`
adds `web/dist/stats.html`, a treemap of who is responsible for it. Gzipped,
because gzip is what crosses the wire:

| | before | after B2 |
|---|---|---|
| **Eager** (entry + everything `modulepreload`ed — decides time to first paint) | 148.6 KB | **148.6 KB** |
| Lazy routes and chunks | 279.1 KB | **248.6 KB** |
| `Markdown-*.js` | 101.3 KB | **70.8 KB** |
| `UsageTab-*.js` (recharts, correctly split) | 94.3 KB | 94.3 KB |
| Diagrams dir (mermaid; never precached) | 927.8 KB | 927.8 KB |

`web/scripts/size.mjs` carries budgets — 190 KB eager, 260 KB per chunk — and
exits non-zero when either is breached, so this is a thing that can regress
loudly rather than a number in a document. Both are set above where things
stand, not at an ideal: a budget that is already breached teaches everyone to
ignore it.

| # | Problem | Proposed change | Effort |
|---|---------|-----------------|--------|
| B1 | Zero bundle observability — no analyzer, no size script, no budget | Add `rollup-plugin-visualizer` behind an env flag + a simple size-report script; record baseline in this file | S |
| B2 | Markdown chunk dominated by lowlight's `common` grammar set; `rehype-highlight`'s options don't tree-shake it | **Done, differently.** The proposed route does not work: `rehype-highlight` does `import {common} from 'lowlight'` at module scope, so `common` is reachable whatever options are passed and `languages` can only *add*. Replaced with a ~90-line local rehype plugin (`web/src/components/chat/highlight.ts`) over `createLowlight` registering the ten grammars listed, plus aliases; `detect` stays off. **Markdown chunk 101.3 → 70.8 KB gzipped (−30%).** `rehype-highlight` removed as a dependency; `web/test/highlight.test.ts` covers the tree-walking that replaced it. | M |
| B3 | Entry chunk carries everything statically reachable from the shell — audit after B1; likely candidates: `zod` (only used by `ws/types.ts`), `qrcode.react` (Settings only?) | **Audited; nothing moved, and that is the finding.** `pnpm analyze` breaks the entry down as react-dom 548 KB · app source 257 KB · **zod 131 KB** · react-router 84 KB · query-core 82 KB (raw). `qrcode.react` was already out — it is only reached from the lazy `SettingsTab` chunk. zod cannot follow it: these schemas validate gateway frames and the socket opens on mount, so a dynamic import would have to resolve before the first frame or be duplicated by a hand-written validator for the boot window. Its size is a tree-shaking problem (zod 3 ships the whole builder API), not a chunk-boundary one — shrinking it means `zod/mini` or hand-rolled predicates, which is a different decision. Recorded at the top of `web/src/ws/types.ts` so the next person does not re-derive it. | M |

### 3.3 Query layer

| # | Problem | Evidence | Proposed change | Effort |
|---|---------|----------|-----------------|--------|
| Q1 | `useTaskSession` fetches **100 sessions every 15s** to title-match a single kanban task | `web/src/api/kanban.ts:181` | Use the session search endpoint or a small limit; poll only while the task sheet is open; back off once matched | S–M |
| Q2 | `useSwitchProfile` calls `qc.invalidateQueries()` with no key — the entire cache refetches | `web/src/api/profiles.ts` | Invalidate only profile-dependent keys (sessions, skills, cron, model, config); keep cross-profile data (board, profiles list) | S |
| Q3 | `useSessionMessages` has no `staleTime` (falls to the 10s default) on the same endpoint Workbox serves StaleWhileRevalidate — double refresh churn | `web/src/api/sessions.ts:377` | Set `staleTime` ≈ 60s; live updates come over WS anyway | S |
| Q4 | Activity polling stack: ≤6 per-profile session queries @5s active + board @10s + cron @30s, while a WS `WATCHED`-event invalidation hook already exists | `lib/useActivity.ts`, `sessions.ts:218` | Lean on event-driven invalidation more: lengthen active poll to 15s where WS is open, keep 5s only as the no-socket fallback | M |

### 3.4 Server

| # | Problem | Evidence | Proposed change | Effort |
|---|---------|----------|-----------------|--------|
| S1 | `push/feed.ts` `persist()` does synchronous `writeFileSync` + `renameSync` on the event loop per mutation. (Verified: **one** write per `appendEntry` — `feed.ts:198` passes `write=false` to `markRunSeen`; no double-write.) | `server/src/push/feed.ts:159` | Debounce/coalesce persists (e.g. 250ms trailing) or an async write queue; entries are bounded at 300 so the loss window on crash is small | S–M |

---

## 4. Sequencing followed

1. **Quick wins + a11y** (U1–U9, X2, X4) — small, independent, immediately felt.
2. **Streaming hot path** — P1 first (one-liner), then P3, then P2 (needs a prototype and care around GFM edge cases).
3. **Bundle** — B1 (tooling) before B2/B3 so changes are measured, not guessed.
4. **Consistency pass** (C1–C7) — mechanical; fold into other work touching those files.
5. **Query layer + server** (Q1–Q4, S1) — low urgency, real wins on battery/network for an always-open phone PWA.

Cited lines were re-verified against the tree at commit `229ac28` before each item.

### Notes on how a few items landed

- **U9** — cron validation is `cronError` in `lib/cronText.ts`, written to the
  same rule as `humanCron` but from the other side: it complains only about
  what no cron dialect accepts (field count, unknown macro, out-of-range
  numbers, malformed steps) and waves `L` / `W` / `#` / `?` and six-field forms
  through to the backend. A false rejection blocks a schedule Hermes would have
  taken, which is worse than the silence it replaces. The field now also reads
  the schedule back as a sentence, which is what catches a typo that is *valid*.
- **X1** — `useSessionPages` is an infinite query at the endpoint's own 100-row
  cap, so first paint costs exactly what it did before. It meant the undo
  toasts' optimistic cache edit had to learn a second shape (`{ pages: [...] }`
  alongside the plain list); that is `hideSessions` / `restoreSessions` in
  `api/sessions.ts`, with `web/test/sessionCache.test.ts` on it, because a
  setter that silently misses one shape looks exactly like the tap not
  registering.
- **P2** — went with (b). `lib/streamingMarkdown.ts` finds the boundary between
  finished blocks and the block being written; the finished half is a separate
  memoized `Markdown` whose string does not change between ticks, so React
  skips it. Option (a) — plain text until `message.complete` — is cheaper and
  was rejected: the reply would arrive as visible markdown source and snap into
  shape at the end. The splitting rules and every case they refuse to split are
  in `web/test/streamingMarkdown.test.ts`.
- **S1** — the debounce fires on the **leading** edge, so a single append is
  still on disk before the call returns and "appended" and "recorded" stay the
  same statement; only a burst is collapsed. `flushFeed()` is wired into the
  `SIGINT`/`SIGTERM` handler, without which a proxy stopping inside the
  cooldown would drop the row explaining why it stopped.
- **U8** — the gap was not the two animations named. `global.css` already had a
  universal `animation-duration: 0.01ms !important`, which covers both; what it
  lacked was `animation-iteration-count: 1`, so every `infinite` animation in
  the app (the record pulse, the spinner, the loader, the live-card dot) kept
  running flat out at 0.01ms a cycle under `prefers-reduced-motion` — still
  moving, and burning battery to do it.
- **C6 / C7** — 162 inline font sizes mapped onto the scale. Two sizes had to be
  named rather than rounded away, because both are load-bearing and neither is
  in M3: `--type-detail` (13px, the dense secondary line, the single most
  common size in the app) and `--type-micro` (10.5px, meta and badges). The
  recharts `tick` props were left as numbers deliberately — a `var()` in an SVG
  presentation attribute is not worth the risk for an axis label. Spacing
  tokens (`--space-1..6`) are defined and used by new rules; the existing
  off-grid values move when their surroundings are touched, per the plan.
