/**
 * Arriving in the middle of a turn.
 *
 * `message.start` is what tells the store a turn is running, and it is the one
 * event a client that arrived late can never see: the phone backgrounds the
 * PWA, the OS discards the page, and everything that comes back does so after
 * the turn began. The store believed the session was idle for the rest of it —
 * no stop button, no working indicator, no sign of the prompt being answered,
 * and the next message fired at a session the gateway rejects as busy (4009)
 * and stamped `failed`.
 *
 * `session.resume` answers with all of it (`running`, `inflight`, `queued`,
 * `pending_approval`, `pending_clarify`) and the app used to read only the
 * clarify. What is tested here is that it now reads the rest, that a live
 * event is a second line of defence when it does not, and that neither of them
 * leaves anything running after the turn ends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/haptics', () => ({ buzz: vi.fn(), setHapticsEnabled: vi.fn() }));

const call = vi.fn(async () => ({}) as unknown);
vi.mock('../src/ws/client', () => ({
  hermes: {
    call: (...args: unknown[]) => call(...(args as [])),
    onEvent: () => () => {},
    onState: () => () => {},
    state: 'open',
  },
}));
vi.mock('../src/api/gateway', () => ({ undoTurns: vi.fn(async () => '') }));

const { useSession } = await import('../src/store/session');

const store = () => useSession.getState();
const emit = (type: string, payload?: unknown, session_id = 's1') =>
  store().applyEvent({ type, session_id, payload });

/** The shape `session.resume` answers with, minus what this file ignores. */
const resumed = (over: Record<string, unknown> = {}) => ({
  session_id: 's1',
  running: true,
  ...over,
});

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({});
  store().reset();
  store().adoptSession({ sessionId: 's1' });
});

describe('adopting the gateway’s live-turn state', () => {
  it('reports a turn that started before this client existed', () => {
    store().applyLiveState(resumed());

    expect(store().running).toBe(true);
  });

  it('holds the reply so far, which no transcript has yet', () => {
    store().applyLiveState(resumed({ inflight: { user: 'go on', assistant: 'Half a re' } }));

    expect(store().streamingText).toBe('Half a re');
  });

  /**
   * A reconnect can land while deltas are still arriving, so this client may
   * hold *more* of the turn than the snapshot does. Both are the same text
   * accumulated from the same stream — the longer one is the newer one, and
   * assigning the snapshot over it would visibly rewind the reply.
   */
  it('never rewinds a reply this client has more of', () => {
    emit('message.delta', { text: 'Half a reply already here' });

    store().applyLiveState(resumed({ inflight: { user: 'go on', assistant: 'Half a re' } }));

    expect(store().streamingText).toBe('Half a reply already here');
  });

  it('stands down when the gateway says the session is idle', () => {
    useSession.setState({ running: true, streamingText: 'stale' });

    store().applyLiveState({ session_id: 's1', running: false });

    expect(store().running).toBe(false);
  });

  /**
   * Both prompts block the agent, both fired at a client that was not
   * listening, and only a resume can surface them again. The approval was
   * dropped outright before this — the turn sat stopped with nothing on screen
   * able to release it.
   */
  it('restores an approval raised while nothing was connected', () => {
    store().applyLiveState(
      resumed({ pending_approval: { tool: 'bash', command: 'rm -rf build' } }),
    );

    expect(store().approval).toMatchObject({ tool: 'bash', command: 'rm -rf build' });
  });

  it('restores a question the agent is parked on', () => {
    store().applyLiveState(
      resumed({ pending_clarify: { request_id: 'r1', question: 'Which branch?' } }),
    );

    expect(store().clarify).toMatchObject({ requestId: 'r1' });
    expect(store().clarify?.questions[0]?.question).toBe('Which branch?');
  });

  it('shows a prompt the gateway is holding for the next turn', () => {
    store().applyLiveState(resumed({ queued: { user: 'and then deploy it' } }));

    expect(store().queued).toEqual({ text: 'and then deploy it' });
  });

  /** The local one has not been sent anywhere, and may carry a `display`. */
  it('does not overwrite a message held here', () => {
    useSession.setState({ queued: { text: '/deploy', display: '/deploy' } });

    store().applyLiveState(resumed({ queued: { user: 'something else' } }));

    expect(store().queued).toEqual({ text: '/deploy', display: '/deploy' });
  });
});

