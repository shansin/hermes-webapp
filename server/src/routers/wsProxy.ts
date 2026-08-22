/**
 * WebSocket proxy for the Hermes JSON-RPC gateway.
 *
 * Browsers cannot set headers on a WebSocket handshake, so the client passes
 * the token as `?token=…` — which is also exactly what Hermes' loopback WS auth
 * expects, so we forward it as a query parameter rather than a header.
 *
 * The part that actually matters is the **Origin/Host rewrite**. Hermes runs
 * `_ws_host_origin_reason()` before accepting an upgrade:
 *
 *   - `Host` must match the bound interface (`127.0.0.1:9119`), and
 *   - if `Origin` is present, its netloc must match too.
 *
 * A phone connecting to `ws://192.168.1.50:3000/api/ws` sends
 * `Origin: http://192.168.1.50:3000`, which fails that check. We therefore open
 * the upstream socket with both headers pinned to the loopback address.
 *
 * Frames are relayed verbatim in both directions — the gateway speaks
 * newline-delimited JSON-RPC and we deliberately do not parse or reframe it.
 */
import { WebSocketServer, WebSocket, type RawData } from 'ws';

/** Session history replays and file attachments can be large. */
const MAX_PAYLOAD = 512 * 1024 * 1024;

/**
 * How much may queue for a socket before we treat the peer as unable to keep
 * up. Reached only if a client stops reading mid-stream; dropping the bridge
 * is better than growing the send buffer until the process dies.
 */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

/**
 * Frames a client may send before the upstream socket finishes opening. The
 * window is milliseconds on loopback, so anything past a handful means the
 * peer is not waiting for a reply — and the buffer was previously unbounded.
 */
const MAX_PENDING_FRAMES = 64;

/**
 * How often to ping the browser.
 *
 * The gateway socket is idle between turns — often for a very long time — and
 * an idle proxied WebSocket gets closed at 100s by Cloudflare, which is the
 * whole path in the published deployment. The browser then reconnects, so
 * nothing breaks, but the app spends its life flashing "Reconnecting…".
 *
 * A ping is protocol-level: the browser answers it automatically, no script
 * involved, and either frame is enough traffic to keep the connection from
 * looking idle. `push/events.ts` already does exactly this for the proxy's own
 * upstream socket and for the same underlying reason — an idle socket gets
 * dropped by something in the middle without telling either end.
 *
 * 45s leaves room for one ping to go missing before the 100s ceiling.
 */
const CLIENT_PING_INTERVAL_MS = 45_000;
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { getToken, resolveToken, upstreamWs, upstreamHost, accessEnabled } from '../config.js';
import { verifyAccess, nodeHeaders } from '../auth.js';
import { log } from '../log.js';

/** Paths the Hermes backend exposes as WebSockets and we forward as-is. */
const WS_PATHS = new Set(['/api/ws', '/api/events', '/api/pub', '/api/audio/speak-stream']);

export function isProxiedWsPath(pathname: string): boolean {
  return WS_PATHS.has(pathname);
}

/**
 * Attach the upgrade handler to a Node HTTP/HTTPS server.
 *
 * `noServer: true` lets us decide per-path whether to handle the upgrade,
 * leaving anything else (Vite HMR in dev, say) untouched.
 */
