/**
 * Replaying a running turn after a reconnect.
 *
 * A reconnect mid-turn rebuilds the transcript from history, which ends at
 * the turn before — so the running turn's tool cards vanished until it
 * finished. `applyReplay` restores them from the gateway's event ring. What is
 * worth pinning is what it must *not* do: print the reply twice, re-apply
 * what already arrived live, or reach back into an earlier turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const buzz = vi.fn();
vi.mock('../src/lib/haptics', () => ({ buzz: (...a: unknown[]) => buzz(...a), setHapticsEnabled: vi.fn() }));
vi.mock('../src/ws/client', () => ({
  hermes: { call: vi.fn(async () => ({})), onEvent: () => () => {}, onState: () => () => {}, state: 'open' },
  CONTROL_TIMEOUT_MS: 15_000,
}));
vi.mock('../src/api/gateway', () => ({ undoTurns: async () => '' }));

const { useSession } = await import('../src/store/session');
const store = () => useSession.getState();

let seq = 0;
const ev = (type: string, payload?: unknown) => ({ type, session_id: 's1', payload, seq: ++seq });
const tools = () => store().messages.filter((m) => m.kind === 'tool').map((m) => (m as { toolId?: string }).toolId);

beforeEach(() => {
  seq = 0;
  buzz.mockClear();
  store().reset();
  store().adoptSession({ sessionId: 's1' });
});

describe('applyReplay', () => {
  it("restores the running turn's tool cards", () => {
    const ring = [
      ev('message.start'),
      ev('tool.start', { tool_id: 't1', name: 'terminal' }),
      ev('tool.complete', { tool_id: 't1', name: 'terminal' }),
      ev('tool.start', { tool_id: 't2', name: 'web_search' }),
    ];
    store().beginReplayWindow();

    expect(store().applyReplay(ring)).toBe(true);
    expect(tools()).toEqual(['t1', 't2']);
  });

  it('starts from the last message.start, not from earlier turns in the ring', () => {
    const ring = [
      ev('message.start'),
      ev('tool.start', { tool_id: 'old', name: 'terminal' }),
      ev('message.complete', { text: 'done' }),
      ev('message.start'),
      ev('tool.start', { tool_id: 'new', name: 'terminal' }),
    ];
    store().beginReplayWindow();
    store().applyReplay(ring);

    expect(tools()).toEqual(['new']);
  });

  /** `inflight` already restored the reply; the deltas would print it twice. */
  it('does not replay text deltas', () => {
    store().applyLiveState({ session_id: 's1', running: true, inflight: { user: 'hi', assistant: 'Hello wor' } });
    store().beginReplayWindow();
    store().applyReplay([
      ev('message.start'),
      ev('message.delta', { text: 'Hello ' }),
      ev('message.delta', { text: 'wor' }),
    ]);

    expect(store().streamingText).toBe('Hello wor');
  });

  /** Events keep arriving live during the round trip, and the ring has them too. */
  it('skips what already arrived live while the replay was in flight', () => {
    const start = ev('message.start');
    const gap = ev('tool.start', { tool_id: 't1', name: 'terminal' });
    const live = ev('tool.start', { tool_id: 't2', name: 'terminal' });

    store().beginReplayWindow();
    store().applyEvent(live);
    store().applyReplay([start, gap, live]);

    expect(tools()).toEqual(['t2', 't1']);
  });

  /** A long turn can push its own start out of the ring; then nothing changes. */
  it('changes nothing when the ring no longer reaches the turn start', () => {
    store().beginReplayWindow();
    expect(store().applyReplay([ev('tool.start', { tool_id: 't9', name: 'terminal' })])).toBe(false);
    expect(tools()).toEqual([]);
  });

  it('restores the cards without buzzing for each of them', () => {
    store().beginReplayWindow();
    store().applyReplay([
      ev('message.start'),
      ev('tool.start', { tool_id: 't1', name: 'terminal' }),
      ev('tool.start', { tool_id: 't2', name: 'terminal' }),
    ]);

    expect(buzz).not.toHaveBeenCalled();
  });

  it('closes the window, so later live events are not mistaken for a floor', () => {
    store().beginReplayWindow();
    store().applyReplay([]);
    store().applyEvent(ev('tool.start', { tool_id: 'later', name: 'terminal' }));

    expect(buzz).toHaveBeenCalled();
    expect(tools()).toEqual(['later']);
  });
});
