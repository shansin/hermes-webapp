/**
 * The gateway client.
 *
 * Everything here is lifecycle: which socket is live, what happens to in-flight
 * calls when it goes away, and whether the app ends up connected after the
 * phone has been in a pocket. The socket itself is mocked (see
 * `helpers/mockSocket`) because none of that is reachable against a real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesClient, RpcError, defaultWsUrl, CONTROL_TIMEOUT_MS } from '../src/ws/client';
import { MockSocket, installMockSocket } from './helpers/mockSocket';

/**
 * The Access probe is mocked rather than exercised: what matters here is *when*
 * the client decides to ask, and the asking itself has its own suite in
 * `accessSession.test.ts`.
 */
const probeAccess = vi.hoisted(() => vi.fn(async () => false));
const markHostReached = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/accessSession', () => ({ probeAccess, markHostReached }));

let restore: () => void;
let client: HermesClient;

beforeEach(() => {
  restore = installMockSocket();
  vi.useFakeTimers();
  probeAccess.mockClear();
  markHostReached.mockClear();
  client = new HermesClient('ws://test/api/ws');
});

afterEach(() => {
  vi.useRealTimers();
  restore();
});

/** Connect and complete the handshake. */
function connected(c = client): MockSocket {
  c.connect();
  const socket = MockSocket.last;
  socket.open();
  return socket;
}

describe('connecting', () => {
  it('reports connecting, then open', () => {
    const states: string[] = [];
    client.onState((s) => states.push(s));
    connected();
    expect(states).toEqual(['closed', 'connecting', 'open']);
  });

  it('does not open a second socket while one is open', () => {
    connected();
    client.connect();
    expect(MockSocket.instances).toHaveLength(1);
  });

  it('does not open a second socket while one is still connecting', () => {
    client.connect();
    client.connect();
    expect(MockSocket.instances).toHaveLength(1);
  });

  it('survives a constructor that throws', () => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      constructor() {
        throw new Error('blocked');
      }
    };
    expect(() => client.connect()).not.toThrow();
    expect(client.state).toBe('reconnecting');
  });
});

describe('request/response', () => {
  it('correlates a reply with its call', async () => {
    const socket = connected();
    const pending = client.call('session.list');
    const { id, method } = socket.lastSent();
    expect(method).toBe('session.list');

    socket.deliverJson({ jsonrpc: '2.0', id, result: { sessions: [] } });
    await expect(pending).resolves.toEqual({ sessions: [] });
  });

  it('keeps concurrent calls apart, whatever order they answer in', async () => {
    const socket = connected();
    const a = client.call('a');
    const b = client.call('b');
    const idA = JSON.parse(socket.sent[0]!).id;
    const idB = JSON.parse(socket.sent[1]!).id;

    socket.deliverJson({ jsonrpc: '2.0', id: idB, result: 'B' });
    socket.deliverJson({ jsonrpc: '2.0', id: idA, result: 'A' });

    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });

  it('rejects with an RpcError carrying the gateway code and the method', async () => {
    const socket = connected();
    const pending = client.call('session.resume');
    const { id } = socket.lastSent();
    socket.deliverJson({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: 'no such session' },
    });

    await expect(pending).rejects.toThrow(RpcError);
    await expect(pending).rejects.toMatchObject({
      code: -32000,
      method: 'session.resume',
      message: 'no such session',
    });
  });

  it('refuses to call on a socket that is not open', async () => {
    await expect(client.call('anything')).rejects.toThrow('not connected');
  });

  it('times out rather than hanging forever', async () => {
    const socket = connected();
    const pending = client.call('session.resume', {}, { timeoutMs: CONTROL_TIMEOUT_MS });
    void socket;
    vi.advanceTimersByTime(CONTROL_TIMEOUT_MS + 1);
    await expect(pending).rejects.toThrow('session.resume timed out');
  });

  it('ignores a reply that arrives after the timeout', async () => {
    const socket = connected();
    const pending = client.call('slow', {}, { timeoutMs: 1000 });
    const { id } = socket.lastSent();
    vi.advanceTimersByTime(1001);
    await expect(pending).rejects.toThrow();
    expect(() => socket.deliverJson({ jsonrpc: '2.0', id, result: 'late' })).not.toThrow();
  });

  it('ignores a reply for an id it never issued', () => {
    const socket = connected();
    expect(() => socket.deliverJson({ jsonrpc: '2.0', id: 9999, result: 'stray' })).not.toThrow();
  });

  /**
   * Losing the socket mid-call must surface as a rejection. Leaving the
   * promise pending shows the user a spinner that never resolves.
   */
  it('fails in-flight calls when the socket drops', async () => {
    const socket = connected();
    const pending = client.call('prompt.submit');
    socket.drop();
    await expect(pending).rejects.toThrow('connection closed');
  });
});

