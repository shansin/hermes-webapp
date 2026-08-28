# Testing

```bash
pnpm test              # everything, once
pnpm test:watch        # re-run on change
pnpm test:coverage     # v8 coverage report
```

Vitest runs two projects, because the two halves of this repo live in different
worlds and faking either one would hide the things most worth testing:

| Project  | Environment | Root      | Covers                                        |
| -------- | ----------- | --------- | --------------------------------------------- |
| `server` | node        | `server/` | static serving, proxying, push, the updates feed |
| `web`    | jsdom       | `web/`    | the gateway client, the chat store, PWA wiring |

Run one at a time with `npx vitest run --project server`.

## What is covered, and why

Each suite targets logic where being wrong is invisible until a person is
already affected — a banner that never arrives, a frame that vanishes, a
conversation that opens onto the wrong thing.

**`server/test/static.test.ts`** — the only place a URL becomes a filesystem
path. Content negotiation, ETag-per-representation, the SPA fallback's refusal
to answer `/api`, and a table of path-traversal attempts.

**`server/test/apiProxy.test.ts`** — the Host rewrite that gets past Hermes'
anti-DNS-rebinding guard, server-side token injection, hop-by-hop header
stripping, and dropping a scraped token on a 401.

**`server/test/wsProxy.test.ts`** — a real `ws` server standing in for Hermes
and a real client for the phone. The handshake disguise is not observable any
other way. Includes the regression for frames sent before the upstream leg is
ready, and the Access gate on upgrades — which needs its own coverage because
upgrades bypass Hono entirely, so gating `/api/*` does not gate the socket that
actually drives the agent.

The keepalive lives there too: Cloudflare closes an idle proxied WebSocket at
100s, and the failure is a working app that flashes "Reconnecting…" for ever
while logging nothing at either end.

**`server/test/auth.test.ts`** — the Cloudflare Access gate, against real RS256
keys and a real JWKS document rather than a stubbed `jwtVerify`: the claim
checks *are* the feature. A gate that wrongly rejects locks out a phone, which
announces itself; a gate that wrongly accepts leaves the agent wide open and
looks identical from every screen. Covers signature, `aud` (the only thing
separating this application's tokens from another app on the same Cloudflare
account), expiry, the email allowlist, 401-vs-403, the `/healthz` exemption,
key-set caching, and that an invented `kid` cannot be used to make the proxy
hammer Cloudflare.

**`web/test/accessSession.test.ts`** — telling an expired sign-in apart from a
dead network. The two are indistinguishable in the browser (a rejected `fetch`,
a 1006 close) and want opposite responses, so the discrimination is tested
rather than assumed — including that the probe uses `redirect: 'manual'`, which
is the only way the redirect is observable at all, and that a screen full of
simultaneous failures produces exactly one probe.

**`server/test/store.test.ts` / `feed.test.ts`** — the two JSON files the proxy
owns. Upsert-by-endpoint, atomic writes, `0600` permissions, and recovery from a
corrupt file. `config.js` is mocked to a temp directory so the suite never
touches the real `.hermes-push.json`. `feed.test.ts` additionally pins the two
properties the feed gained when it widened past cron: a file written by the
older shape still loads (it is somebody's history, and warning-and-starting-
empty would discard it), and the unread watermark is the newest entry's
timestamp rather than the clock, so a run finishing as the screen opens is
still news. Since the writes were debounced it also pins what that debounce is
allowed to change: the first append of a burst still lands on disk before the
call returns — leading edge, so "appended" and "recorded" remain the same
statement — while a burst is collapsed, and `flushFeed()` gets out whatever is
still queued. That last one is what shutdown calls, and without it a proxy
stopping inside the cooldown drops the row explaining why it stopped.

**`server/test/cron.test.ts`** — the reconcile pass, driven against a stubbed
gateway. Mostly about telling a person exactly once: seeding, dedupe by run id,
failures that never produced a run, and a gateway that is not answering. Also
the profile dimension, where all three failures are silent: a job in another
profile produces no `cron.changed` at all (hence the sweep, tested with the
timer faked), an unqualified runs call is resolved against every store by id or
name, and an unqualified messages call 404s into a notification that fires with
the reply missing rather than not firing.

**`server/test/events.test.ts`** — which gateway events are worth waking a phone
for, and which must stay silent.

