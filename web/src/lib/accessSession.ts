/**
 * Recovering from an expired Cloudflare Access session.
 *
 * When the Access session lapses, the edge stops forwarding requests and
 * answers with a redirect to the Google login instead. Two things conspire to
 * make that invisible to this app:
 *
 *  1. The login page sends no CORS headers, so a cross-origin redirect makes
 *     `fetch` reject with a bare `TypeError` — the same thing an aeroplane-mode
 *     phone produces. `response.redirected` is never observed, because there is
 *     no response. So expiry cannot be detected from the failing call itself.
 *
 *  2. Workbox is configured with `navigateFallback: '/index.html'`, so a plain
 *     reload is served the cached shell straight out of the service worker and
 *     never reaches the network. The app boots, every call fails again, and it
 *     looks broken rather than logged out.
 *
 * The way out of (1) is a probe with `redirect: 'manual'`, which surfaces the
 * redirect as an `opaqueredirect` response instead of following it — observable,
 * and it never trips CORS. The way out of (2) is the `?cf_login=` marker, which
 * `vite.config.ts` lists in `navigateFallbackDenylist` so the navigation is
 * passed through to the network where Access can act on it.
 */

type Handler = () => void;
const handlers = new Set<Handler>();

/** Latched: once expired, the app stays in that state until it navigates away. */
let expired = false;
let probing: Promise<boolean> | null = null;

/**
 * Whether this device can reach the origin at all — a separate question from
 * whether the session is still valid, and the app was previously unable to ask
 * it.
 *
 * A failing DNS resolver produces a rejected `fetch` and a WebSocket that dies
 * in milliseconds, which is exactly what a dead backend produces, so the app
 * said "Reconnecting…" and left the person to guess. `navigator.onLine` does
 * not help: it stayed `true` through four separate total-resolution failures
 * that were traced to the client's own resolver handing back empty answers.
 *
 * The signal that does separate them is already here — a probe that *throws*
 * never reached Cloudflare, while one that returns any response at all did. So
 * repeated throws mean the problem is on this side of the network and no
 * amount of waiting on Hermes will fix it.
 *
 * Unlatched, unlike `expired`: the network comes back on its own and the app
 * recovers with it, so this has to clear itself the moment a probe lands.
 */
let unreachable = false;
let networkFailures = 0;
const reachabilityHandlers = new Set<(unreachable: boolean) => void>();

/**
 * Throws in a row before we say so out loud.
 *
 * One is a blip — a socket dropped mid-flight, a radio changing cells — and
 * saying "check your network" for every one of those would train the person to
 * ignore the banner that matters. Two consecutive probes span at least one
 * reconnect backoff step, by which point a real outage is still failing and a
 * blip has already recovered.
 */
const UNREACHABLE_AFTER = 2;

export function onAccessExpired(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function isAccessExpired(): boolean {
  return expired;
}

/** Subscribe to reachability changes. Fires only when the answer flips. */
export function onHostReachabilityChange(handler: (unreachable: boolean) => void): () => void {
  reachabilityHandlers.add(handler);
  return () => reachabilityHandlers.delete(handler);
}

export function isHostUnreachable(): boolean {
  return unreachable;
}

function setUnreachable(next: boolean): void {
  if (unreachable === next) return;
  unreachable = next;
  for (const handler of reachabilityHandlers) handler(next);
}

/**
 * Something reached the origin, so this device's network is working.
 *
 * A probe that came back at all — whatever it said — proves the path is up:
 * even a 401 or a redirect to the login page had to travel the whole way to
 * Cloudflare and back to exist.
 *
 * Exported because the probe is *not* the only such proof, and relying on it
 * alone was a bug. Probes only run while a reconnect is failing or a REST call
 * is rejecting; the moment the socket comes back, both stop happening, so
 * nothing was left to clear the flag and the banner stayed up over a perfectly
 * working app. A gateway socket completing its handshake is the strongest
 * evidence available that the host is reachable, and `ws/client.ts` reports it
 * here.
 */
export function markHostReached(): void {
  networkFailures = 0;
  setUnreachable(false);
}

function markNetworkFailure(): void {
  networkFailures++;
  if (networkFailures >= UNREACHABLE_AFTER) setUnreachable(true);
}

function markExpired(): void {
  if (expired) return;
  expired = true;
  for (const handler of handlers) handler();
}

/**
 * Ask whether Access — rather than the network, or the proxy — is what just
 * refused us.
 *
 * `/healthz` is the probe target because the proxy exempts it from its own gate
 * (see `server/src/auth.ts`), which makes the answer unambiguous: reaching it
 * means we are past the edge and the session is fine, so a failure here is
 * about the edge and nothing else. Single-flighted, because a screen full of
 * queries all failing at once would otherwise probe once each.
 */
/**
 * The proxy's own gate answered 401.
 *
 * This needs no probe and must not use one: `/healthz` is deliberately exempt
 * from the gate, so probing it returns a cheerful 200 while every real call is
 * being refused — which is exactly how a gated origin reached directly (over
 * Tailscale, say, carrying no Access assertion) ends up looking like a healthy
 * server to a permanently reconnecting app.
 */
export function markAccessRefused(): void {
  markExpired();
}

export function probeAccess(): Promise<boolean> {
  if (expired) return Promise.resolve(true);
  if (probing) return probing;

  probing = (async () => {
    try {
      const res = await fetch('/healthz', { redirect: 'manual', cache: 'no-store' });
      // Any response at all means the round trip completed, so whatever else is
      // wrong, this device's own network is not it.
      markHostReached();
      // status 0 + opaqueredirect is the edge bouncing us to the login page.
      if (res.type === 'opaqueredirect') {
        markExpired();
        return true;
      }
      // Belt and braces: if the gate is ever configured to answer XHR with a
      // status instead of a redirect, take that as expiry too.
      if (res.status === 401) {
        markExpired();
        return true;
      }
      return false;
    } catch {
      // A genuine network failure. Not expiry — but after enough of them in a
      // row it is worth saying which side of the wire the fault is on, rather
      // than leaving "Reconnecting…" to imply the agent is down.
      markNetworkFailure();
      return false;
    } finally {
      probing = null;
    }
  })();

  return probing;
}

/**
 * Hand the browser back to Access so it can run the Google sign-in.
 *
 * This has to be a top-level navigation, not a `fetch` — the login flow is a
 * sequence of cross-origin redirects that only the address bar can follow. The
 * `cf_login` marker is what keeps the service worker from answering it out of
 * the precache; it is stripped again by `App.tsx` once the app reloads, so it
 * never lingers in the URL the user sees.
 */
export function goToAccessLogin(): void {
  const url = new URL(window.location.href);
  url.searchParams.set('cf_login', String(Date.now()));
  window.location.assign(url.toString());
}

/** Drop the marker after a successful return, without touching history depth. */
export function stripLoginMarker(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('cf_login')) return;
  url.searchParams.delete('cf_login');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}