export function attachWsProxy(server: {
  on(event: 'upgrade', cb: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void;
}): void {
  // Same ceiling as the upstream socket below. Left at ws's 100 MiB default,
  // a history replay between 100 and 512 MiB would pass the upstream limit and
  // then kill the client socket on the way out.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  /** Live bridges, so the log can tell churn from concurrency. */
  let open = 0;

  server.on('upgrade', async (req, socket, head) => {
    let pathname: string;
    let search: string;
    try {
      const parsed = new URL(req.url ?? '/', 'http://localhost');
      pathname = parsed.pathname;
      search = parsed.search;
    } catch {
      socket.destroy();
      return;
    }

    if (!isProxiedWsPath(pathname)) {
      socket.destroy();
      return;
    }

    // This handler sits on the raw Node server: Hono never sees an upgrade, so
    // `requireAccess` cannot cover it. Without this check the REST surface
    // would be gated while the gateway socket — which is the one that actually
    // drives the agent — stayed open to anyone.
    //
    // A browser cannot set `Cf-Access-Jwt-Assertion` on a handshake, but
    // cloudflared injects it on the way through and the same-origin
    // `CF_Authorization` cookie rides along regardless; `extractToken` takes
    // either.
    /**
     * Cloudflare's per-request id, carried through so a client-side capture and
     * this log can be joined on it.
     *
     * Correlating the two by timestamp does not work: the phone, the laptop and
     * this machine are each a few tens of milliseconds off one another, which is
     * enough to make a socket look like it existed before the bridge that
     * carried it. `cf-ray` is the same string on both sides and needs no clocks.
     * Absent on a request that did not come through the tunnel, which is itself
     * worth seeing — it means something reached the proxy without passing the
     * edge.
     */
    const cfRay = req.headers['cf-ray'];
    const ray = typeof cfRay === 'string' ? cfRay : undefined;

    if (accessEnabled) {
      const result = await verifyAccess(nodeHeaders(req.headers));
      if (!result.ok) {
        log.warn({ pathname, ray, reason: result.reason }, 'websocket upgrade refused');
        // Answer before hanging up. A bare destroy() is a TCP reset, which the
        // browser reports as close code 1006 — identical to the network being
        // down, and the client would retry it forever.
        const status = result.reason === 'forbidden' ? '403 Forbidden' : '401 Unauthorized';
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      // One line per socket — the app opens one for its lifetime, so this is
      // not chatty. It exists because a *successful* upgrade used to log
      // nothing at all, which makes silence in the log ambiguous: a client
      // that never reached the proxy and a client being served perfectly look
      // identical from here, and telling them apart is most of the work when
      // something in front of the proxy is misbehaving.
      open++;
      log.info({ pathname, open, ray }, 'websocket bridged');
      const since = Date.now();
      client.once('close', (code) => {
        open--;
        // Duration and the live count are what separate "one client is
        // reconnecting in a loop" from "several tabs are open" — which look
        // identical if you only log the opens.
        log.info(
          {
            pathname,
            open,
            ray,
            code,
            seconds: Math.round((Date.now() - since) / 1000),
          },
          'websocket closed',
        );
      });
      bridge(client, pathname, search);
    });
  });

  log.info({ paths: [...WS_PATHS] }, 'websocket proxy attached');
}

/**
 * Bridge one client socket to a fresh upstream one.
 *
 * Deliberately synchronous, even though opening the upstream leg needs a token
 * that may still have to be discovered. The browser sends its first RPC the
 * instant `onopen` fires — that is what the app's `connect()` does — so any
 * `await` before the client's `message` handler is attached is a window in
 * which those frames arrive at a socket nobody is listening to and are dropped
 * on the floor. On a cold boot, where the token is scraped out of the Hermes
 * SPA over a real HTTP round trip, that window is the whole handshake, and the
 * app sits on a spinner until its own request timeout fires.
 *
 * So the client's handlers go on first and the pre-open buffer below covers
 * the gap, which is what it was there for in the first place.
 */
function bridge(client: WebSocket, pathname: string, search: string): void {
  // Frames produced before the upstream socket finishes opening would be lost,
  // so hold them until it is ready.
  const pending: RawData[] = [];
  let upstreamOpen = false;
  let upstream: WebSocket | null = null;
  /** Set when the bridge is torn down before the upstream leg ever opened. */
  let abandoned = false;

  const closeBoth = (code: number, reason: string) => {
    // 1005/1006 are "no status" sentinels and are illegal on the wire; so are
    // 1004 and 1015, which are reserved and never sent by an endpoint.
    const safeCode =
      code === 1004 || code === 1005 || code === 1006 || code === 1015 || code < 1000 ? 1011 : code;
    abandoned = true;
    pending.length = 0;
    for (const sock of [client, upstream]) {
      if (!sock) continue;
      if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
        try {
          sock.close(safeCode, reason.slice(0, 120));
        } catch {
          sock.terminate();
        }
      }
    }
  };

  client.on('message', (data, isBinary) => {
    if (!upstream || !upstreamOpen) {
      if (pending.length >= MAX_PENDING_FRAMES) {
        log.warn({ pathname }, 'ws pre-open buffer overflow — dropping bridge');
        closeBoth(1013, 'upstream not ready');
        return;
      }
      pending.push(data);
      return;
    }
    if (upstream.bufferedAmount > MAX_BUFFERED_BYTES) {
      log.warn({ pathname, buffered: upstream.bufferedAmount }, 'upstream backpressure');
      closeBoth(1011, 'upstream backpressure');
      return;
    }
    upstream.send(data, { binary: isBinary });
  });

  /**
   * Whether the browser has answered since the last ping.
   *
   * The keepalive below is also the only thing that can notice a peer that
   * stopped existing. A phone that walks out of radio range never sends a
   * close frame, and TCP will sit on the half-open connection for far longer
   * than anyone waits — so without this the bridge stays "open" forever,
   * holding a Hermes gateway socket with it, and the proxy's own log of live
   * connections quietly stops meaning anything. Reading the count is the first
   * thing anyone does when the app is misbehaving, so it has to be true.
   */
  let alive = true;
  client.on('pong', () => {
    alive = true;
  });

  // Keep the connection from looking idle to whatever sits in the middle.
  // Unconditional rather than gated on the Access config: a home NAT drops idle
  // sockets too, it is two frames a minute, and a keepalive that only runs in
  // one deployment is a keepalive nobody notices has broken in the other.
  const ping = setInterval(() => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      // Two intervals with no pong. A browser answers at the protocol level
      // with no script involved, so silence means the peer is gone rather than
      // busy. `terminate`, not `close`: there is nobody left to complete a
      // closing handshake with, and waiting on one is how the leak starts.
      log.warn({ pathname }, 'client stopped answering pings — dropping bridge');
      clearInterval(ping);
      client.terminate();
      closeBoth(1011, 'client unresponsive');
      return;
    }
    alive = false;
    try {
      client.ping();
    } catch {
      // The close handler is what tears the bridge down; a failed ping just
      // means we got there first.
    }
  }, CLIENT_PING_INTERVAL_MS);
  // `unref` so a live socket cannot hold the process open through shutdown.
  ping.unref?.();

  client.on('close', (code, reason) => {
    clearInterval(ping);
    closeBoth(code, reason.toString());
  });

  client.on('error', (err) => {
    log.debug({ err: err.message, pathname }, 'client ws error');
    closeBoth(1011, 'client error');
  });

  void openUpstream();

  async function openUpstream(): Promise<void> {
    const token = getToken() || (await resolveToken());
    // The phone may have hung up while the token was being discovered.
    if (abandoned || client.readyState === WebSocket.CLOSED) return;

    // Force our own token onto the upstream URL: the browser may send a stale
    // one (or none at all), and the proxy is the component that actually knows
    // it.
    const params = new URLSearchParams(search);
    if (token) params.set('token', token);
    else params.delete('token');
    const query = params.toString();
    const target = `${upstreamWs}${pathname}${query ? '?' + query : ''}`;

    upstream = connectUpstream(target);
  }

  function connectUpstream(target: string): WebSocket {
    const sock = new WebSocket(target, {
      headers: {
        // Both of these must look like loopback or the upgrade is refused with
        // close code 4403. This is the whole reason the proxy exists.
        host: upstreamHost,
        origin: `http://${upstreamHost}`,
      },
      // Session history replays and file attachments can be large.
      maxPayload: MAX_PAYLOAD,
      // `ws` defaults this *on* for clients, unlike the `WebSocketServer`
      // above which defaults it off. So without this the two legs disagreed:
      // frames crossed the browser hop uncompressed, then got deflated to
      // travel 127.0.0.1 and inflated again at the other end — CPU spent
      // compressing for the one hop with no bandwidth to save, on every token
      // of every turn.
      perMessageDeflate: false,
    });

    sock.on('open', () => {
      upstreamOpen = true;
      for (const frame of pending) sock.send(frame);
      pending.length = 0;
      log.debug({ pathname }, 'ws bridge established');
    });

    sock.on('message', (data, isBinary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      // A phone that has stopped reading — backgrounded, or on a stalled radio
      // — must not be allowed to queue the whole stream in this process.
      if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
        log.warn({ pathname, buffered: client.bufferedAmount }, 'client backpressure');
        closeBoth(1011, 'client backpressure');
        return;
      }
      client.send(data, { binary: isBinary });
    });

    sock.on('close', (code, reason) => closeBoth(code, reason.toString()));

    sock.on('error', (err) => {
      log.warn({ err: err.message, pathname, target }, 'upstream ws error');
      closeBoth(1011, 'upstream error');
    });

    return sock;
  }
}
