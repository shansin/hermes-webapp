/**
 * The proxy's own connection to the Hermes gateway, held open for push.
 *
 * `wsProxy` is a per-client relay: it opens an upstream socket when a phone
 * connects and closes it when the phone leaves. That is exactly wrong for
 * push, whose entire purpose is delivery while nothing is connected — so this
 * module keeps one socket of its own for the lifetime of the process.
 *
 * It listens on `/api/ws`, the same gateway endpoint the browser uses, rather
 * than `/api/events`. The frame format there is known and already relied on by
 * the app (newline-delimited JSON-RPC, events as `method: "event"`), so the
 * two notification paths cannot drift apart in what they understand.
 */
import { WebSocket } from 'ws';

import { getToken, resolveToken, upstreamWs, upstreamHost } from '../config.js';
import { log } from '../log.js';
import { sendPush, pushEnabled, type PushMessage } from './send.js';
import { listSubscriptions } from './store.js';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
/**
 * The gateway is quiet for hours at a time and a NAT or a sleeping laptop will
 * drop an idle socket without telling either end. Ping on an interval and hang
 * up if a pong doesn't come back, so a dead link reconnects instead of sitting
 * there looking open and delivering nothing.
 */
const PING_INTERVAL_MS = 30_000;
const PONG_GRACE_MS = 10_000;

let socket: WebSocket | null = null;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let pongTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

export function startPushListener(): void {
  if (!pushEnabled()) {
    log.info('Push disabled — not opening a listener socket.');
    return;
  }
  stopped = false;
  void connect();
}

export function stopPushListener(): void {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearHeartbeat();
  socket?.close(1000, 'shutting down');
  socket = null;
}

function clearHeartbeat(): void {
  if (pingTimer) clearInterval(pingTimer);
  if (pongTimer) clearTimeout(pongTimer);
  pingTimer = null;
  pongTimer = null;
}

async function connect(): Promise<void> {
  if (stopped) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const token = getToken() || (await resolveToken());
  if (stopped) return;

  const target = `${upstreamWs}/api/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const ws = new WebSocket(target, {
    // Same loopback disguise wsProxy needs; Hermes refuses the upgrade without
    // it. See the comment at the top of routers/wsProxy.ts.
    headers: { host: upstreamHost, origin: `http://${upstreamHost}` },
    // We only read small notification frames here — a history replay is never
    // requested on this socket, so the proxy's 512 MiB ceiling is unnecessary.
    maxPayload: 8 * 1024 * 1024,
  });
  socket = ws;

  ws.on('open', () => {
    attempt = 0;
    log.info('Push listener connected to the Hermes gateway.');
    clearHeartbeat();
    pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // If this fires before the pong lands, the link is gone in a way the
      // socket has not noticed. Terminate rather than close: a half-open TCP
      // connection will not complete a closing handshake.
      pongTimer = setTimeout(() => ws.terminate(), PONG_GRACE_MS);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, PING_INTERVAL_MS);
  });

  ws.on('pong', () => {
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = null;
  });

  ws.on('message', (raw) => {
    // One WS message may batch several newline-delimited JSON-RPC frames.
    for (const line of raw.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) handleFrame(trimmed);
    }
  });

  ws.on('close', (code) => {
    clearHeartbeat();
    if (socket === ws) socket = null;
    if (stopped) return;
    // 4403 is Hermes rejecting the upgrade — usually a stale token. Reconnect
    // anyway: `resolveToken` re-scrapes on the next attempt.
    log.debug(`Push listener socket closed (${code}); reconnecting.`);
    scheduleReconnect();
  });

  ws.on('error', () => {
    // 'close' always follows; the reconnect is handled there.
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer || stopped) return;
  const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  // Jitter, so a Hermes restart doesn't get a synchronised retry from every
  // proxy that was watching it.
  const delay = backoff * (0.75 + Math.random() * 0.5);
  attempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
  // Never hold the process open just to wait for a reconnect.
  reconnectTimer.unref?.();
}

function handleFrame(line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  const frame = parsed as { method?: unknown; params?: unknown };
  if (frame.method !== 'event' || !frame.params || typeof frame.params !== 'object') return;

  const params = frame.params as { type?: unknown; session_id?: unknown; payload?: unknown };
  if (typeof params.type !== 'string') return;

  // Cheap early-out: composing a message and signing a payload is wasted work
  // on a machine nobody has ever installed the app from.
  if (!listSubscriptions().length) return;

  const message = toMessage(
    params.type,
    (params.payload ?? {}) as Record<string, unknown>,
    typeof params.session_id === 'string' ? params.session_id : null,
  );
  if (!message) return;

  void sendPush(message).catch((err) => log.warn({ err }, 'Push fan-out failed'));
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Map a gateway event to a notification, or null to stay silent.
 *
 * Deliberately the same four event types `useEventToasts` handles, plus
 * `approval.request` — an approval blocks the agent until it is answered, so
 * it is the one event where a banner on a locked phone is the difference
 * between a turn finishing and a turn sitting there all afternoon.
 *
 * Everything else the gateway emits (token deltas, tool starts, status lines)
 * is firehose traffic that belongs on screen, never on a lock screen.
 */
function toMessage(
  type: string,
  payload: Record<string, unknown>,
  sessionId: string | null,
): PushMessage | null {
  const chatUrl = sessionId ? `/chat?session=${encodeURIComponent(sessionId)}` : '/chat';

  switch (type) {
    case 'background.complete': {
      const label = str(payload.title) ?? 'Background task';
      return { title: 'Hermes', body: `${label} finished`, url: chatUrl, tag: 'background', kind: type };
    }

    case 'subagent.complete': {
      const name = str(payload.name) ?? 'Subagent';
      return { title: 'Hermes', body: `${name} finished`, url: chatUrl, tag: 'subagent', kind: type };
    }

    case 'notification.show': {
      const text = str(payload.text) ?? str(payload.message);
      if (!text) return null;
      return { title: 'Hermes', body: text, url: chatUrl, tag: 'notification', kind: type };
    }

    case 'cron.changed':
      return {
        title: 'Hermes',
        body: 'A scheduled job ran',
        url: '/cron',
        tag: 'cron',
        kind: type,
      };

    case 'approval.request': {
      const tool = str(payload.tool) ?? str(payload.name) ?? 'A tool';
      const detail = str(payload.command) ?? str(payload.description) ?? '';
      return {
        title: 'Approval needed',
        body: detail ? `${tool} — ${detail}`.slice(0, 160) : `${tool} is waiting for approval`,
        url: chatUrl,
        // Not collapsed with the others: replacing a pending approval with a
        // "task finished" banner would hide the one thing that needs an answer.
        tag: `approval:${sessionId ?? 'default'}`,
        kind: type,
      };
    }

    default:
      return null;
  }
}