describe('notifications', () => {
  it('sends a frame with no id', () => {
    const socket = connected();
    client.notify('ping', { x: 1 });
    expect(socket.lastSent<{ id?: number }>().id).toBeUndefined();
  });

  it('is a no-op when the socket is not open', () => {
    expect(() => client.notify('ping')).not.toThrow();
  });
});

describe('events', () => {
  it('fans an event out to every subscriber', () => {
    const socket = connected();
    const a = vi.fn();
    const b = vi.fn();
    client.onEvent(a);
    client.onEvent(b);

    socket.deliverJson({
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'message.delta', session_id: 's1', payload: { text: 'hi' } },
    });

    expect(a).toHaveBeenCalledWith({
      type: 'message.delta',
      session_id: 's1',
      payload: { text: 'hi' },
    });
    expect(b).toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const socket = connected();
    const handler = vi.fn();
    client.onEvent(handler)();
    socket.deliverJson({
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'x', payload: {} },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  /**
   * The gateway coalesces streamed tokens, so a single WS message routinely
   * carries a dozen JSON-RPC lines. Treating the payload as one document
   * would drop all but the first.
   */
  it('splits a batched message into its newline-delimited frames', () => {
    const socket = connected();
    const handler = vi.fn();
    client.onEvent(handler);

    const frame = (text: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'message.delta', payload: { text } },
      });
    socket.deliver([frame('a'), frame('b'), frame('c')].join('\n'));

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('tolerates blank lines in a batch', () => {
    const socket = connected();
    const handler = vi.fn();
    client.onEvent(handler);
    socket.deliver(
      '\n' +
        JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'x', payload: {} } }) +
        '\n\n',
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores a line that is not JSON without dropping the rest', () => {
    const socket = connected();
    const handler = vi.fn();
    client.onEvent(handler);
    socket.deliver(
      'this is not json\n' +
        JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'x', payload: {} } }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores a frame whose shape it does not recognise', () => {
    const socket = connected();
    const handler = vi.fn();
    client.onEvent(handler);
    socket.deliverJson({ jsonrpc: '2.0', method: 'event' });
    socket.deliverJson({ hello: 'world' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('surfaces raw frames in both directions for the dev panel', () => {
    const socket = connected();
    const frames: [string, string][] = [];
    client.onFrame((dir, raw) => frames.push([dir, raw]));

    client.notify('ping');
    socket.deliver('{"not":"valid rpc"}');

    expect(frames.map(([d]) => d)).toEqual(['out', 'in']);
  });
});

describe('reconnecting', () => {
  it('retries after an unexpected drop', () => {
    const socket = connected();
    socket.drop();
    expect(client.state).toBe('reconnecting');

    vi.advanceTimersByTime(15_000);
    expect(MockSocket.instances.length).toBeGreaterThan(1);
  });

  it('backs off further on each failure', () => {
    connected().drop();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = MockSocket.instances.length;
      let waited = 0;
      while (MockSocket.instances.length === before && waited < 60_000) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      delays.push(waited);
      MockSocket.last.drop();
    }
    expect(delays.at(-1)!).toBeGreaterThan(delays[0]!);
  });

  it('stays closed after an explicit disconnect', async () => {
    connected();
    client.disconnect();
    await Promise.resolve();
    expect(client.state).toBe('closed');
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(1);
  });

  /**
   * A backoff computed while the app sat in a pocket says nothing about the
   * network the user just came back to.
   */
  it('reconnects immediately on resume rather than waiting out the backoff', () => {
    connected().drop();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(20_000);
      if (MockSocket.last.readyState === MockSocket.CONNECTING) MockSocket.last.drop();
    }
    const before = MockSocket.instances.length;

    client.connect({ resume: true });
    expect(MockSocket.instances.length).toBe(before + 1);
  });

  /**
   * Suspending mid-handshake leaves a socket that never opens and never
   * closes. Nothing else times it out, so a resume has to distrust it.
   */
  it('replaces a socket wedged in CONNECTING on resume', () => {
    client.connect();
    const wedged = MockSocket.last;
    vi.advanceTimersByTime(11_000);

    client.connect({ resume: true });
    expect(MockSocket.instances).toHaveLength(2);
    expect(MockSocket.last).not.toBe(wedged);
  });

  it('leaves a young CONNECTING socket alone on resume', () => {
    client.connect();
    vi.advanceTimersByTime(1000);
    client.connect({ resume: true });
    expect(MockSocket.instances).toHaveLength(1);
  });

  /**
   * A socket the browser is still closing is not a socket to wait on.
   *
   * This is the state a phone produces constantly: background the tab, lose
   * the radio, come back. The close handshake is waiting on an ack that will
   * never arrive, so `readyState` sits at CLOSING — neither the "already
   * connecting" nor the "already open" early-out applies, and the resume falls
   * through to build a replacement while the old socket's `onclose` is still
   * pending.
   */
  it('replaces a socket stuck in CLOSING on resume', () => {
    const socket = connected();
    socket.close();
    expect(socket.readyState).toBe(MockSocket.CLOSING);

    client.connect({ resume: true });
    expect(MockSocket.instances).toHaveLength(2);
  });

  /**
   * ...and the socket it replaced must not be allowed to take the successor
   * down with it when its `onclose` finally lands.
   *
   * This is the bug that strands the app on "Reconnecting…" for good. The
   * stale `onclose` nulls out the *new* socket's reference and schedules a
   * reconnect, so the client believes it has nothing while a perfectly good
   * socket stays open — and the proxy, which pings every 45s, keeps that
   * orphan alive rather than letting it die. The next reconnect opens another
   * socket, which becomes the next orphan: the failure feeds itself, and the
   * only visible symptom is a banner that never clears.
   */
  it('does not let a socket closing in the background strand its successor', async () => {
    const stale = connected();
    stale.close();

    client.connect({ resume: true });
    const fresh = MockSocket.last;
    fresh.open();

    // The stale socket's `onclose` lands here, after its successor is live.
    await Promise.resolve();

    expect(client.state).toBe('open');
    void client.call('session.list');
    expect(fresh.sent).toHaveLength(1);

    // Nothing may be scheduled on top of the socket that is already open.
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.last).toBe(fresh);
  });

  /**
   * The mirror image: a superseded socket that completes its handshake late
   * must not report the client "open" on behalf of a socket nobody holds.
   * Left unguarded it clears the banner while every call rejects with "not
   * connected" — the same confusion, wearing the opposite face.
   */
  it('ignores a superseded socket that opens late', () => {
    client.connect();
    const stale = MockSocket.last;
    vi.advanceTimersByTime(11_000);
    client.connect({ resume: true });

    stale.open();
    expect(client.state).not.toBe('open');
  });

  /**
   * The socket discarded above must not fire its own `onclose`: that would
   * schedule a second reconnect on top of the one just started.
   */
  it('does not let the discarded socket schedule its own reconnect', () => {
    client.connect();
    vi.advanceTimersByTime(11_000);
    client.connect({ resume: true });
    const afterResume = MockSocket.instances.length;

    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(afterResume);
  });
});

