/**
 * The board's live-update socket.
 *
 * It sits next to a ten-second poll that it must never be allowed to replace,
 * and everything below is a way it could quietly go wrong while the board
 * still looks fine — which is the worst shape for this particular component,
 * because "the board is a bit stale" is invisible until someone acts on it.
 *
 * - **The cursor has to survive a reconnect.** It is seeded from the board's
 *   `latest_event_id` and then advanced from each frame. Re-seeding from the
 *   query on reconnect replays whatever arrived in the gap; starting from zero
 *   replays the entire `task_events` table, which on a working board is
 *   thousands of rows and a refetch storm.
 * - **The board is pinned at the handshake.** The plugin says so: changing
 *   boards mid-stream would need two cursors reconciled, so the client opens a
 *   new socket — and it must carry the *new* board's cursor, not the old
 *   board's id, which numbers a different table.
 * - **A frame without `events` is not an event frame.** The proxy sends a JSON
 *   keepalive on this path, because the socket is idle for long stretches and
 *   Cloudflare closes an idle proxied WebSocket at 100s. Treating it as data
 *   would refetch the board every 45 seconds for ever.
 * - **A socket may only touch state while it is still the current one.** The
 *   same invariant `ws/client.ts` is built on, for the same reason: a
 *   superseded socket's `onclose` arriving after its replacement opened would
 *   mark the hook dead over a perfectly good stream, and the board would sit
 *   on the slow poll believing it was live.
 * - **It has to give up.** A socket that cannot open here usually never will —
 *   an older proxy, an older plugin, a network that blocks upgrades — and the
 *   poll already covers it. Retrying for ever would burn a phone's radio to
 *   add nothing.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

import { useKanbanEvents } from '../src/lib/useKanbanEvents';

/** Every socket the hook has opened, in order. */
let sockets: FakeSocket[];

class FakeSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  closed = false;

  constructor(public url: string) {
    sockets.push(this);
  }

  close() {
    this.closed = true;
  }

  /* The handlers are nulled during teardown, so calling through the property
     rather than a stored reference is what makes a superseded socket inert —
     exactly as it is in the browser. */
  open() {
    this.onopen?.();
  }
  send(frame: unknown) {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }
  die() {
    this.onclose?.();
  }
  /** The query string, parsed, which is where the cursor and board travel. */
  params() {
    return Object.fromEntries(new URL(this.url).searchParams);
  }
}

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

let qc: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sockets = [];
  vi.stubGlobal('WebSocket', FakeSocket as never);
  vi.stubGlobal('location', { protocol: 'http:', host: 'phone.local:3000' } as never);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidate = vi.spyOn(qc, 'invalidateQueries');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const render = (board: string | null = null, since: number | undefined = 100) =>
  renderHook(({ b, s }: { b: string | null; s: number | undefined }) => useKanbanEvents(b, s, true), {
    wrapper: wrap(qc),
    initialProps: { b: board, s: since },
  });

describe('opening', () => {
  it('seeds the cursor from the board’s latest event id', () => {
    render(null, 512);
    expect(sockets[0]!.params()).toEqual({ since: '512' });
  });

  it('names the board when one is pinned', () => {
    render('work', 7);
    expect(sockets[0]!.params()).toEqual({ since: '7', board: 'work' });
  });

  /* A board query that has not answered yet leaves no id to seed from. Zero
     asks for the whole table, which is wrong but recoverable; the alternative
     — not opening at all — is a socket that never starts on a slow first load. */
  it('starts from zero when the board has not answered yet', () => {
    // Built directly: passing `undefined` through the helper would land on its
    // default parameter, which is the value this test exists to exclude.
    renderHook(() => useKanbanEvents(null, undefined, true), { wrapper: wrap(qc) });
    expect(sockets[0]!.params()).toEqual({ since: '0' });
  });

  it('builds a wss URL on a secure origin', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'hermes.example' } as never);
    render(null, 1);
    expect(sockets[0]!.url.startsWith('wss://hermes.example/api/plugins/kanban/events')).toBe(true);
  });
});