**`server/test/updates.test.ts`** — the two feed sources that are not cron, and
mostly about restraint in both directions. The agent's announcements have to be
written down *with no push devices registered* — that is the whole case the
widened frame scan in `events.ts` exists for, and the failure is silent — while
writing no push of their own, because `events.ts` already sends those. The
backend watch has to stay quiet through a restart that reconnects inside the
grace window, and through a clean shutdown, whose socket close is its own.

**`server/test/routers.test.ts`** — the push and feed HTTP endpoints.

**`web/test/wsClient.test.ts`** — socket lifecycle against a controllable mock.
Note that `MockSocket.close()` fires `onclose` asynchronously, as a browser
does; a synchronous mock hides ordering bugs in code that closes a socket and
immediately replaces it.

**`web/test/sessionStore.test.ts`** — gateway events folded into a transcript.
Session isolation, queueing mid-turn, rewinding, and resync after a drop.

**`web/test/delegation.test.ts`** — the delegation registry and the two
controls that act on one delegated child. Every assertion is a wire contract
with no second source to check it against: the registry is gateway process
memory, there is no REST route to compare with, and `subagent.steer` answers
`{"status": "rejected"}` — a successful JSON-RPC reply — when it declines. So
these catch the silent failures: a steer sent without the `session_id` the
gateway resolves authority from, or a refusal read as a success.

**`web/test/liveTurn.test.ts`** — arriving in the middle of a turn. The store
learned that a turn was running from `message.start`, which is the one event a
client that arrived late can never see, so a phone whose PWA the OS had
discarded came back to an idle-looking screen over a working agent — and sent
its next message at a session the gateway rejects as busy. These cover the
live-turn state `session.resume` answers with (`running`, the in-flight prompt
and reply, a held prompt, and the two requests that block a turn), the live
event that infers a running turn when nothing said so, and that neither leaves
a tool card pulsing once the turn has ended.

**`web/test/pushServiceWorker.test.ts`** — `public/push-sw.js` evaluated in a
fake worker global. It gets no type checking and no bundling, and it runs where
nobody can open a console on it.

**`web/test/deepLinks.test.ts`** — the notification-URL contract, checked by
parsing the actual server and screen sources. The proxy writes these links in
TypeScript and the app reads them in TSX with no shared type between them, which
is how `/chat?session=…` came to be sent by every push payload and read by
nothing.

**`web/test/usage.test.ts`** — the Usage screen's arithmetic, which is all time
boundaries and attribution rules: hourly bucketing against a rolling 24-hour
window, zero-filling idle days, whether cost means anything on this install,
what the hourly bars leave out, folding the duplicate model rows the analytics
endpoint emits, and the window fetch's paging (stop at the boundary, give up at
the page ceiling and say so). Pure functions plus a structural check that the
charts did not reappear on Models.

**`web/test/sheet.test.tsx`** — the bottom sheet's modal contract: focus moves
in, wraps at both ends, returns to whatever opened it, and a sheet that demands
an explicit choice cannot be escaped. Driven with `user-event`, since a focus
trap only means anything as something a keyboard runs into.

**`web/test/cronText.test.ts`** — cron expressions in words. Hermes'
`schedule_display` sounds pre-rendered and is not: it is the expression echoed
back, so `30 6 * * *` was sitting in the line meant to explain a row. Most of
these cases pin the *refusals* — six-field dialects, macros, unhandled ranges,
day-of-month combined with day-of-week (cron ORs them), out-of-range values —
because a schedule rendered wrong is believed, while a cryptic one announces
that it needs reading.

**`web/test/activity.test.ts`** — also covers which agent a row belongs to. The
label matters, but the session link matters more: a row for another profile's
work whose URL omits `&profile=` opens an empty chat, because the resume looks
the id up in the active profile's store. Pins that an unassigned kanban card
gets no borrowed owner, and that a row with no profile keeps its original
unscoped link — that shape is every notification already sitting on a phone.
Also the delegation lane, which exists because a background delegation shows up
in none of the other three: those children get no session rows and emit no
`subagent.*` events, so three researchers appeared as one row — the parent that
dispatched them. Pins that they list alongside that parent rather than
replacing it, and that a start time is never dressed up as a heartbeat.

**`web/test/sessionScope.test.ts`** — which profile's `state.db` a session call
reads, and the task→session join. Sessions are per-profile and the detail route
answers *404 Session not found* for a session that exists in another profile, so
the failure reads as "deleted" rather than "wrong store". The title correlation is
the *fallback* join and not a foreign key, so the rule that a non-kanban session
merely mentioning the id must never match is pinned here; the exact join and
what it costs to get wrong are in `kanban.test.ts`.

