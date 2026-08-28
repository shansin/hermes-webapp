/**
 * Asking the gateway a question over the push listener's socket.
 *
 * The whole module is one pending-call map, and every way it can be wrong is
 * quiet: the sweep that depends on it treats `null` as "no data this pass" and
 * carries on, so a correlation bug shows up as notifications that gradually
 * stop rather than as anything failing.
 *
 * - **Answering the wrong caller.** Ids are matched, and a frame carrying an
 *   id nobody is waiting on has to fall *through* — `events.ts` hands every
 *   line here first, and a `true` return means "consumed", which would eat an
 *   event frame that happened to carry an `id`.
 * - **Leaving a call pending after the socket dies.** The sweep guards on
 *   being mid-pass, so one dropped socket would cost two passes rather than
 *   none if the in-flight call sat on its own timeout instead of settling.
 * - **Throwing.** Every caller is a `setInterval` callback with no handler
 *   above it; a rejection here is an unhandled one in a process nobody is
 *   watching. Failure is always a `null` result.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Rpc = typeof import('../src/push/rpc.js');
let rpc: Rpc;
let sent: string[];

beforeEach(async () => {
  vi.resetModules();
  sent = [];
  rpc = await import('../src/push/rpc.js');
});

/** Bind a socket that records what it was asked. */
function bind(): void {
  rpc.bindRpcSocket((frame) => sent.push(frame));
}

/** The id of the nth frame sent, so a test can answer it. */
function idOf(index = 0): number {
  return JSON.parse(sent[index]).id;
}

describe('with no socket bound', () => {
  it('answers null rather than throwing or queueing', async () => {
    expect(await rpc.callGateway('session.active_list')).toBeNull();
    expect(rpc.rpcReady()).toBe(false);
    expect(rpc.rpcPending()).toBe(false);
  });
});

describe('correlation', () => {
  it('sends a JSON-RPC request and resolves it with the matching result', async () => {
    bind();
    const call = rpc.callGateway<{ sessions: unknown[] }>('session.active_list', { a: 1 });

    expect(JSON.parse(sent[0])).toMatchObject({
      jsonrpc: '2.0',
      method: 'session.active_list',
      params: { a: 1 },
    });
    expect(rpc.rpcPending()).toBe(true);

    rpc.resolveRpcFrame({ jsonrpc: '2.0', id: idOf(), result: { sessions: [] } });

    expect(await call).toEqual({ sessions: [] });
    expect(rpc.rpcPending()).toBe(false);
  });

  /* `events.ts` reads the return value to decide whether to keep processing
     the line as an event. Claiming a frame we are not waiting on would take a
     notification out of the stream. */
  it('does not claim a frame it is not waiting on', () => {
    bind();
    void rpc.callGateway('session.active_list');

    expect(rpc.resolveRpcFrame({ id: idOf() + 99, result: {} })).toBe(false);
    expect(rpc.resolveRpcFrame({ method: 'event', params: { type: 'message.complete' } })).toBe(
      false,
    );
    expect(rpc.resolveRpcFrame(null)).toBe(false);
    expect(rpc.rpcPending()).toBe(true);
  });

  it('answers each caller with its own result', async () => {
    bind();
    const first = rpc.callGateway<string>('one');
    const second = rpc.callGateway<string>('two');

    // Deliberately out of order: the gateway is under no obligation to answer
    // in the order it was asked.
    rpc.resolveRpcFrame({ id: idOf(1), result: 'second' });
    rpc.resolveRpcFrame({ id: idOf(0), result: 'first' });

    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
  });

  /* An older Hermes without the method answers with an error frame. That is
     an ordinary state for this proxy, not a failure to report. */
  it('treats a JSON-RPC error as no data', async () => {
    bind();
    const call = rpc.callGateway('session.active_list');

    rpc.resolveRpcFrame({ id: idOf(), error: { code: -32601, message: 'method not found' } });

    expect(await call).toBeNull();
  });
});

describe('a socket that goes away', () => {
  /* The sweep guards on being mid-pass. A call left hanging past the
     reconnect costs the next pass as well as its own. */
  it('settles everything in flight when the socket unbinds', async () => {
    bind();
    const call = rpc.callGateway('session.active_list');
    expect(rpc.rpcPending()).toBe(true);

    rpc.unbindRpcSocket();

    expect(await call).toBeNull();
    expect(rpc.rpcPending()).toBe(false);
    expect(rpc.rpcReady()).toBe(false);
  });

  it('answers null when the send itself throws', async () => {
    rpc.bindRpcSocket(() => {
      throw new Error('socket closed under us');
    });

    expect(await rpc.callGateway('session.active_list')).toBeNull();
    expect(rpc.rpcPending()).toBe(false);
  });

  it('gives up on a call nobody answers', async () => {
    vi.useFakeTimers();
    try {
      bind();
      const call = rpc.callGateway('session.active_list', {}, 50);
      await vi.advanceTimersByTimeAsync(60);

      expect(await call).toBeNull();
      expect(rpc.rpcPending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /* A late answer to a call that already timed out must not be claimed —
     `events.ts` would otherwise drop that line instead of reading it. */
  it('ignores an answer that arrives after the timeout', async () => {
    vi.useFakeTimers();
    try {
      bind();
      const call = rpc.callGateway('session.active_list', {}, 50);
      const id = idOf();
      await vi.advanceTimersByTimeAsync(60);
      await call;

      expect(rpc.resolveRpcFrame({ id, result: { sessions: [] } })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