describe('frames', () => {
  it('refetches the board and every task an event touched', async () => {
    const { result } = render();
    act(() => sockets[0]!.open());
    await waitFor(() => expect(result.current).toBe(true));

    invalidate.mockClear();
    act(() =>
      sockets[0]!.send({
        cursor: 105,
        events: [
          { id: 104, task_id: 't_1', kind: 'claimed' },
          { id: 105, task_id: 't_2', kind: 'blocked' },
        ],
      }),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalled());

    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(['kanban', null, 'board']);
    expect(keys).toContainEqual(['kanban', null, 'task', 't_1']);
    expect(keys).toContainEqual(['kanban', null, 'task', 't_2']);
  });

  /* The endpoint sends up to 200 rows in one frame and several frames in a
     burst while a worker spins up. One refetch per burst, not per event. */
  it('coalesces a burst into a single refetch', async () => {
    const { result } = render();
    act(() => sockets[0]!.open());
    await waitFor(() => expect(result.current).toBe(true));

    invalidate.mockClear();
    act(() => {
      for (let i = 0; i < 5; i++) {
        sockets[0]!.send({ cursor: 100 + i, events: [{ id: 100 + i, task_id: 't_1', kind: 'heartbeat' }] });
      }
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());

    const boardCalls = invalidate.mock.calls.filter(
      (c) => (c[0] as { queryKey: unknown[] }).queryKey[2] === 'board',
    );
    expect(boardCalls).toHaveLength(1);
  });

  /* Sent every 45s by the proxy, for ever, on an idle board. Acting on it
     would turn the keepalive into a slower poll that nobody asked for. */
  it('ignores the proxy’s keepalive', async () => {
    const { result } = render();
    act(() => sockets[0]!.open());
    await waitFor(() => expect(result.current).toBe(true));

    invalidate.mockClear();
    act(() => sockets[0]!.send({ keepalive: true }));
    await new Promise((r) => setTimeout(r, 400));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('ignores an empty event list', async () => {
    const { result } = render();
    act(() => sockets[0]!.open());
    await waitFor(() => expect(result.current).toBe(true));

    invalidate.mockClear();
    act(() => sockets[0]!.send({ events: [], cursor: 100 }));
    await new Promise((r) => setTimeout(r, 400));
    expect(invalidate).not.toHaveBeenCalled();
  });

  /* A malformed frame is a reason to drop the frame, not the stream: tearing
     down here would mean one bad byte costs the socket and every event after
     it, and the reconnect starts the give-up counter. */
  it('survives a frame that is not JSON', async () => {
    const { result } = render();
    act(() => sockets[0]!.open());
    await waitFor(() => expect(result.current).toBe(true));

    act(() => sockets[0]!.send('not json at all'));
    expect(result.current).toBe(true);
    expect(sockets).toHaveLength(1);
  });
});

describe('reconnecting', () => {
  it('resumes from the cursor it reached, not from the seed', async () => {
    /* `waitFor` polls on real timers, so it can never resolve while they are
       faked. Everything asserted here is set synchronously inside `act`. */
    vi.useFakeTimers();
    const { result } = render(null, 100);
    act(() => sockets[0]!.open());
    expect(result.current).toBe(true);

    act(() => sockets[0]!.send({ cursor: 340, events: [{ id: 340, task_id: 't_1', kind: 'spawned' }] }));
    act(() => sockets[0]!.die());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.params().since).toBe('340');
  });

  it('reports itself dead while it is down, and live again when it is back', async () => {
    vi.useFakeTimers();
    const { result } = render();
    act(() => sockets[0]!.open());
    expect(result.current).toBe(true);

    act(() => sockets[0]!.die());
    expect(result.current).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    act(() => sockets[1]!.open());
    expect(result.current).toBe(true);
  });

  /**
   * A socket that cannot open here usually never will. The poll behind it means
   * nothing is broken, so the honest response is to stop rather than retry for
   * the life of the screen.
   */
  it('gives up after a handful of consecutive failures', async () => {
    vi.useFakeTimers();
    render();
    for (let i = 0; i < 10; i++) {
      act(() => sockets[sockets.length - 1]!.die());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
    }
    expect(sockets.length).toBeLessThanOrEqual(5);
  });

  /**
   * The invariant borrowed from `ws/client.ts`. A superseded socket's close
   * arriving late must not mark the hook dead — the board would drop to the
   * slow poll while believing it was live, which is the one combination that
   * is worse than either state on its own.
   */
  it('ignores a superseded socket’s close', async () => {
    vi.useFakeTimers();
    const { result } = render();
    act(() => sockets[0]!.open());
    expect(result.current).toBe(true);

    act(() => sockets[0]!.die());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    act(() => sockets[1]!.open());
    expect(result.current).toBe(true);

    // The first socket, long replaced, finally reports its own close.
    act(() => sockets[0]!.die());
    expect(result.current).toBe(true);
  });
});

describe('changing board', () => {
  it('opens a new socket and closes the old one', async () => {
    const { result, rerender } = render('a', 10);
    act(() => sockets[0]!.open());
    await waitFor(() => expect(result.current).toBe(true));

    rerender({ b: 'b', s: 90 });
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.params()).toEqual({ since: '90', board: 'b' });
  });

  /* Cursors are per-board — they index that board's own `task_events` table —
     so carrying one across asks the new board for events by another board's
     numbering, which silently skips everything below it. */
  it('does not carry the previous board’s cursor across', async () => {
    const { result, rerender } = render('a', 10);
    act(() => sockets[0]!.open());
    await waitFor(() => expect(result.current).toBe(true));
    act(() => sockets[0]!.send({ cursor: 9000, events: [{ id: 9000, task_id: 't_1', kind: 'x' }] }));

    rerender({ b: 'b', s: 12 });
    expect(sockets[1]!.params().since).toBe('12');
  });
});

describe('teardown', () => {
  it('closes the socket and reports dead on unmount', async () => {
    const { result, unmount } = render();
    act(() => sockets[0]!.open());
    await waitFor(() => expect(result.current).toBe(true));

    unmount();
    expect(sockets[0]!.closed).toBe(true);
    // Handlers detached, so a late close cannot set state after unmount.
    expect(sockets[0]!.onclose).toBeNull();
  });

  it('opens nothing at all when disabled', () => {
    renderHook(() => useKanbanEvents(null, 1, false), { wrapper: wrap(qc) });
    expect(sockets).toHaveLength(0);
  });
});