describe('the prompt a running turn is answering', () => {
  /**
   * `session.history` answers from the session store, and Hermes writes a turn
   * there when it ends — so a transcript fetched mid-turn stops at the turn
   * before. Reopening the app while the agent worked showed no trace of the
   * question it was working on.
   */
  it('is grafted onto a transcript that stops before it', () => {
    store().applyLiveState(resumed({ inflight: { user: 'summarise the logs', assistant: '' } }));
    store().loadHistory([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ]);

    expect(store().messages.at(-1)).toMatchObject({ kind: 'user', text: 'summarise the logs' });
  });

  it('carries mid-turn corrections too', () => {
    store().applyLiveState(
      resumed({ inflight: { user: 'summarise the logs', corrections: ['only the errors'] } }),
    );
    store().loadHistory([{ role: 'user', text: 'hi' }]);

    expect(store().messages.map((m) => 'text' in m && m.text)).toEqual([
      'hi',
      'summarise the logs',
      'only the errors',
    ]);
  });

  /** A turn that completes between the resume and the fetch lands in both. */
  it('is not duplicated when history turns out to have it', () => {
    store().applyLiveState(resumed({ inflight: { user: 'summarise the logs' } }));
    store().loadHistory([{ role: 'user', text: 'summarise the logs' }]);

    expect(store().messages).toHaveLength(1);
  });

  it('is not grafted onto an idle session', () => {
    store().applyLiveState({
      session_id: 's1',
      running: false,
      inflight: { user: 'summarise the logs' },
    });
    store().loadHistory([{ role: 'user', text: 'hi' }]);

    expect(store().messages).toHaveLength(1);
  });

  /** The bubble that submitted it is the transcript's copy from then on. */
  it('is dropped once this client sends a turn of its own', async () => {
    store().applyLiveState(resumed({ inflight: { user: 'summarise the logs' } }));
    emit('message.complete', { text: 'done' });
    await store().submitPrompt('next thing');

    store().loadHistory([{ role: 'user', text: 'next thing' }]);

    expect(store().messages).toHaveLength(1);
  });
});

describe('a live event as the backstop', () => {
  it('treats anything arriving from a turn as a turn running', () => {
    for (const type of ['message.delta', 'reasoning.delta', 'tool.generating', 'thinking.delta']) {
      useSession.setState({ running: false });
      emit(type, { text: 'x', name: 'bash' });
      expect(store().running, type).toBe(true);
    }
  });

  /**
   * `status.update` is not turn-scoped: `session.compress` is refused while a
   * turn is running and emits one anyway. Trusting it would light the stop
   * button on an idle session, with no `message.complete` coming to clear it.
   */
  it('does not let a status line start one', () => {
    emit('status.update', { text: 'compressing 40 messages…' });

    expect(store().running).toBe(false);
    expect(store().statusLine).toBe('compressing 40 messages…');
  });

  it('does not let a completion start one', () => {
    emit('message.complete', { text: 'a reply that arrived after we reconnected' });

    expect(store().running).toBe(false);
  });

  /** One socket, every session on it — the guard that keeps them apart. */
  it('ignores a turn running in another conversation', () => {
    emit('message.delta', { text: 'not yours' }, 'other');

    expect(store().running).toBe(false);
  });
});

describe('ending a turn', () => {
  /**
   * A tool card is cleared by its own `tool.complete`, which an interrupt or a
   * dropped socket loses — and the card then pulses for ever on a finished
   * conversation, because nothing looked at it again.
   */
  it('stops a tool card that never got its completion', () => {
    emit('message.start');
    emit('tool.start', { tool_id: 't1', name: 'bash' });
    emit('message.complete', { text: 'done', status: 'interrupted' });

    expect(store().messages.find((m) => m.kind === 'tool')).toMatchObject({ status: 'done' });
  });

  it('stops a subagent card the same way', () => {
    emit('subagent.start', { subagent_id: 'a1', goal: 'read the docs' });
    emit('message.complete', { text: 'done' });

    expect(store().messages.find((m) => m.kind === 'subagent')).toMatchObject({ status: 'done' });
  });
});

describe('reconciling after a reconnect', () => {
  const history = [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello' },
  ];

  /**
   * The length heuristic this replaces is a guess, and wrong in a case that
   * happens constantly: a turn completing and another starting grows the
   * transcript while the session is very much still working, and the guess
   * read that growth as "the turn ended" — taking the stop button away
   * mid-turn, which is precisely when it is the only control that matters.
   */
  it('keeps a live turn even though the transcript grew', () => {
    store().loadHistory([history[0]!]);
    useSession.setState({ running: true, streamingText: 'still going' });

    store().applyResync(history, { running: true });

    expect(store().running).toBe(true);
    expect(store().streamingText).toBe('still going');
  });

  it('tears one down even though it did not', () => {
    store().loadHistory(history);
    useSession.setState({ running: true, streamingText: 'half a repl' });

    store().applyResync(history, { running: false });

    expect(store().running).toBe(false);
    expect(store().streamingText).toBe('');
  });

  /** No resume result to ask — the old heuristic is still the fallback. */
  it('falls back to the transcript growing when nobody said', () => {
    store().loadHistory([history[0]!]);
    useSession.setState({ running: true });

    store().applyResync(history);

    expect(store().running).toBe(false);
  });
});

describe('the message sent next', () => {
  /**
   * The gateway runs one turn per session and rejects a second (4009), which
   * the store surfaced as a bubble stamped `failed`. Holding it is the whole
   * point of knowing a turn is running.
   */
  it('is queued behind a turn this client never saw start', async () => {
    store().applyLiveState(resumed());

    await store().submitPrompt('and now this');

    expect(call).not.toHaveBeenCalled();
    expect(store().queued).toEqual({ text: 'and now this', display: undefined });
    expect(store().messages).toEqual([]);
  });
});
