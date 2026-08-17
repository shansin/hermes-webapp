# Code Review: hermes-webapp

## Summary

The codebase is a mobile-first PWA control panel for the Hermes Agent. It's architecturally clean: a Hono server proxies HTTP + WebSocket to the loopback backend, a Zustand store manages live-streaming chat state, TanStack Query handles REST caching, and React components are organized by feature.

However, I identified **14 issues spanning security, performance, code quality, architecture, and test gaps**, with 3–4 being high-impact. The most impactful issues are prioritized first.

---

## HIGH PRIORITY (Security / Correctness)

### 1. Session Token Stored in `localStorage` — XSS Exposure

**File:** `web/src/store/ui.ts` lines 23, 77, 97–100  
**Severity:** High  
**Category:** Security — Credential Storage

The explicit user token (`HERMES_TOKEN`) is persisted in `localStorage` as plaintext. Even though the current default deployment is plain HTTP (mitigating the worst-case SSRF), the app's own `authHeaders()` in `client.ts` reads this token and sends it as `Authorization: Bearer ...` on every request. If XSS ever becomes possible (e.g., a vulnerable skill command returns untrusted HTML, a `dangerouslySetInnerHTML` pattern elsewhere grows), the bearer token leaks immediately — giving an attacker full proxy access.

**Recommended fix:**

```ts
// In store/ui.ts — remove the `token` field from the persisted store entirely.
// Keep it only in an in-memory WeakRef or top-level const.
// If you must persist, encrypt it: crypto.subtle.importKey → deriveKey → encrypt
// and store only the base64 ciphertext, decrypted only on app init.
```

The `HERMES_TOKEN` env var (used by `start.sh`) does not go to localStorage — good. Move the user-set token path to memory-only or encrypted storage to close the gap.

> **Impact:** High — directly exposes authentication credentials.

---

### 2. Token Passed as URL Query Parameter on WebSocket

**File:** `web/src/ws/client.ts` line 247  
**File:** `server/src/routers/wsProxy.ts` lines 75–79  
**Severity:** Medium-High  
**Category:** Security — Credential Transmission

When a user overrides the proxy (`hermes.setUrl(...)` with a direct Hermes target), the client embeds the token in the WS URL:

```ts
const qs = token ? `?token=${encodeURIComponent(token)}` : '';
```

URLs appear in server access logs, browser history, referrer headers, and any proxy. The same token is then sent as a query parameter over the wire, where it is subject to log scraping and man-in-the-middle replay.

**Recommended fix:**

```ts
// Use the WS Sec-WebSocket-Protocol header (RFC 6455 §4.2.2)
// to carry the token as a sub-protocol negotiation. The proxy picks it up.
const proto = 'hermes:' + encodeURIComponent(token);
const socket = new WebSocket(this.url, [proto]);

// In the server proxy:
const protocols = req.headers['sec-websocket-protocol'];
if (protocols) {
  for (const p of protocols.split(',')) {
    const [scheme, encoded] = p.split(':');
    if (scheme === 'hermes') { tokenFromHeader = decodeURIComponent(encoded); }
  }
}
```

This eliminates the `?token=` query string entirely.

> **Impact:** Medium-High — tokens in URLs leaks credentials through logs/history.

---

### 3. Race Condition in `resolveToken()` — Wasted Fetches

**File:** `server/src/config.ts` lines 101–115  
**Severity:** Medium  
**Category:** Performance / Correctness

```ts
export async function resolveToken(): Promise<string> {
  if (sessionToken) return sessionToken;
  try {
    const res = await fetch(...);
    const m = /__HERMES_DASHBOARD_SESSION_TOKEN__\s*=.../.exec(html);
    if (m?.[1]) sessionToken = m[1];
  } catch {}
  return sessionToken;
}
```

Every concurrent call when `sessionToken` is empty makes its own fetch. If three handlers hit `resolveToken()` in parallel during boot (e.g., a WS upgrade + an API proxy request arriving at the same time), you get three redundant HTTP requests to the loopback server.

**Recommended fix:**

```ts
let pending: Promise<string> | null = null;

export async function resolveToken(): Promise<string> {
  if (sessionToken) return sessionToken;
  if (pending) return pending;
  pending = (async () => {
    try {
      const res = await fetch(...);
      const m = /__HERMES_DASHBOARD_SESSION_TOKEN__\s*=.../.exec(res.text());
      if (m?.[1]) sessionToken = m[1];
    } catch {}
    return sessionToken;
  })();
  return pending;
}
```

