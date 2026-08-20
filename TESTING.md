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

**`web/test/push.test.ts` / `apiClient.test.ts` / `uiStore.test.ts` /
`sessionTags.test.ts`** — browser-side push state, REST error shaping, theme
resolution and persistence, tag parsing.

## Not covered

React component rendering. The screens are thin over the stores and the API
layer, both of which are tested directly; adding render tests would mostly
assert that JSX exists.
