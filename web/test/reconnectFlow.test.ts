/**
 * Reattaching after the socket came back (`lib/reconnectFlow`).
 *
 * The flow runs against the real session store with the network injected, so
 * what is pinned is the outcome on screen: the transcript actually reloads
 * on a rebuilt runtime, nothing lands once the connection or the conversation
 * has moved on, a turn that ended mid-flight is not replayed twice, and a
 * prompt lost with the old socket is judged by what the gateway says now.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryMessage, SessionCreateResult } from '../src/ws/types';

vi.mock('../src/lib/haptics', () => ({ buzz: vi.fn(), setHapticsEnabled: vi.fn() }));

const call = vi.fn(async () => ({}) as unknown);
const { ConnectionLost } = vi.hoisted(() => ({
  ConnectionLost: class ConnectionLost extends Error {
    constructor(public method = 'prompt.submit') {
      super('connection closed');
      this.name = 'ConnectionLost';
    }
  },
}));
vi.mock('../src/ws/client', () => ({
  hermes: { call: (...a: unknown[]) => call(...(a as [])), onEvent: () => () => {}, onState: () => () => {} },
  CONTROL_TIMEOUT_MS: 15_000,
  ConnectionLost,
}));
vi.mock('../src/api/gateway', () => ({ undoTurns: async () => '' }));

const { useSession } = await import('../src/store/session');
const { reconnectSession } = await import('../src/lib/reconnectFlow');
const store = () => useSession.getState();

/** A promise the test resolves by hand, to stop the flow at an `await`. */
function gate<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const history = (...texts: [role: string, text: string][]): HistoryMessage[] =>
  texts.map(([role, text]) => ({ role, text }));

function deps(over: Partial<Parameters<typeof reconnectSession>[1]> = {}) {
  return {
    resume: vi.fn(async (): Promise<SessionCreateResult> => ({ session_id: 's1', running: false })),
    fetchHistory: vi.fn(async (): Promise<HistoryMessage[]> => []),
    eventsSince: vi.fn(async () => ({ events: [] as unknown[] })),
    rebuild: vi.fn(async () => true),
    isCurrent: () => true,
    ...over,
  };
}

const target = { sessionId: 's1', storedSessionId: 'stored-1', profile: null };

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({});
  store().reset();
  store().adoptSession({ sessionId: 's1', storedSessionId: 'stored-1' });
});

describe('a rebuilt runtime', () => {
  /**
   * The reported bug: the flow's own adopt changed `sessionId`, the effect's
   * cleanup marked it dead, and the history load after the await never ran.
   */
  it('adopts the new handle and still loads the transcript', async () => {
    // Mid-turn when the socket went: a half-written reply and a pulsing card.
    store().applyEvent({ type: 'message.start', session_id: 's1' });
    store().applyEvent({ type: 'message.delta', session_id: 's1', payload: { text: 'Half a rep' } });
    store().applyEvent({ type: 'tool.start', session_id: 's1', payload: { tool_id: 't1', name: 'terminal' } });

    const d = deps({
      resume: vi.fn(async () => ({ session_id: 's2', running: false })),
      fetchHistory: vi.fn(async () => history(['user', 'hi'], ['assistant', 'Half a reply, finished.'])),
    });
    await reconnectSession(target, d);

    expect(store().sessionId).toBe('s2');
    expect(d.fetchHistory).toHaveBeenCalledWith('s2');
    expect(store().messages.map((m) => ('text' in m ? m.text : m.kind))).toEqual(['hi', 'Half a reply, finished.']);
    expect(store().streamingText).toBe('');
    expect(store().running).toBe(false);
    expect(call).toHaveBeenCalledWith('session.usage', { session_id: 's2' });
  });

  it('does not replay the old ring into the new runtime', async () => {
    const d = deps({ resume: vi.fn(async () => ({ session_id: 's2', running: true })) });
    await reconnectSession(target, d);
    expect(d.eventsSince).not.toHaveBeenCalled();
  });
});

