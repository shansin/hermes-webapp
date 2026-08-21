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
| `server` | node        | `server/` | static serving, proxying, push, the cron feed  |
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
ready.

**`server/test/store.test.ts` / `feed.test.ts`** — the two JSON files the proxy
owns. Upsert-by-endpoint, atomic writes, `0600` permissions, and recovery from a
corrupt file. `config.js` is mocked to a temp directory so the suite never
touches the real `.hermes-push.json`.

**`server/test/cron.test.ts`** — the reconcile pass, driven against a stubbed
gateway. Mostly about telling a person exactly once: seeding, dedupe by run id,
failures that never produced a run, and a gateway that is not answering.

**`server/test/events.test.ts`** — which gateway events are worth waking a phone
for, and which must stay silent.

**`server/test/routers.test.ts`** — the push and feed HTTP endpoints.

**`web/test/wsClient.test.ts`** — socket lifecycle against a controllable mock.
Note that `MockSocket.close()` fires `onclose` asynchronously, as a browser
does; a synchronous mock hides ordering bugs in code that closes a socket and
immediately replaces it.

**`web/test/sessionStore.test.ts`** — gateway events folded into a transcript.
Session isolation, queueing mid-turn, rewinding, and resync after a drop.

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

**`web/test/push.test.ts` / `apiClient.test.ts` / `uiStore.test.ts` /
`sessionTags.test.ts`** — browser-side push state, REST error shaping, theme
resolution and persistence, tag parsing.

## Not covered

Whole-screen rendering. The screens are thin over the stores and the API layer,
both of which are tested directly, so a render test of one would mostly assert
that JSX exists. The components that *are* rendered here earn it by owning
behaviour of their own — a focus trap, a live region, a modal that must not be
escapable.
