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
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { getToken, resolveToken, upstreamWs, upstreamHost } from '../config.js';
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
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
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

    wss.handleUpgrade(req, socket, head, (client) => {
      void bridge(client, pathname, search);
    });
  });

  log.info({ paths: [...WS_PATHS] }, 'websocket proxy attached');
}

async function bridge(client: WebSocket, pathname: string, search: string): Promise<void> {
  const token = getToken() || (await resolveToken());

  // Force our own token onto the upstream URL: the browser may send a stale one
  // (or none at all), and the proxy is the component that actually knows it.
  const params = new URLSearchParams(search);
  if (token) params.set('token', token);
  else params.delete('token');
  const query = params.toString();
  const target = `${upstreamWs}${pathname}${query ? '?' + query : ''}`;

  const upstream = new WebSocket(target, {
    headers: {
      // Both of these must look like loopback or the upgrade is refused with
      // close code 4403. This is the whole reason the proxy exists.
      host: upstreamHost,
      origin: `http://${upstreamHost}`,
    },
    // Session history replays and file attachments can be large.
    maxPayload: 512 * 1024 * 1024,
  });

  // Frames produced before the upstream socket finishes opening would be lost,
  // so hold them until it is ready.
  const pending: RawData[] = [];
  let upstreamOpen = false;

  const closeBoth = (code: number, reason: string) => {
    // 1005/1006 are "no status" sentinels and are illegal on the wire.
    const safeCode = code === 1005 || code === 1006 || code < 1000 ? 1011 : code;
    for (const sock of [client, upstream]) {
      if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
        try {
          sock.close(safeCode, reason.slice(0, 120));
        } catch {
          sock.terminate();
        }
      }
    }
  };

  upstream.on('open', () => {
    upstreamOpen = true;
    for (const frame of pending) upstream.send(frame);
    pending.length = 0;
    log.debug({ pathname }, 'ws bridge established');
  });

  client.on('message', (data, isBinary) => {
    if (upstreamOpen) upstream.send(data, { binary: isBinary });
    else pending.push(data);
  });

  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  client.on('close', (code, reason) => closeBoth(code, reason.toString()));
  upstream.on('close', (code, reason) => closeBoth(code, reason.toString()));

  client.on('error', (err) => {
    log.debug({ err: err.message, pathname }, 'client ws error');
    closeBoth(1011, 'client error');
  });

  upstream.on('error', (err) => {
    log.warn({ err: err.message, pathname, target }, 'upstream ws error');
    closeBoth(1011, 'upstream error');
  });
}