describe('liveness', () => {
  it('applies nothing once a newer connection has superseded it', async () => {
    let current = true;
    const resumed = gate<SessionCreateResult>();
    const d = deps({ resume: vi.fn(() => resumed.promise), isCurrent: () => current });

    const flow = reconnectSession(target, d);
    current = false;
    resumed.resolve({ session_id: 's2', running: true });
    await flow;

    expect(store().sessionId).toBe('s1');
    expect(store().running).toBe(false);
    expect(d.fetchHistory).not.toHaveBeenCalled();
  });

  /** Switching conversation mid-flight must not land A's transcript in B. */
  it("does not load the old conversation's history into the one opened since", async () => {
    const fetched = gate<HistoryMessage[]>();
    const d = deps({ fetchHistory: vi.fn(() => fetched.promise) });

    const flow = reconnectSession(target, d);
    await vi.waitFor(() => expect(d.fetchHistory).toHaveBeenCalled());
    store().reset();
    store().adoptSession({ sessionId: 'other' });
    fetched.resolve(history(['user', 'from A']));
    await flow;

    expect(store().sessionId).toBe('other');
    expect(store().messages).toEqual([]);
  });

  it('falls back to the full rebuild when the resume fails', async () => {
    const d = deps({ resume: vi.fn(async () => Promise.reject(new Error('4010'))) });
    await reconnectSession(target, d);
    expect(d.rebuild).toHaveBeenCalledWith('stored-1', null);
  });

  it('does not rebuild on behalf of a connection that has moved on', async () => {
    const d = deps({ resume: vi.fn(async () => Promise.reject(new Error('gone'))), isCurrent: () => false });
    await reconnectSession(target, d);
    expect(d.rebuild).not.toHaveBeenCalled();
  });
});

describe('replaying the running turn', () => {
  it("folds in the turn's tool cards", async () => {
    const d = deps({
      resume: vi.fn(async () => ({ session_id: 's1', running: true })),
      eventsSince: vi.fn(async () => ({
        events: [
          { type: 'message.start', session_id: 's1', seq: 1 },
          { type: 'tool.start', session_id: 's1', seq: 2, payload: { tool_id: 't1', name: 'terminal' } },
        ],
      })),
    });
    await reconnectSession(target, d);
    expect(store().messages.filter((m) => m.kind === 'tool')).toHaveLength(1);
  });

  /**
   * A `message.complete` arriving live while the history was out ended the
   * turn before the replay window opened; replaying from the start then put
   * its cards and its reply on screen twice.
   */
  it('does not replay a turn that completed while the history was out', async () => {
    const ring = [
      { type: 'message.start', session_id: 's1', seq: 1 },
      { type: 'tool.start', session_id: 's1', seq: 2, payload: { tool_id: 't1', name: 'terminal' } },
      { type: 'tool.complete', session_id: 's1', seq: 3, payload: { tool_id: 't1', name: 'terminal' } },
      { type: 'message.complete', session_id: 's1', seq: 4, payload: { text: 'Done.' } },
    ];
    const d = deps({
      resume: vi.fn(async () => ({ session_id: 's1', running: true })),
      fetchHistory: vi.fn(async () => {
        // Live, before the window opens.
        for (const f of ring.slice(1)) store().applyEvent(f);
        return [];
      }),
      eventsSince: vi.fn(async () => ({ events: ring })),
    });
    await reconnectSession(target, d);

    expect(store().messages.filter((m) => m.kind === 'tool')).toHaveLength(1);
    expect(store().messages.filter((m) => m.kind === 'assistant')).toHaveLength(1);
  });
});

