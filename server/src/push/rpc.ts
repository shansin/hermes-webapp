/**
 * Request/response over the push listener's own gateway socket.
 *
 * `push/events.ts` has always used its socket in one direction: read the
 * firehose, map an event to a banner. `push/sessions.ts` needs the other
 * direction — `session.active_list` is the only place a live session's state
 * exists, and there is no REST route for it — so the listener needs a way to
 * ask a question and match the answer.
 *
 * This is deliberately not a second copy of `web/src/ws/client.ts`. That
 * client owns reconnection, backoff, event fan-out and streaming state; all of
 * that already lives in `events.ts` here, and duplicating it would give the
 * proxy two things that both believe they own the socket. So this module owns
 * exactly one thing: the pending-call map. `events.ts` binds its socket on
 * open, unbinds on close, and hands responses in.
 *
 * Every failure answers `null` rather than throwing — no socket, a timeout, a
 * JSON-RPC error. That matches `gatewayGet` in `cron.ts` and `kanban.ts`, and
 * it matters more here than it reads: the caller is a sweep whose whole job is
 * to keep working through a backend that comes and goes, and an exception
 * escaping into a `setInterval` callback is an unhandled rejection in a
 * process nobody is watching. `callGatewayOutcome` is the one exception, for a
 * caller that has to tell "the gateway said no" from "nobody answered".
 */
import { log } from '../log.js';

/** How the bound socket writes a frame. Injected, so this module holds no `ws`. */
type Sender = (frame: string) => void;

/**
 * Default budget for a call.
 *
 * Short on purpose. Everything asked over this socket is a status read against
 * process memory, so a slow answer means the gateway is wedged rather than
 * busy — and the sweep behind it would rather skip a pass than hold a timer
 * open across the next one.
 */
const CALL_TIMEOUT_MS = 8000;

/**
 * What came back from one call: a result, the gateway's error frame, or — as
 * `null` — no answer at all (no socket, a timeout, a send that threw).
 */
export type GatewayOutcome<T> =
  | { result: T | null }
  | { error: { code: number | null; message: string | null } };

interface Pending {
  resolve: (value: GatewayOutcome<unknown> | null) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

let send: Sender | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

/** Whether a call could be made right now. */
export function rpcReady(): boolean {
  return send !== null;
}

/**
 * Whether any call is outstanding.
 *
 * `events.ts` reads this before parsing a frame that its own substring
 * early-out would otherwise discard: a JSON-RPC *response* contains none of
 * the event types that scan looks for, so without this a reply would be
 * dropped on any machine with no push devices registered — and the sweep would
 * time out against a socket that answered perfectly. True only for the few
 * milliseconds a call is in flight, so the firehose stays unparsed the rest of
 * the time, which is the point of that early-out.
 */
export function rpcPending(): boolean {
  return pending.size > 0;
}

export function bindRpcSocket(sender: Sender): void {
  send = sender;
}

/**
 * Drop the socket and fail everything waiting on it.
 *
 * Settling the pending calls is the part that matters: a sweep awaiting a
 * response when the link dies would otherwise sit on its timeout while the
 * listener has already reconnected, and `reconcileSessions` guards on being
 * mid-pass — so one dropped socket would cost two sweeps rather than none.
 */
export function unbindRpcSocket(): void {
  send = null;
  for (const [id, call] of pending) {
    clearTimeout(call.timer);
    pending.delete(id);
    call.resolve(null);
  }
}

/**
 * Hand a parsed frame in. Returns whether it was a response we were waiting for.
 *
 * A `false` return means the caller should carry on treating it as an event,
 * which is what keeps this module out of the notification path entirely.
 */
export function resolveRpcFrame(frame: unknown): boolean {
  if (!frame || typeof frame !== 'object') return false;
  const { id, result, error } = frame as { id?: unknown; result?: unknown; error?: unknown };
  if (typeof id !== 'number') return false;

  const call = pending.get(id);
  if (!call) return false;

  clearTimeout(call.timer);
  pending.delete(id);

  if (error !== undefined) {
    // Not a warning: an older Hermes answering "method not found" is an
    // ordinary state for this proxy, and the caller renders it as "no data".
    log.debug(`Gateway RPC ${call.method} returned an error frame.`);
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    call.resolve({
      error: {
        code: typeof code === 'number' ? code : null,
        message: typeof message === 'string' ? message : null,
      },
    });
    return true;
  }

  call.resolve({ result: (result ?? null) as unknown });
  return true;
}

/**
 * Ask the gateway something over the listener's socket.
 *
 * Answers `null` for every failure, including a method the backend does not
 * have. Callers treat that as "no data this pass", never as "nothing is
 * there" — the distinction is what stops a sweep pruning its own watermarks
 * against a socket that was simply down.
 */
export async function callGateway<T>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<T | null> {
  const outcome = await callGatewayOutcome<T>(method, params, timeoutMs);
  return outcome && 'result' in outcome ? outcome.result : null;
}

/**
 * `callGateway`, keeping the gateway's error frame apart from no answer.
 *
 * For a caller whose answer depends on which one it was: `approval.respond`
 * on a session that has ended is a 4001 "session not found" — the approval
 * expired with it — and reporting that as "backend unreachable" sends the
 * user off to debug a connection that is fine. Still never throws.
 */
export function callGatewayOutcome<T>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<GatewayOutcome<T> | null> {
  const sender = send;
  if (!sender) return Promise.resolve(null);

  return new Promise<GatewayOutcome<T> | null>((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      log.debug(`Gateway RPC ${method} timed out.`);
      resolve(null);
    }, timeoutMs);
    // A call in flight is never a reason to keep the process alive.
    timer.unref?.();

    pending.set(id, { resolve: resolve as Pending['resolve'], timer, method });

    try {
      sender(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      log.debug({ err }, `Gateway RPC ${method} could not be sent.`);
      resolve(null);
    }
  });
}