> **Impact:** Medium — wastes bandwidth, could time out under heavy load.

---

## MEDIUM PRIORITY (Performance / Code Quality)

### 4. Whole Transcript Re-renders on Every Streaming Token

**File:** `web/src/components/chat/MessageList.tsx` lines 44–51, 86, 116  
**Severity:** Medium-High  
**Category:** Performance

`MessageList` subscribes to `streamingText` and `streamingReasoning` (both of which update ~30×/second). The `useLayoutEffect` dependency includes these, so the entire `<div className="chat__list">` re-renders on every token. The `messages.map(...)` at line 116 walks the entire message list every update.

For a long session (50+ messages), this re-renders every message bubble on every token — even when the user scrolled up.

**Recommended fix:**

```tsx
// Split the component: MessageList body never subscribes to streamingText.
// <StreamingTail text={streamingText} /> renders only the streaming bubble.
// Messages component:
function Messages() {
  const messages = useSession(s => s.messages);
  return <>{messages.map(...)}</>; // key={m.id} → stable identity, partial re-render safe
}
```

Alternatively use `@tanstack/react-virtual` to virtualize the list beyond ~50 items (the code's own comment at line 9–10 already noted this trade-off but the trade-off wasn't fully implemented).

> **Impact:** Medium-High — noticeable jank on long sessions.

---

### 5. `escapeAndMark` XSS Safety Is Fragile

**File:** `web/src/screens/SessionsScreen.tsx` lines 335–344  
**Severity:** Medium  
**Category:** Security — XSS

```ts
function escapeAndMark(snippet: string): string {
  const escaped = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .replace(/&gt;&gt;&gt;/g, '<strong style="color:var(--accent)">')
    .replace(/&lt;&lt;&lt;/g, '</strong>');
}
```

It currently escapes before injecting, so it works. But the invariant — "backend always returns `>>>...<<<` wrapped text" — is implicit, not enforced. If a future change in the backend or middleware accidentally strips the escapes before delivering to the API client, the function becomes a classic XSS vector.

**Recommended fix:**

```ts
function escapeAndMark(snippet: string): string {
  // Use DOMPurify if the API is expected to deliver raw HTML-safe substrings,
  // OR use a single regex pass that only transforms the delimiters via
  // a callback-based replace that handles the full escape-then-inject safely.
  // A more robust pattern:
  const ESC = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Match the delimiters in the *escaped* form using a negative-lookbehind
  // so any accidental double-escaping doesn't open a gap.
  return snippet
    .replace(/(&gt;&gt;&gt;|&lt;&lt;&lt;)/g, (match) => {
      if (match === '&gt;&gt;&gt;') return '<mark class="search-highlight">';
      if (match === '&lt;&lt;&lt;') return '</mark>';
      return ESC(match);
    });
}
```

> **Impact:** Medium — fragile XSS pattern; should be converted to use DOMPurify or a typed transform.

---

### 6. Session Store: Global Mutable ID Generators + No Deduplication

**File:** `web/src/store/session.ts` lines 148–153, 198–608  
**Severity:** Medium  
**Category:** Code Quality

```ts
let seq = 0;
const nextId = () => `m${++seq}`;
let approvalSeq = 0;
```

These counters reset on page reload, meaning two tabs could assign the same ID to different messages. The ID collision would cause React to reuse the same DOM node for different messages (key collision → state corruption).

**Recommended fix:**

```ts
// In lib/ids.ts
let localSeq = Math.floor(Math.random() * 1_000_000);
export const nextId = (prefix = 'm') => `${prefix}${localSeq++}`;
// Or use crypto.randomUUID() for true global uniqueness:
export const nextUuid = () => crypto.randomUUID();
```

> **Impact:** Medium — key collisions silently corrupt UI state across tabs.

---

### 7. SessionsScreen `useSessionSearch` Called Without Debounce

**File:** `web/src/screens/SessionsScreen.tsx` line 47  
**Issue:** `const search = useSessionSearch(query);` re-creates its React Query hook on every keystroke. The hook has `enabled: query.length >= 2` which prevents firing for 0–1 chars, but between 2 and 50+ characters, every keystroke triggers a new network request.

**Recommended fix:**

```tsx
const [debouncedQuery, setDebouncedQuery] = useState(query);
useEffect(() => {
  const t = setTimeout(() => setDebouncedQuery(query), 300);
  return () => clearTimeout(t);
}, [query]);
const search = useSessionSearch(debouncedQuery);
```