describe('a prompt lost with the old socket', () => {
  async function lose(text: string) {
    call.mockRejectedValueOnce(new ConnectionLost());
    await store().submitPrompt(text);
    return store().messages.at(-1)!;
  }

  it('is not marked failed while nobody knows yet', async () => {
    const bubble = await lose('hello');
    expect(bubble).not.toHaveProperty('failed', true);
    expect(store().error).toBeNull();
  });

  it('stays unmarked when the resume shows the turn running', async () => {
    const bubble = await lose('hello');
    await reconnectSession(
      target,
      deps({ resume: vi.fn(async () => ({ session_id: 's1', running: true, inflight: { user: 'hello' } })) }),
    );
    const now = store().messages.find((m) => m.id === bubble.id);
    expect(now).toBeDefined();
    expect(now).not.toHaveProperty('failed', true);
    expect(store().running).toBe(true);
  });

  it('stays unmarked when history shows it went through and finished', async () => {
    await lose('hello');
    await reconnectSession(
      target,
      deps({ fetchHistory: vi.fn(async () => history(['user', 'hello'], ['assistant', 'Hi!'])) }),
    );
    expect(store().messages.some((m) => m.kind === 'user' && m.failed)).toBe(false);
  });

  it('is marked failed when the session is idle and history never got it', async () => {
    const bubble = await lose('hello');
    await reconnectSession(target, deps());
    expect(store().messages.find((m) => m.id === bubble.id)).toMatchObject({ text: 'hello', failed: true });
  });

  it('survives a rebuilt runtime, marked, rather than vanishing with the old transcript', async () => {
    await lose('hello');
    await reconnectSession(
      target,
      deps({
        resume: vi.fn(async () => ({ session_id: 's2', running: false })),
        fetchHistory: vi.fn(async () => history(['user', 'earlier'], ['assistant', 'ok'])),
      }),
    );
    expect(store().messages.at(-1)).toMatchObject({ kind: 'user', text: 'hello', failed: true });
  });
});

/**
 * The same text sent again. History was searched for a last user row with
 * the lost prompt's text, so the *previous* "yes" read as this one delivered:
 * the bubble was never marked failed, or vanished under the reloaded
 * transcript. A row only counts when it is newer than the screen it was sent
 * from.
 */
describe('a lost prompt repeating the one before it', () => {
  const earlier = () => history(['user', 'yes'], ['assistant', 'Done.']);

  async function loseRepeat() {
    store().loadHistory(earlier());
    call.mockRejectedValueOnce(new ConnectionLost());
    await store().submitPrompt('yes');
    return store().messages.at(-1)!;
  }

  it('is marked failed when history holds only the earlier copy', async () => {
    const bubble = await loseRepeat();
    await reconnectSession(target, deps({ fetchHistory: vi.fn(async () => earlier()) }));
    expect(store().messages.find((m) => m.id === bubble.id)).toMatchObject({ text: 'yes', failed: true });
    expect(store().running).toBe(false);
  });

  it('survives a rebuilt runtime, marked, rather than vanishing under the earlier copy', async () => {
    await loseRepeat();
    await reconnectSession(
      target,
      deps({ resume: vi.fn(async () => ({ session_id: 's2', running: false })), fetchHistory: vi.fn(async () => earlier()) }),
    );
    expect(store().messages.filter((m) => m.kind === 'user')).toEqual([
      expect.objectContaining({ text: 'yes' }),
      expect.objectContaining({ text: 'yes', failed: true }),
    ]);
  });

  it('stands when history holds a second copy after the first', async () => {
    await loseRepeat();
    await reconnectSession(
      target,
      deps({ fetchHistory: vi.fn(async () => [...earlier(), ...history(['user', 'yes'], ['assistant', 'Again.'])]) }),
    );
    expect(store().messages.some((m) => m.kind === 'user' && m.failed)).toBe(false);
  });

  /** With row ids, newer is by id — a rewritten front of the transcript cannot shift it. */
  it('is judged by stored row id when history carries them', async () => {
    const rows = (...r: [string, string, number][]) =>
      r.map(([role, text, row_id]) => ({ role, text, row_id })) as HistoryMessage[];
    store().loadHistory(rows(['user', 'yes', 10], ['assistant', 'Done.', 11]));
    call.mockRejectedValueOnce(new ConnectionLost());
    await store().submitPrompt('yes');
    const bubble = store().messages.at(-1)!;

    // A compression dropped a row from the front: fewer user rows than the
    // screen had, but the newer id is this prompt.
    await reconnectSession(
      target,
      deps({ fetchHistory: vi.fn(async () => rows(['user', 'yes', 12], ['assistant', 'Again.', 13])) }),
    );
    expect(store().messages.find((m) => m.id === bubble.id)).not.toHaveProperty('failed', true);
  });
});

