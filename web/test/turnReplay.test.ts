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
  // A replay only ever runs for a turn the resume said is running.
  useSession.setState({ running: true });
});

describe('applyReplay', () => {
  it("restores the running turn's tool cards", () => {
    const ring = [
      ev('message.start'),
      ev('tool.start', { tool_id: 't1', name: 'terminal' }),
      ev('tool.complete', { tool_id: 't1', name: 'terminal' }),
      ev('tool.start', { tool_id: 't2', name: 'web_search' }),
    ];
    const w = store().beginReplayWindow();

    expect(store().applyReplay(ring, w)).toBe(true);
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
    const w = store().beginReplayWindow();
    store().applyReplay(ring, w);

    expect(tools()).toEqual(['new']);
  });

  /** `inflight` already restored the reply; the deltas would print it twice. */
  it('does not replay text deltas', () => {
    store().applyLiveState({ session_id: 's1', running: true, inflight: { user: 'hi', assistant: 'Hello wor' } });
    const w = store().beginReplayWindow();
    store().applyReplay([
      ev('message.start'),
      ev('message.delta', { text: 'Hello ' }),
      ev('message.delta', { text: 'wor' }),
    ], w);

    expect(store().streamingText).toBe('Hello wor');
  });

  /** Events keep arriving live during the round trip, and the ring has them too. */
  it('skips what already arrived live while the replay was in flight', () => {
    const start = ev('message.start');
    const gap = ev('tool.start', { tool_id: 't1', name: 'terminal' });
    const live = ev('tool.start', { tool_id: 't2', name: 'terminal' });

    const w = store().beginReplayWindow();
    store().applyEvent(live);
    store().applyReplay([start, gap, live], w);

    expect(tools()).toEqual(['t2', 't1']);
  });

  /** A long turn can push its own start out of the ring; then nothing changes. */
  it('changes nothing when the ring no longer reaches the turn start', () => {
    const w = store().beginReplayWindow();
    expect(store().applyReplay([ev('tool.start', { tool_id: 't9', name: 'terminal' })], w)).toBe(false);
    expect(tools()).toEqual([]);
  });

  it('restores the cards without buzzing for each of them', () => {
    const w = store().beginReplayWindow();
    store().applyReplay([
      ev('message.start'),
      ev('tool.start', { tool_id: 't1', name: 'terminal' }),
      ev('tool.start', { tool_id: 't2', name: 'terminal' }),
    ], w);

    expect(buzz).not.toHaveBeenCalled();
  });

  /**
   * Two reconnect flows can overlap. With one module-wide floor the first to
   * finish closed the window under the second, which then replayed what had
   * already arrived live — here a notice, printed twice.
   */
  it("keeps one flow's window open when another closes", () => {
    const start = ev('message.start');
    const live = ev('error', { message: 'Tool quota hit' });

    const first = store().beginReplayWindow();
    const second = store().beginReplayWindow();
    store().applyEvent(live);
    store().applyReplay([], first);
    store().applyReplay([start, live], second);

    expect(store().messages.filter((m) => m.kind === 'notice')).toHaveLength(1);
  });

  it('closes the window, so later live events are not mistaken for a floor', () => {
    const w = store().beginReplayWindow();
    store().applyReplay([], w);
    store().applyEvent(ev('tool.start', { tool_id: 'later', name: 'terminal' }));

    expect(buzz).toHaveBeenCalled();
    expect(tools()).toEqual(['later']);
  });
});

describe('applyReplay on a turn that is over', () => {
  it('does nothing when the session is no longer running', () => {
    useSession.setState({ running: false });
    const w = store().beginReplayWindow();
    expect(store().applyReplay([ev('message.start'), ev('tool.start', { tool_id: 't1', name: 'terminal' })], w)).toBe(false);
    expect(tools()).toEqual([]);
  });

  /**
   * Running again already — a queued prompt released by the live completion —
   * but the ring's last start is still the finished turn's.
   */
  it('does nothing when the ring holds the turn completing', () => {
    const w = store().beginReplayWindow();
    const applied = store().applyReplay([
      ev('message.start'),
      ev('tool.start', { tool_id: 't1', name: 'terminal' }),
      ev('message.complete', { text: 'Done.' }),
    ], w);

    expect(applied).toBe(false);
    expect(tools()).toEqual([]);
    expect(store().messages.filter((m) => m.kind === 'assistant')).toEqual([]);
  });

  /** A resync that kept the local transcript keeps the turn's cards too. */
  it('does not start a card that is already on screen again', () => {
    store().applyEvent({ type: 'tool.start', session_id: 's1', payload: { tool_id: 't1', name: 'terminal' } });
    const w = store().beginReplayWindow();
    store().applyReplay([ev('message.start'), ev('tool.start', { tool_id: 't1', name: 'terminal' })], w);

    expect(tools()).toEqual(['t1']);
  });
});