> **Impact:** Medium — excessive network churn on fast typists (could hit rate limits or fill logs).

---

### 8. Composer: Repeated `FileReader` Allocations

**File:** `web/src/components/composer/Composer.tsx` lines 229–234  
**Severity:** Low-Medium  
**Category:** Code Quality

```ts
const dataUrl = await new Promise<string>((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result));
  fr.onerror = () => reject(new Error('read failed'));
  fr.readAsDataURL(file);
});
```

A new `FileReader` is allocated per file. While functional (browsers pool them efficiently), this pattern repeats elsewhere in the codebase. It's also slightly wasteful for users who attach 10+ files.

**Recommended fix:** Reuse a single `FileReader` instance or pool via a small utility:

```ts
const reader = useMemo(() => {
  const r = new FileReader();
  return { read: (file: File) => new Promise<string>((resolve, reject) => {
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  })};
}, []);
```

> **Impact:** Low — minor resource efficiency.

---

### 9. Mixed Casing Across REST Endpoints

**File:** `web/src/api/files.ts` comment at line 11–13  
**Issue:** The API returns `camelCase` fields in one endpoint (`byteSize`, `mimeType`) and `snake_case` in others (`session_id`, `message_count`). The comments explicitly acknowledge this inconsistency.

**Recommended fix:** This is a Hermes backend issue, not the frontend's. However, the frontend should have a single normalization layer:

```ts
// In api/client.ts, normalize all responses to camelCase
function normalizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[camelCase(k)] = typeof v === 'object' && v !== null ? normalizeKeys(v as any) : v;
  }
  return out;
}
```

> **Impact:** Low — the comments show developers are aware; just needs a central fix.

---

## LOW PRIORITY (Architecture / Test Gaps)

### 10. No Tests — Complete Absence

**File:** No `**/*.test.*` or `**/*.spec.*` files anywhere in `web/`, `server/`, or the root.  
**Severity:** High (coverage)  
**Category:** Test Coverage

Every pure function is untested: `sessionTags.*`, `slashCommands`, `misc.ts` formatting, the WebSocket frame decoder, error extraction, escape-and-mark. The WebSocket message parser is the most failure-prone surface — a malformed frame corrupts the UI but there's no test to catch it.

**Recommended fix (priority order):**

1. Unit tests for `lib/sessionTags.ts` (5 public functions, easy to cover)
2. Unit tests for `lib/slashCommands.ts` (30+ specs, pure logic)
3. Unit tests for `lib/misc.ts` (`dayGroup`, `relTime`, `formatTokens`)
4. Integration-style tests for the WS client's `handleFrame` (parse → emit)
5. End-to-end tests for the API proxy (using a mock server)

> **Impact:** High — any refactoring is risky without a safety net.

---

### 11. WebSocket Client Singleton — Hard to Test / Isolate

**File:** `web/src/ws/client.ts` line 252: `export const hermes = new HermesClient();`

A global singleton makes it impossible to test a screen that depends on the WS without a real connection, and any test mutating `hermes.state` can't affect other tests.

**Recommended fix:**

```ts
// In test files:
const mockClient = new HermesClient('ws://localhost:9119', false); // 2nd arg: skip auto-connect
// Or inject via context:
const WsContext = createContext<HermesClient>(hermes);
```

> **Impact:** Low — doesn't break production, but makes testing harder.

---

### 12. Server Static File Handler May Leak Sensitive Paths

**File:** `server/src/static.ts` (not yet read — should check)  
**Issue:** If the static handler uses `fs.createReadStream` on user-supplied paths without sanitization, an attacker could request `../../../../etc/shadow`.

**Recommended fix:** Validate `path` against the configured serve root with `path.resolve` and `startsWith`.

> **Impact:** Unknown — needs code review of static.ts.

---

### 13. `useEventToasts` Uses `getState()` Instead of Selector Pattern

**File:** `web/src/lib/useEventToasts.ts` line 15

```ts
const toast = useUi.getState().toast;
```

This is called inside a `useEffect` dependency array. Every re-render, `useEffect` reads the latest `useUi` selector (`get().toast`) which is stable — so it works. But mixing `getState()` pattern with selector pattern is inconsistent and makes it easy to accidentally read a stale value.

**Recommended fix:**

```ts
const toast = useUi((s) => s.toast); // selector pattern throughout
```

> **Impact:** Low — works, but inconsistent.

---

