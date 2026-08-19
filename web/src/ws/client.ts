/**
 * JSON-RPC 2.0 client for the Hermes gateway WebSocket.
 *
 * Responsibilities, and nothing beyond them:
 *  - request/response correlation via an incrementing id → promise map
 *  - newline-delimited frame splitting (the gateway coalesces streamed tokens
 *    into batches, so one WS message can carry many JSON lines)
 *  - exponential-backoff reconnect with jitter
 *  - fan-out of events to subscribers
 *
 * Streaming state lives in the session store, not here.
 */
import { RpcEventSchema, RpcResponseSchema, type ConnState, type RpcEvent } from './types';

export type EventHandler = (event: RpcEvent['params']) => void;
export type StateHandler = (state: ConnState) => void;
/** Raw frames, for the hidden dev panel. */
export type FrameHandler = (dir: 'in' | 'out', raw: string) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
/** Generous: a cold agent build behind `session.create` can take a while. */
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * Control-plane budget.
 *
 * The 180s above is sized for calls that can carry real agent work. Applying
 * it to everything meant a `session.resume` issued just as connectivity dropped
 * sat on a spinner for three minutes before failing — the socket was still
 * `OPEN` as far as the browser knew, so the frame went out and nothing came
 * back. Calls that only move metadata around should give up while the person
 * holding the phone is still watching.
 */
const CONTROL_TIMEOUT_MS = 15_000;

/**
 * How long a socket may sit in CONNECTING before a resume treats it as dead.
 * Backgrounding mid-handshake produces exactly that, and nothing else times
 * it out — the browser has no deadline of its own here.
 */
const STALE_CONNECTING_MS = 10_000;

export { CONTROL_TIMEOUT_MS };