/**
 * The socket is the app's best evidence about the network, and for a while it
 * was the evidence nobody collected.
 *
 * The "this device can't reach the host" banner is raised by the Access probe,
 * which only runs while a reconnect is failing. So the banner went up
 * correctly, the socket recovered, the probes stopped — and nothing was left
 * to take it down again. It sat there over a live session that was streaming
 * replies perfectly.
 */
describe('reporting reachability', () => {
  it('reports the host reachable as soon as a socket opens', () => {
    connected();
    expect(markHostReached).toHaveBeenCalled();
  });

  it('does not report it for a socket that never opened', () => {
    client.connect();
    MockSocket.last.drop();
    expect(markHostReached).not.toHaveBeenCalled();
  });

  it('says nothing on behalf of a socket it no longer holds', () => {
    client.connect();
    const stale = MockSocket.last;
    vi.advanceTimersByTime(11_000);
    client.connect({ resume: true });
    markHostReached.mockClear();

    stale.open();
    expect(markHostReached).not.toHaveBeenCalled();
  });
});

describe('changing the URL', () => {
  it('does nothing when the URL is unchanged', () => {
    connected();
    client.setUrl('ws://test/api/ws');
    expect(MockSocket.instances).toHaveLength(1);
  });

  it('opens a socket at the new URL', () => {
    connected();
    client.setUrl('ws://test/api/ws?token=abc');
    expect(MockSocket.last.url).toBe('ws://test/api/ws?token=abc');
  });

  /**
   * The socket being replaced still has its handlers attached, and closing it
   * fires them. If that `onclose` is allowed to run it tears down the socket
   * that has just been put in its place — leaving the client reporting
   * "reconnecting" with a perfectly good open socket it no longer knows about,
   * and every `call()` rejecting with "not connected".
   */
  it('does not let the replaced socket tear down its successor', async () => {
    connected();
    client.setUrl('ws://test/api/ws?token=abc');

    const fresh = MockSocket.last;
    fresh.open();

    // The replaced socket's `onclose` lands here, after its successor exists.
    await Promise.resolve();

    expect(client.state).toBe('open');
    // Proof the client is actually holding the new socket: a call must land.
    void client.call('session.list');
    expect(fresh.sent).toHaveLength(1);
  });

  it('does not schedule a reconnect on top of the new socket', async () => {
    connected();
    client.setUrl('ws://test/api/ws?token=abc');
    MockSocket.last.open();
    await Promise.resolve();

    const count = MockSocket.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(count);
  });
});