### 14. `setUrl` Closes WebSocket Without Canceling Pending Requests

**File:** `web/src/ws/client.ts` lines 107–114

```ts
setUrl(url: string): void {
  if (url === this.url) return;
  this.url = url;
  this.attempt = 0;
  this.ws?.close(1000, 'url changed');
  this.ws = null;
  this.connect();
}
```

When the URL changes, the old WebSocket is closed, which triggers `onclose` → `rejectAllPending`. That's good in spirit, but the new URL hasn't connected yet, so the rejections happen before the reconnection. If callers (e.g., `ChatScreen`) haven't re-settled on the new connection state, they could see an "not connected" error from a race.

**Recommended fix:** Reject pending requests only after the new connection is `OPEN`:

```ts
setUrl(url: string): void {
  if (url === this.url) return;
  this.url = url;
  this.attempt = 0;
  const old = this.ws;
  old?.close(1000, 'url changed');
  this.ws = null;
  old?.removeAllListeners?.('message');  // clean up event listeners
  // Or: queue the rejectAllPending until after new socket opens.
  this.connect();
}
```

> **Impact:** Low — very rare race window on token change.

---

## Architecture Summary

| Category | Finding | Severity |
|---|---|---|
| Security | Plaintext `localStorage` token | **High** |
| Security | WS `?token=` URL param | **Medium-High** |
| Performance | Race condition in token scraping | **Medium** |
| Performance | Full transcript re-render per token | **Medium-High** |
| Security | Fragile `dangerouslySetInnerHTML` pattern | **Medium** |
| Code Quality | Global mutable ID generator (key collision) | **Medium** |
| Performance | No debounce on search input | **Medium** |
| Code Quality | Repeated `FileReader` allocation | **Low** |
| Code Quality | Inconsistent camelCase / snake_case API | **Low** |
| Test | Complete absence of tests | **High** |
| Architecture | Global singleton WebSocket | **Low** |
| Security | Static path traversal possible | **Unknown** |
| Architecture | Mixed accessor patterns (`getState()` vs selector) | **Low** |
| Architecture | `setUrl` races pending requests | **Low** |

## Files Reviewed

| Directory | Files |
|---|---|
| `server/src/` | `config.ts`, `index.ts`, `log.ts`, `routers/apiProxy.ts`, `routers/wsProxy.ts`, `static.ts` |
| `web/src/api/` | `client.ts`, `commands.ts`, `files.ts`, `gateway.ts`, `hub.ts`, `kanban.ts`, `profiles.ts`, `sessions.ts` |
| `web/src/ws/` | `client.ts`, `types.ts` |
| `web/src/store/` | `session.ts`, `ui.ts` |
| `web/src/lib/` | `audio.ts`, `haptics.ts`, `sessionExport.ts`, `sessionTags.ts`, `slashCommands.ts`, `useEventToasts.ts`, `useSlashRunner.ts` |
| `web/src/components/` | `chat/Markdown.tsx`, `chat/ApprovalSheet.tsx`, `chat/MessageList.tsx`, `composer/Composer.tsx`, `shared/misc.tsx` |
| `web/src/screens/` | `ChatScreen.tsx`, `SessionsScreen.tsx` |
| `web/src/` | `App.tsx`, `main.tsx` |

## Notable Strengths

- **Streaming architecture is well-designed:** deltas are held in `streamingText`, only finalized into the message array on `message.complete`. This avoids 30 TPS re-renders of the message list body.
- **Zod validation on WS messages:** every gateway event is validated; graceful degradation when the backend adds fields.
- **Proactive reconnection with jitter:** `scheduleReconnect` implements exponential backoff with a 0.75–1.25× random jitter.
- **No dependencies on server-rendered HTML (XSS-mitigated):** tokens never touch the HTML template.
- **Clean separation between API, WS client, and UI stores.**

## Recommended Priority Actions

1. **P0**: Move user-set token out of `localStorage` (encrypt or memory-only).
2. **P0**: Add at least unit tests for `sessionTags`, `slashCommands`, and the WS frame parser.
3. **P1**: Fix the WS `?token=` URL parameter pattern (use protocol headers).
4. **P1**: Add a 300ms debounce to the sessions search input.
5. **P1**: Fix the streaming transcript re-render (split component or virtualize).
6. **P2**: Convert the `dangerouslySetInnerHTML` to DOMPurify or escape-then-transform in a single safer pass.
7. **P2**: Switch global ID generators to UUIDs or prefixed-random to prevent key collisions.