export class HermesClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private eventHandlers = new Set<EventHandler>();
  private stateHandlers = new Set<StateHandler>();
  private frameHandlers = new Set<FrameHandler>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the current socket started connecting, to spot one wedged there. */
  private connectingSince = 0;
  private closedByUser = false;
  private _state: ConnState = 'closed';

  get state(): ConnState {
    return this._state;
  }

  constructor(private url: string = defaultWsUrl()) {}

  /**
   * Open the socket, or do nothing if one is already up.
   *
   * `resume` is the phone coming back to the foreground, and it means two
   * things beyond "try again":
   *
   *  - **Start over on the backoff.** A wait computed while the app was in a
   *    pocket has nothing to do with the network the user just came back to.
   *    Without this, returning to the app after a few failed attempts meant
   *    sitting on "Reconnecting…" for up to the 15s cap with a perfectly good
   *    connection available.
   *  - **Distrust a socket stuck in CONNECTING.** Suspending mid-handshake
   *    leaves one that never opens and never closes, and the early-out below
   *    would otherwise treat it as progress forever.
   */
  connect({ resume = false }: { resume?: boolean } = {}): void {
    const state = this.ws?.readyState;

    if (state === WebSocket.CONNECTING) {
      const wedged = resume && Date.now() - this.connectingSince > STALE_CONNECTING_MS;
      if (!wedged) return;
      // Detach the handlers first: closing fires `onclose`, which would
      // otherwise schedule a second reconnect on top of the one below.
      this.discard(this.ws);
    } else if (state === WebSocket.OPEN) {
      return;
    }

    if (resume) this.attempt = 0;

    // This call supersedes any pending retry; leaving the timer armed meant a
    // failure moments later hit the `if (this.reconnectTimer) return` guard in
    // `scheduleReconnect` and waited out the *old* delay instead of backing
    // off from now.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    this.closedByUser = false;
    this.connectingSince = Date.now();
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setState('open');
    };

    socket.onmessage = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      if (!raw) return;
      // One WS message may batch several newline-delimited JSON-RPC frames.
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) this.handleFrame(trimmed);
      }
    };

    socket.onclose = () => {
      this.ws = null;
      // Fail in-flight calls rather than letting their promises hang forever.
      this.rejectAllPending(new Error('connection closed'));
      if (this.closedByUser) {
        this.setState('closed');
      } else {
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      // `onclose` always follows; the reconnect is handled there.
    };
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close(1000, 'client shutdown');
    this.ws = null;
    this.setState('closed');
  }

  /** Point the client at a new URL (token change) and reconnect. */
  setUrl(url: string): void {
    if (url === this.url) return;
    this.url = url;
    this.attempt = 0;
    this.ws?.close(1000, 'url changed');
    this.ws = null;
    this.connect();
  }

  private handleFrame(line: string): void {
    for (const h of this.frameHandlers) h('in', line);

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // Not our problem; the dev panel already saw the raw text.
    }

    // Responses carry an `id`; events never do. That one check decides which
    // schema to reach for, and it matters because this is the app's hottest
    // path — token deltas arrive 30–60×/second for the length of a turn.
    //
    // Trying the response schema first meant every one of those frames paid a
    // `safeParse` that was always going to fail, and a failing safeParse builds
    // a full ZodError with an issues array before telling us what the shape
    // already said. Measured over 200k delta frames: 27.9µs each that way,
    // 2.5µs discriminating first.
    if ((parsed as { id?: unknown } | null)?.id !== undefined) {
      const asResponse = RpcResponseSchema.safeParse(parsed);
      if (asResponse.success && (asResponse.data.result !== undefined || asResponse.data.error)) {
        const id = Number(asResponse.data.id);
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (asResponse.data.error) {
          const e = asResponse.data.error;
          entry.reject(new RpcError(e.message, e.code, entry.method));
        } else {
          entry.resolve(asResponse.data.result);
        }
        return;
      }
    }

    const asEvent = RpcEventSchema.safeParse(parsed);
    if (asEvent.success) {
      for (const h of this.eventHandlers) h(asEvent.data.params);
    }
  }

  /**
   * Issue a JSON-RPC call. Rejects with `RpcError` on a gateway error.
   *
   * `timeoutMs` defaults to the long budget, since a call that carries a turn
   * is the one that needs it; callers that only read or set metadata should
   * pass `CONTROL_TIMEOUT_MS` so a dead socket surfaces quickly.
   */
  call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    { timeoutMs = REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = this.ws;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'));
        return;
      }
      const id = this.nextId++;
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
        timer,
      });

      for (const h of this.frameHandlers) h('out', frame);
      socket.send(frame);
    });
  }

  /** Fire-and-forget notification (no id, no response expected). */
  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const h of this.frameHandlers) h('out', frame);
    this.ws.send(frame);
  }

  onEvent(h: EventHandler): () => void {
    this.eventHandlers.add(h);
    return () => this.eventHandlers.delete(h);
  }

  onState(h: StateHandler): () => void {
    this.stateHandlers.add(h);
    h(this._state);
    return () => this.stateHandlers.delete(h);
  }

  onFrame(h: FrameHandler): () => void {
    this.frameHandlers.add(h);
    return () => this.frameHandlers.delete(h);
  }

  /** Drop a socket without letting its lifecycle events run. */
  private discard(socket: WebSocket | null): void {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000, 'superseded');
    } catch {
      // Already gone; nothing to clean up.
    }
    if (this.ws === socket) this.ws = null;
  }

  private setState(s: ConnState): void {
    if (this._state === s) return;
    this._state = s;
    for (const h of this.stateHandlers) h(s);
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.setState('reconnecting');
    // Jitter avoids a thundering herd when the backend restarts and several
    // tabs/phones reconnect at once.
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    const delay = backoff * (0.75 + Math.random() * 0.5);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export class RpcError extends Error {
  constructor(
    message: string,
    public code: number,
    public method: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/**
 * Same-origin WS URL. The proxy injects the real Bearer token upstream, so the
 * browser needs no credential of its own; a stored token is still forwarded to
 * support pointing the app at a Hermes instance directly.
 */
export function defaultWsUrl(token?: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${proto}//${location.host}/api/ws${qs}`;
}

/** The app-wide singleton. */
export const hermes = new HermesClient();
