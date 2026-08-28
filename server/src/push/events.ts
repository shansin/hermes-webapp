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
import { scheduleCronReconcile } from './cron.js';
import { flatten } from './preview.js';
import { bindRpcSocket, resolveRpcFrame, rpcPending, unbindRpcSocket } from './rpc.js';
import { scheduleSessionSweep } from './sessions.js';
import {
  FEED_EVENT_TYPES,
  backendCameBack,
  backendWentDown,
  recordGatewayEvent,
  resetBackendWatch,
} from './updates.js';
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
  // Before the close handler runs: a proxy on its way out must not announce
  // that the backend is offline.
  resetBackendWatch();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearHeartbeat();
  // Ahead of the close, which will not reach the branch that does this: the
  // reference is cleared here, so the handler's `socket === ws` is already false.
  unbindRpcSocket();
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
    // Loopback: compressing these frames buys no bandwidth and costs CPU on
    // every delta the firehose carries. See the same note in wsProxy.ts.
    perMessageDeflate: false,
  });
  socket = ws;

  ws.on('open', () => {
    attempt = 0;
    log.info('Push listener connected to the Hermes gateway.');
    // The socket is now also the proxy's way of *asking* the gateway things —
    // `push/sessions.ts` needs `session.active_list`, which has no REST route.
    bindRpcSocket((frame) => ws.send(frame));
    // Silent unless an outage was actually announced — see `updates.ts`.
    backendCameBack();
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
      if (!trimmed) continue;
      /**
       * Answers to our own calls, taken out of the stream before `handleFrame`
       * can drop them. Its substring early-out looks for event *types*, and a
       * response frame contains none of them — so on a machine with no push
       * devices every reply would be discarded and every call would time out
       * against a socket that had already answered. Guarded on there being a
       * call in flight, which is a few milliseconds at a time, so the firehose
       * stays unparsed the rest of the time.
       */
      if (rpcPending()) {
        try {
          if (resolveRpcFrame(JSON.parse(trimmed))) continue;
        } catch {
          // Not JSON at all — the keepalive newline, or a truncated frame.
        }
      }
      handleFrame(trimmed);
    }
  });

  ws.on('close', (code) => {
    clearHeartbeat();
    if (socket === ws) {
      socket = null;
      // Fails everything waiting on this socket rather than leaving a sweep
      // sitting on its own timeout past the reconnect.
      unbindRpcSocket();
    }
    if (stopped) return;
    // Starts the grace timer; a restart that reconnects inside it says nothing.
    backendWentDown();
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

/**
 * Frame types worth parsing even with no push devices registered.
 *
 * `cron.changed` and `sessions.changed` are here as triggers rather than as
 * news: both are session-less "go and look" signals, and both are the only
 * frames of their kind this socket ever sees — see the header of
 * `push/sessions.ts` for why a session's own events never arrive.
 */
const FEED_TYPE_SCAN = ['cron.changed', 'sessions.changed', ...FEED_EVENT_TYPES];

function handleFrame(line: string): void {
  /**
   * Cheap early-out: composing a message and signing a payload is wasted work
   * on a machine nobody has ever installed the app from — and so is parsing
   * the frame that would have fed it. This socket sees the full gateway
   * firehose, token deltas included, so before this sat above the parse the
   * proxy was running `JSON.parse` 30–60×/second through every turn only to
   * discard the result here.
   *
   * The updates feed has to survive that shortcut: it is the record of what
   * happened while nobody was watching, and on a setup with no push devices at
   * all it would otherwise never be written. A substring scan is the
   * compromise — orders of magnitude cheaper than `JSON.parse`, and it fails
   * on the first few bytes of the token deltas that make up the firehose.
   *
   * The scanned set is `cron.changed` plus whatever `updates.ts` writes down,
   * taken from that module rather than repeated here: a type in its switch but
   * missing from this list would simply never reach the feed, with nothing
   * anywhere to say why.
   */
  const subscribed = listSubscriptions().length > 0;
  if (!subscribed && !FEED_TYPE_SCAN.some((type) => line.includes(type))) return;

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

  const payload = (params.payload ?? {}) as Record<string, unknown>;
  const sessionId = typeof params.session_id === 'string' ? params.session_id : null;

  /**
   * Written whether or not a phone is registered, and deliberately ahead of
   * the `subscribed` check below for the same reason `cron.changed` is: the
   * feed is the thing that survives nobody being there to see the banner.
   */
  recordGatewayEvent(params.type, payload, sessionId);

  if (params.type === 'cron.changed') {
    // Nothing in the frame to read — see the note on the `cron.changed` case
    // in `toMessage`. Ask for a look at the run history instead. Deliberately
    // ahead of the `subscribed` check: the feed is written whether or not any
    // phone is registered to be told about it.
    scheduleCronReconcile();
  }

  /**
   * The one signal that reaches here for a conversation. It carries nothing —
   * `_CHANGE_WATCHES` broadcasts it with an empty payload when the sessions
   * table's signature moves — so, exactly like `cron.changed`, it is a request
   * to go and look. Ahead of the `subscribed` check so the sweep's watermarks
   * stay current on a machine with no phone registered yet; without that, the
   * first device to subscribe would be told about a backlog it never missed.
   */
  if (params.type === 'sessions.changed') {
    scheduleSessionSweep();
  }

  if (!subscribed) return;

  const message = toMessage(params.type, payload, sessionId);
  if (!message) return;

  void sendPush(message).catch((err) => log.warn({ err }, 'Push fan-out failed'));
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Map a gateway event to a notification, or null to stay silent.
 *
 * The four types `useEventToasts` handles, plus two the in-app path has no
 * need for:
 *
 *  - `approval.request` and `clarify.request`, because both block the agent
 *    until they are answered, and a phone in a pocket is where that answer has
 *    to come from.
 *  - `message.complete`, because "the agent replied while I was away" is the
 *    single most common reason to want a banner at all.
 *
 * Everything else the gateway emits (token deltas, tool starts, status lines)
 * is firehose traffic that belongs on screen, never on a lock screen.
 */
export function toMessage(
  type: string,
  payload: Record<string, unknown>,
  sessionId: string | null,
): PushMessage | null {
  const chatUrl = sessionId ? `/chat?session=${encodeURIComponent(sessionId)}` : '/chat';

  /**
   * One row per conversation.
   *
   * Tagging by session rather than by event type collapses "the agent
   * replied", "the background task finished" and "here's a notification" for
   * the same conversation into a single banner showing the most recent of
   * them — which also settles whether a background task that ends with a reply
   * produces one notification or two. Approvals are deliberately excluded
   * below: replacing a pending approval with a later banner would bury the one
   * thing that still needs an answer.
   */
  const sessionTag = `session:${sessionId ?? 'default'}`;

  switch (type) {
    case 'background.complete': {
      const label = str(payload.title) ?? 'Background task';
      return { title: 'Hem', body: `${label} finished`, url: chatUrl, tag: sessionTag, kind: type };
    }

    case 'subagent.complete': {
      const name = str(payload.name) ?? 'Subagent';
      return { title: 'Hem', body: `${name} finished`, url: chatUrl, tag: sessionTag, kind: type };
    }

    case 'notification.show': {
      const text = str(payload.text) ?? str(payload.message);
      if (!text) return null;
      return { title: 'Hem', body: text, url: chatUrl, tag: sessionTag, kind: type };
    }

    /**
     * Handled entirely by `push/cron.ts`, not here.
     *
     * The event is empty — `{"type":"cron.changed","session_id":"","payload":{}}`
     * on the wire, every time — so there is nothing to map. The reconcile pass
     * fetches the run that actually changed and sends its own notification
     * from the run record, which is the only place the job name, the outcome
     * and the agent's reply exist.
     */
    case 'cron.changed':
      return null;

    case 'message.complete': {
      /**
       * A turn that was stopped, errored or cancelled is not a reply, and
       * announcing it as one is worse than silence — the banner would claim
       * an answer that isn't there. `interrupted` is the value actually seen
       * on the wire (the chat store keys off the same one); the others are
       * defensive, since the gateway has no published schema.
       */
      const status = str(payload.status);
      if (status && ['interrupted', 'cancelled', 'canceled', 'error', 'failed'].includes(status)) {
        return null;
      }

      // A turn that only ran tools and produced no prose has nothing to say.
      const preview = flatten(str(payload.text));
      if (!preview) return null;

      return { title: 'Hem', body: preview, url: chatUrl, tag: sessionTag, kind: type };
    }

    /**
     * A question the agent asked and is now parked on. Worth waking a phone
     * for the same reason an approval is: the turn does not advance until it
     * is answered, and the gateway gives up after an hour — so an unnoticed
     * one is a conversation that quietly decides for itself.
     */
    case 'clarify.request': {
      const batch = Array.isArray(payload.questions) ? payload.questions : null;
      const first = batch?.length
        ? (batch[0] as Record<string, unknown>)
        : (payload as Record<string, unknown>);
      const question = flatten(str(first.question)) ?? 'The agent needs an answer';
      const more = batch && batch.length > 1 ? ` (+${batch.length - 1} more)` : '';

      return {
        title: 'Question from Hem',
        body: `${question}${more}`,
        url: chatUrl,
        // Kept off the per-session tag for the same reason approvals are: a
        // later "task finished" banner replacing this one would bury the
        // thing still holding the turn.
        tag: `clarify:${sessionId ?? 'default'}`,
        kind: type,
      };
    }

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