**`web/test/kanban.test.ts`** — the three kanban joins that fail silently.
Which conversation a run happened in: the exact join is the session id a worker
stamps into its run metadata, and the fallback is a title the auxiliary model
routinely never writes — most kanban sessions in this install's research
profile are `title: null`, and every one of them reported "no matching
conversation" for a run that had plainly happened. Which profile to look in: a
run carries the profile it ran as, while `task.assignee` is only where the card
points now, and the wrong per-profile store answers with an empty list rather
than an error. Pins that both halves come off the *same* run — mixing the
newest run's profile with an older run's session id builds a lookup for a
session that never lived in that store, which 404s and reads as "deleted".
And the unblock ordering: Hermes builds the next worker's prompt from the
comments, so the answer must be posted before the card is released, and a card
whose answer failed to post must stay blocked. Releasing it anyway burns a run
rediscovering the same blocker, which costs a `block_recurrences` increment —
two of those and Hermes reroutes the card to Triage. The rest of the file
covers payload shapes with the same quiet failure: a bulk change reporting
twelve moved when nine moved (per-id results, 200 either way), an override
cleared with an empty string rather than the flag — which pins the card to a
model named `""` — a create dropping its idempotency key or swallowing the "no
dispatcher is running" warning Hermes gives nowhere else, and a dispatcher tick
read as nested when the wire shape is flat.

**`web/test/kanbanScope.test.ts`** — which board a kanban call addresses. The
same class of silent cross-write as `?profile=`, with a twist: omitting the
board does not mean "the only board", it means whichever board the *server*
points at, and `POST /boards/<slug>/switch` moves that pointer process-wide. A
second client switching boards would redirect every unqualified call this app
makes while the screen kept its title and its cards. Every read and every write
is pinned here, along with the two URLs that have to *join* an existing query
rather than start one — unlink takes its ids in the query string, and a `?`
there drops both — and the query keys, because two boards sharing a cache entry
shows the previous board's cards until the refetch lands.

**`web/test/kanbanAdmin.test.ts`** — the two board-level flags that cannot be
taken back. `DELETE /boards/<slug>` archives by default and destroys the whole
SQLite file with `?delete=true`; `describe-auto` overwrites a description
stored nowhere else, which is also what the decomposer routes on. Both default
to the safe form here. Also that a refusal arriving as a 200 with `ok: false` —
what a missing auxiliary model answers — is surfaced rather than read as
success, and that every health read is gated so a closed sheet costs nothing
(the workers query polls).

**`web/test/kanbanShapes.test.tsx`** — surviving a response missing a key.
`data?.rows.length` guards only `data`, so a payload that arrives without the
key throws on a plain `.length` — and with no error boundary in `App.tsx` that
unmounts the whole app, not the section. Realistic for the newer plugin routes,
where any version drift answers 200 with an unexpected body. Worth knowing how
this was found: every test in this directory passed while the app blanked on
the first tap of Board health, and only driving the real build in a browser
showed it.

**`web/test/fileLinks.test.ts`** — what counts as a file path in a transcript.
The risk is inventing a link, not missing one: a false positive looks tappable,
lands on "file not found", and teaches you the feature is unreliable, while a
miss costs a copy and paste. So the bulk of this file is the refusals — the
app's own routes, a URL with a file-shaped path, anything carrying a query or
whitespace, and `javascript:` above all — alongside the paths this install's
agents actually emit.

**`web/test/markdownPaths.test.tsx`** — that the renderer reaches for that rule
in both places an agent puts a path, and that a fenced code block is not one of
them. Two of the failure modes live in the wiring rather than the rule:
react-markdown's URL sanitiser empties any scheme it does not know, so a
`file://` href arrived indistinguishable from a link written without one — and
`workspace://` had that bug all along, which is how this test found it.

**`web/test/historyDismiss.test.tsx`** — back-button dismissal, and the
hand-off that used to break it. One sheet opening another while closing itself
had the newcomer close a frame after it opened: React runs cleanups before
effects, so the departing overlay's queued `history.back()` landed on the
newcomer's history entry. That is a menu item that does nothing, and it shipped
on the kanban board menu and on `/model` and `/context` from the command
palette. **jsdom fires no `popstate` for `back()`**, so the symptom is not
reproducible here and was confirmed in Chrome; what these tests pin is the
decision underneath it — a hand-off reuses the departing entry
(`replaceState`), a nest stacks (`pushState`), a plain close pops, a close
after a route navigation does not, and StrictMode's mount/unmount/mount leaves
one sentinel rather than two.