describe('defaultWsUrl', () => {
  it('is same-origin and needs no credential', () => {
    expect(defaultWsUrl()).toBe(`ws://${location.host}/api/ws`);
  });

  it('forwards an explicit token, escaped', () => {
    expect(defaultWsUrl('a b&c')).toBe(`ws://${location.host}/api/ws?token=a%20b%26c`);
  });
});

/**
 * Telling "the gate signed me out" apart from "the network is gone".
 *
 * A WebSocket handshake refused with a 401, and one that never reached a
 * server at all, arrive at script as the same bare close event — the status
 * line is not exposed. So the client cannot read the answer and has to go and
 * ask over REST instead. Getting the timing of that wrong is not a crash: it
 * is the app claiming to be reconnecting, for ever, while the only thing that
 * would fix it is a trip through Google.
 */
describe('suspecting the Access gate', () => {
  /** Let the backoff elapse and kill whatever socket it opened. */
  function failOnce(): void {
    vi.advanceTimersByTime(20_000);
    if (MockSocket.last.readyState === MockSocket.CONNECTING) MockSocket.last.drop();
  }

  it('does not probe on the first failure — a blip is not a sign-out', () => {
    connected().drop();
    expect(probeAccess).not.toHaveBeenCalled();
  });

  it('probes once the failures stop looking like a blip', () => {
    connected().drop();
    failOnce();
    failOnce();
    expect(probeAccess).toHaveBeenCalled();
  });

  /**
   * The regression this counter exists for.
   *
   * `connect({ resume: true })` zeroes the *backoff* counter, and the phone
   * fires `visibilitychange` every time the screen wakes. Counting failures
   * with the backoff meant someone watching the banner and prodding the phone
   * could restart the count indefinitely and never be told they were signed
   * out — in precisely the situation where they are most likely to be prodding
   * it.
   */
  it('probes even when resumes keep restarting the backoff', () => {
    connected().drop();
    client.connect({ resume: true });
    MockSocket.last.drop();
    client.connect({ resume: true });
    MockSocket.last.drop();
    expect(probeAccess).toHaveBeenCalled();
  });

  it('keeps asking rather than relying on hitting a threshold exactly', () => {
    connected().drop();
    failOnce();
    failOnce();
    const afterThreshold = probeAccess.mock.calls.length;
    failOnce();
    expect(probeAccess.mock.calls.length).toBeGreaterThan(afterThreshold);
  });

  it('forgets the failures once a socket actually opens', () => {
    connected().drop();
    failOnce();
    failOnce();
    expect(probeAccess).toHaveBeenCalled();
    probeAccess.mockClear();

    // A socket that opens means the gate is letting us through after all.
    vi.advanceTimersByTime(20_000);
    MockSocket.last.open();
    MockSocket.last.drop();
    expect(probeAccess).not.toHaveBeenCalled();
  });
});
