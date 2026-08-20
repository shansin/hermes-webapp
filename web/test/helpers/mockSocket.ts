/**
 * A controllable stand-in for the browser's `WebSocket`.
 *
 * The reconnect logic, the pre-open guards and the request/response
 * correlation in `ws/client.ts` are all about socket *lifecycle*, and none of
 * it is observable against a real socket without a server and real time. This
 * records every instance so a test can open, close or feed each one by hand.
 */
export class MockSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every socket constructed, in order, including superseded ones. */
  static instances: MockSocket[] = [];

  static reset(): void {
    MockSocket.instances = [];
  }

  static get last(): MockSocket {
    const s = MockSocket.instances.at(-1);
    if (!s) throw new Error('no socket was constructed');
    return s;
  }

  readyState: number = MockSocket.CONNECTING;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    MockSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockSocket.OPEN) throw new Error('send on a socket that is not open');
    this.sent.push(data);
  }

  /**
   * Asynchronous, as in a real browser: `close()` starts a closing handshake
   * and `onclose` fires later. Firing it synchronously would paper over
   * exactly the ordering bugs this mock exists to catch — code that closes a
   * socket and immediately replaces it looks correct only if the old socket's
   * teardown is allowed to run first.
   */
  close(code?: number, reason?: string): void {
    if (this.readyState === MockSocket.CLOSED || this.readyState === MockSocket.CLOSING) return;
    this.readyState = MockSocket.CLOSING;
    this.closedWith = { code, reason };
    queueMicrotask(() => {
      this.readyState = MockSocket.CLOSED;
      this.onclose?.();
    });
  }

  // --- test controls -------------------------------------------------------

  /** Complete the handshake. */
  open(): void {
    this.readyState = MockSocket.OPEN;
    this.onopen?.();
  }

  /** Drop the socket the way a network does — without the client asking. */
  drop(): void {
    this.readyState = MockSocket.CLOSED;
    this.onclose?.();
  }

  /** Deliver one WS message, which may carry several newline-delimited frames. */
  deliver(raw: string): void {
    this.onmessage?.({ data: raw });
  }

  /** Deliver a JSON-RPC value, serialised. */
  deliverJson(value: unknown): void {
    this.deliver(JSON.stringify(value));
  }

  /** The last frame the client sent, parsed. */
  lastSent<T = { id: number; method: string; params: Record<string, unknown> }>(): T {
    const raw = this.sent.at(-1);
    if (!raw) throw new Error('nothing was sent');
    return JSON.parse(raw) as T;
  }
}

/** Install `MockSocket` as the global `WebSocket` and hand back a cleanup. */
export function installMockSocket(): () => void {
  const original = globalThis.WebSocket;
  MockSocket.reset();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockSocket;
  return () => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = original;
  };
}