**`web/test/kanbanEvents.test.ts`** — the board's live-update socket, which
sits next to a poll it must never replace. Every case is a way it could go
quietly wrong while the board still looks fine: a cursor that does not survive
a reconnect (re-seeding replays the gap, zero replays the whole table), a
board change carrying the previous board's cursor into a different table's
numbering, the proxy's JSON keepalive treated as data — which would turn it
into a slower poll nobody asked for — a malformed frame tearing down the
stream instead of being dropped, and a superseded socket's close marking the
hook dead over a live stream, which would leave the board on the slow poll
believing it was live. Also that it gives up rather than retrying for ever:
a socket that cannot open here usually never will, and the poll covers it.

**`server/test/kanbanSweep.test.ts`** — telling you a card stopped. The board
has no event stream that reaches the proxy, so this is state on a timer, and
every test is a way that could report wrongly: announcing states instead of
transitions (a card blocked yesterday is still blocked today); announcing the
past (a fresh install, or a restart, firing one notification per card);
losing a re-block, because Hermes re-blocks in place until the limit so the
counter moves while the status does not; forgetting watermarks on a pass that
reached nothing, which would re-announce the whole board on recovery; and
following the server's board pointer instead of sweeping every board.

**`web/test/cronScope.test.ts`** — which profile a cron call addresses. A job
created into the wrong profile looks entirely normal on the screen that created
it and is wrong only in that it runs as the wrong agent, or never runs because
that profile lacks the skills its prompt assumes. Worse for the per-job actions:
with no profile parameter Hermes resolves the job by scanning every store and
matching on id *or name*, so an unscoped delete can destroy a same-named job
belonging to another profile.

**`web/test/skillScope.test.tsx`** — which profile a skills call addresses, and
what install actually posts. Skills are per-profile in both directions: the
files live in one profile's `skills/` directory and the enabled set is that
profile's `skills.disabled`. Before the screen had a picker it could only be
right by accident, and wrong invisibly — a switch flipped while looking at
`research` reported success and edited `default`. The install body is pinned
here too because its required field is `identifier`
(`skills-sh/anthropics/skills/pdf`), not the display `name`: one search for
`pdf` returns that name from three different repos, so the name addresses
nothing and the endpoint 422s.

**`web/test/skills.test.ts`** — grouping the installed list by category, where
the category is server-supplied and can be null. Hermes reads a skill's
category from its parent directory, so one the agent wrote itself, filed at the
top level, arrives as `category: null`; grouping on that key and rendering the
heading with `.replace()` threw during render, and with no error boundary in
the app that blanked every screen, not just this one.

**`web/test/appBack.test.tsx`** — where the header's back arrow actually goes.
The check is on React Router's `history.state.idx`, chosen over
`location.key === 'default'` precisely because a redirect (`/usage` →
`/models`, `/hub?tab=…` → `/…`) mints a fresh key without deepening the stack —
so the old test said there was history behind a screen that had none, and back
walked out of the app. In a `standalone` install that reads as the button being
dead, which is not a report anyone can act on.

**`web/test/approvalReach.test.tsx`** — that an approval can be answered from
outside the chat screen. Includes a structural check that the sheet is mounted
by the shell, because moving it back under one screen would silently make
approvals unanswerable everywhere else again.

**`web/test/toasts.test.tsx`** — the live region, the keyboard-reachable
dismiss, and the undo action.

**`web/test/undo.test.ts`** — the deferred-commit window. The backend has no
restore endpoint, so Undo can only mean "the request has not gone out yet";
these cover that the window closes, survives the screen that opened it going
away, and commits rather than cancels when the app is closed.

**`web/test/clarify.test.ts`** — `clarify.request` folded into the store. The
bug it exists for was total and silent: the event fell through `applyEvent`,
which ignores unknown types by design, so the question never reached the UI and
the turn sat parked behind a tool card pulsing "running". Covers both wire
shapes, the open-ended form whose `choices` are `null` rather than absent, the
per-`qid` batch calls, a timed-out answer, and — the one a non-dismissible
sheet makes critical — that a prompt never outlives the turn it belongs to.

**`web/test/clarifySheet.test.tsx`** — the sheet, driven with `user-event`,
because the encoding is what has to be right: the gateway parses whatever we
send and resolves the block either way, so a malformed answer is invisible.
One-tap for a single choice, JSON for multi-select (a choice can contain a
comma), free text for open-ended and for "Something else…", and a batch that
refuses to send half an answer. Plus the structural check that the shell mounts
it, since moving it under one screen would make a question raised elsewhere
unanswerable again.