/**
 * Something typed after the socket went is queued — `running` stays true on
 * purpose while a lost submit is unsettled — and only a `message.complete`
 * released the queue. A resume reporting idle is that turn's end too.
 */
describe('a message queued behind a turn that ended unseen', () => {
  const submits = (text: string) =>
    call.mock.calls.filter(([m, p]) => m === 'prompt.submit' && (p as { text?: string }).text === text);

  async function queueBehindLost() {
    call.mockRejectedValueOnce(new ConnectionLost());
    await store().submitPrompt('first');
    await store().submitPrompt('second');
    expect(store().queued).toMatchObject({ text: 'second' });
  }

  it('goes out once the gateway says the session is idle', async () => {
    await queueBehindLost();
    await reconnectSession(target, deps());
    expect(store().queued).toBeNull();
    expect(submits('second')).toHaveLength(1);
  });

  it('goes out exactly once, whatever else then reports the end', async () => {
    await queueBehindLost();
    await reconnectSession(target, deps());
    // The released prompt's own turn ends, and a second reconnect reports idle.
    store().applyEvent({ type: 'message.complete', session_id: 's1', payload: { text: 'ok' } });
    await reconnectSession(target, deps());
    expect(submits('second')).toHaveLength(1);
  });

  it('goes out after a rebuilt runtime too', async () => {
    await queueBehindLost();
    await reconnectSession(target, deps({ resume: vi.fn(async () => ({ session_id: 's2', running: false })) }));
    expect(call).toHaveBeenCalledWith('prompt.submit', { session_id: 's2', text: 'second' });
  });

  it('is held, not sent, when Stop was pressed before the socket went', async () => {
    store().applyEvent({ type: 'message.start', session_id: 's1' });
    await store().submitPrompt('second');
    await store().interrupt();
    await reconnectSession(target, deps());
    expect(submits('second')).toHaveLength(0);
    expect(store().queued).toMatchObject({ text: 'second' });
  });

  it('is not released while the turn is still running', async () => {
    await queueBehindLost();
    await reconnectSession(target, deps({ resume: vi.fn(async () => ({ session_id: 's1', running: true })) }));
    expect(submits('second')).toHaveLength(0);
  });

  /** Hermes runs its own queued prompt; sending the copy too would run it twice. */
  it("never sends the gateway's own queued copy", async () => {
    store().applyLiveState({ session_id: 's1', running: true, queued: { user: 'theirs' } });
    await reconnectSession(target, deps());
    expect(submits('theirs')).toHaveLength(0);
    expect(store().queued).toBeNull();
  });
});

/**
 * No stored id means no resume and so no `running` from the gateway, and a
 * lost submit's history is shorter than the screen — the one case the length
 * guess cannot end. The stop button stayed lit for ever.
 */
describe('a lost prompt in a conversation with no stored id', () => {
  const unsaved = { ...target, storedSessionId: null };

  it('settles, and the session goes idle', async () => {
    call.mockRejectedValueOnce(new ConnectionLost());
    await store().submitPrompt('hello');
    const bubble = store().messages.at(-1)!;
    await reconnectSession(unsaved, deps());
    expect(store().running).toBe(false);
    expect(store().lostSubmit).toBeNull();
    expect(store().messages.find((m) => m.id === bubble.id)).toMatchObject({ failed: true });
  });

  it('stands when history shows it went through', async () => {
    call.mockRejectedValueOnce(new ConnectionLost());
    await store().submitPrompt('hello');
    await reconnectSession(unsaved, deps({ fetchHistory: vi.fn(async () => history(['user', 'hello'], ['assistant', 'Hi!'])) }));
    expect(store().running).toBe(false);
    expect(store().messages.some((m) => m.kind === 'user' && m.failed)).toBe(false);
  });
});