**`web/test/clarifyExchange.test.ts`** — reading a finished clarify back out of
the transcript. Every input is somebody else's projection: the tool's result
JSON, `session.history` (which keeps a call's arguments and drops its result),
and the REST copy (which keeps both). The card is only as honest as its ability
to tell "you picked the third option" from "you typed something else" from
"nobody ever answered", and the last is indistinguishable from a bug unless it
says so. Also the by-question matching that grafts answers back onto a replay —
by text, never by position, because a confidently mislabelled answer is worse
than a missing one.

**`server/test/share.test.ts`** — the share target's server-side fallback, which
only runs when the service worker didn't. Rare and invisible, which is the
shape of thing that rots: that it answers 303 rather than 302, carries the text
across, flags a share whose files it had to drop, and never buffers a photo it
is only going to discard.

**`web/test/shareServiceWorker.test.ts`** — `public/share-sw.js`, evaluated in
a fake worker global like its push counterpart, and the only thing standing
between a share-sheet POST and a browser error page. That a share is filed
under an id, handed over exactly once, and deleted as it goes; and that the
`fetch` listener — which runs ahead of every Workbox route — claims the share
POST and nothing else.

**`web/test/sharedIntake.test.ts`** — the page's half of that exchange. Almost
all failure cases, because the success is two `postMessage`s and the failures
are what a person hits: a reload of a spent `?share=`, a page no worker
controls, a worker that never answers. Each must end in "no share" rather than
a promise the chat screen waits on forever.

**`web/test/streamingMarkdown.test.ts`** — where the streaming bubble is allowed
to cut a half-written markdown document in half so the finished part can be
parsed once instead of ten times a second. Both ways of being wrong are
invisible: splitting too eagerly corrupts the message — two unterminated fences
out of one, an ordered list that restarts at 1 halfway down — and only while a
reply is streaming, the state hardest to catch and impossible to reproduce from
a saved transcript; splitting too timidly renders perfectly and silently gives
the whole optimisation back. So the refusals and the splits are pinned
separately.

**`web/test/localImages.test.ts`** and **`web/test/chatImages.test.tsx`** — the
two ways a picture reaches the transcript, both of which fail by showing
nothing. A received screenshot arrives as `![…](file:///…)`, and
react-markdown's URL sanitizer blanks that scheme before the renderer ever sees
it — no error, no console line, just an absent image; the render test pins the
transform that lets it through and the authenticated read it becomes. A sent
one is persisted by Hermes as an `@image:<path>` directive appended to your own
message, quoted by its rules when the path holds a space or a bracket, so the
parser is checked against the formatter it has to agree with — a ref that isn't
recognised renders as a stray line of file path where the photo should be.

**`web/test/highlight.test.ts`** — the local rehype plugin that replaced
`rehype-highlight` to keep thirty unused grammars out of the Markdown chunk.
Trading a well-tested dependency for eighty lines of tree-walking is what buys
these: that an unknown language degrades to plain code rather than throwing,
that the `hljs` class and the fence's own `language-` class both survive (the
second is what the code header and the mermaid special case read), and that
inline code is left alone. An exception inside a rehype plugin takes down the
whole message, and a message that fails to render looks like the agent said
nothing.

**`web/test/sessionCache.test.ts`** — hiding a session from the query cache
before its delete is sent, which is how the undo toasts work at all. There are
two shapes under the `['sessions']` prefix now — the plain lists and the paged
list's `{ pages: [...] }` — and a setter that understands one and quietly skips
the other throws nothing and logs nothing: the row stays put, the tap looks
like it missed, and the delete goes through eight seconds later anyway.

**`web/test/cronText.test.ts`** — cron expressions in words, and the validator
behind the create form's inline error. Those two contracts run opposite ways
and both matter: `humanCron` must stay silent unless it is certain, because a
schedule rendered wrong gets believed; `cronError` must stay silent unless it is
certain, because a false complaint blocks a schedule Hermes would have accepted.
The cases it must catch are the ones that used to save happily and never run.

**`web/test/push.test.ts` / `apiClient.test.ts` / `uiStore.test.ts` /
`sessionTags.test.ts`** — browser-side push state, REST error shaping, theme
resolution and persistence, tag parsing.

## Not covered

Whole-screen rendering. The screens are thin over the stores and the API layer,
both of which are tested directly, so a render test of one would mostly assert
that JSX exists. The components that *are* rendered here earn it by owning
behaviour of their own — a focus trap, a live region, a modal that must not be
escapable.
