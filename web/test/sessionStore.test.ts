/**
 * The chat store: gateway events folded into a transcript.
 *
 * The gateway streams a turn as `message.start` → deltas → tool cards →
 * `message.complete`, and it broadcasts every session over one socket. Most of
 * what is tested here is about not showing the user something untrue: another
 * conversation's tokens, a reply that was interrupted, or a message they typed
 * being erased by a reconnect.
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

const undoTurns = vi.fn(async () => '');
vi.mock('../src/api/gateway', () => ({ undoTurns: (...a: unknown[]) => undoTurns(...(a as [])) }));

const { useSession } = await import('../src/store/session');

const store = () => useSession.getState();
const emit = (type: string, payload?: unknown, session_id = 's1') =>
  store().applyEvent({ type, session_id, payload });

/** Deliver a whole turn's worth of events, as the gateway would. */
function turn(text: string): void {
  emit('message.start');
  for (const chunk of text.match(/.{1,4}/g) ?? []) emit('message.delta', { text: chunk });
  emit('message.complete', { text });
}

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({});
  undoTurns.mockReset();
  undoTurns.mockResolvedValue('');
  store().reset();
  store().adoptSession({ sessionId: 's1' });
});

describe('streaming a turn', () => {
  it('accumulates deltas without touching the transcript', () => {
    emit('message.start');
    emit('message.delta', { text: 'Hel' });
    emit('message.delta', { text: 'lo' });

    expect(store().streamingText).toBe('Hello');
    expect(store().messages).toEqual([]);
    expect(store().running).toBe(true);
  });

  it('commits the reply and clears the buffers on completion', () => {
    turn('Hello there');

    expect(store().streamingText).toBe('');
    expect(store().running).toBe(false);
    expect(store().messages).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'Hello there' }),
    ]);
  });

  it('starts a second turn from an empty buffer', () => {
    turn('first');
    emit('message.start');
    expect(store().streamingText).toBe('');
    expect(store().messages).toHaveLength(1);
  });

  it('falls back to the accumulated text when completion carries none', () => {
    emit('message.start');
    emit('message.delta', { text: 'partial answer' });
    emit('message.complete', {});
    expect(store().messages.at(-1)).toMatchObject({ text: 'partial answer' });
  });

  it('keeps reasoning separate from the reply', () => {
    emit('message.start');
    emit('reasoning.delta', { text: 'let me think' });
    emit('message.delta', { text: 'the answer' });
    expect(store().streamingReasoning).toBe('let me think');
    expect(store().streamingText).toBe('the answer');
  });

  /**
   * `thinking.delta` is a decorative "pondering…" placeholder, not content.
   * Appending it to the transcript would put the model's filler in the reply.
   */
  it('treats thinking.delta as a transient hint', () => {
    emit('message.start');
    emit('thinking.delta', { text: 'pondering…' });
    expect(store().thinkingHint).toBe('pondering…');

    emit('message.delta', { text: 'real text' });
    expect(store().thinkingHint).toBe('');
  });

  it('ignores a delta with no text', () => {
    emit('message.start');
    emit('message.delta', { text: 42 });
    emit('message.delta', null);
    expect(store().streamingText).toBe('');
  });

  it('marks an interrupted turn as such', () => {
    emit('message.start');
    emit('message.complete', { text: 'half an', status: 'interrupted' });
    expect(store().messages.at(-1)).toMatchObject({ interrupted: true });
  });
});

describe('session isolation', () => {
  /**
   * One socket carries every session. Without this check a turn still
   * streaming in the conversation you just left goes on writing into the one
   * you just opened.
   */
  it('drops events belonging to another conversation', () => {
    emit('message.start', undefined, 's2');
    emit('message.delta', { text: 'not yours' }, 's2');
    emit('message.complete', { text: 'not yours' }, 's2');

    expect(store().messages).toEqual([]);
    expect(store().streamingText).toBe('');
    expect(store().running).toBe(false);
  });

  it('accepts global events that carry no session', () => {
    store().applyEvent({ type: 'session.title', payload: { title: 'Global' } });
    expect(store().title).toBe('Global');
  });

  /**
   * `reset()` clears the session id, and the resume round trip that follows is
   * a window in which the outgoing conversation is still streaming.
   */
  it('drops session events while no conversation is adopted', () => {
    store().reset();
    emit('message.complete', { text: 'orphan' });
    expect(store().messages).toEqual([]);
  });
});

describe('tool cards', () => {
  it('appends a running card and resolves it in place', () => {
    emit('tool.start', { tool_id: 't1', name: 'Bash', context: 'ls -la' });
    expect(store().messages).toEqual([
      expect.objectContaining({ kind: 'tool', name: 'Bash', status: 'running' }),
    ]);

    emit('tool.complete', { tool_id: 't1', name: 'Bash', result: 'ok', duration_s: 1.5 });
    expect(store().messages).toHaveLength(1);
    expect(store().messages[0]).toMatchObject({ status: 'done', result: 'ok', durationS: 1.5 });
  });

  it('interleaves tool cards with the reply in arrival order', () => {
    emit('message.start');
    emit('tool.start', { tool_id: 't1', name: 'Read' });
    emit('tool.complete', { tool_id: 't1', name: 'Read' });
    emit('message.complete', { text: 'I read it.' });

    expect(store().messages.map((m) => m.kind)).toEqual(['tool', 'assistant']);
  });

  it('ignores a completion for a tool it never saw start', () => {
    emit('tool.complete', { tool_id: 'unknown', name: 'Bash' });
    expect(store().messages).toEqual([]);
  });

  it('ignores a malformed tool event', () => {
    emit('tool.start', { name: 'no id' });
    expect(store().messages).toEqual([]);
  });

  it('clears the preparing status once the tool starts', () => {
    emit('tool.generating', { name: 'Bash' });
    expect(store().statusLine).toBe('Preparing Bash…');
    emit('tool.start', { tool_id: 't1', name: 'Bash' });
    expect(store().statusLine).toBe('');
  });
});

describe('subagent cards', () => {
  it('opens one card per spawn and updates it in place', () => {
    emit('subagent.start', { subagent_id: 'a1', goal: 'Explore the codebase', model: 'opus' });
    emit('subagent.tool', { subagent_id: 'a1', tool_name: 'Grep' });
    emit('subagent.complete', {
      subagent_id: 'a1',
      summary: 'Found it',
      duration_seconds: 12,
      input_tokens: 100,
      output_tokens: 50,
    });

    expect(store().messages).toHaveLength(1);
    expect(store().messages[0]).toMatchObject({
      kind: 'subagent',
      goal: 'Explore the codebase',
      status: 'done',
      summary: 'Found it',
      durationS: 12,
      tokens: 150,
      activity: undefined,
    });
  });

  it('keeps two spawns on separate cards', () => {
    emit('subagent.start', { subagent_id: 'a1', goal: 'One' });
    emit('subagent.start', { subagent_id: 'a2', goal: 'Two' });
    expect(store().messages).toHaveLength(2);
  });

  /**
   * Older emitters omit every identity field. Falling back to one flat card is
   * a worse transcript than a proper one, but a card per event is unusable.
   */
  it('degrades to a single card when the spawn is unidentified', () => {
    emit('subagent.start', { goal: 'Anonymous' });
    emit('subagent.tool', { tool_name: 'Read' });
    emit('subagent.complete', { summary: 'done' });
    expect(store().messages).toHaveLength(1);
  });

  it('still shows a card when the start event was missed', () => {
    emit('subagent.complete', { subagent_id: 'a1', summary: 'Finished' });
    expect(store().messages[0]).toMatchObject({ kind: 'subagent', status: 'done' });
  });
});

describe('approvals', () => {
  it('raises a sheet and keys it so a stale one cannot answer', () => {
    emit('approval.request', { tool: 'Bash', command: 'rm -rf /' });
    const first = store().approval!;
    expect(first).toMatchObject({ tool: 'Bash', choices: ['once', 'deny'] });

    emit('approval.request', { tool: 'Write' });
    expect(store().approval!.id).toBeGreaterThan(first.id);
  });

  it('defaults the choices so the sheet is never buttonless', () => {
    emit('approval.request', { tool: 'Bash' });
    expect(store().approval!.choices).toEqual(['once', 'deny']);
  });

  it('sends the answer and dismisses the sheet', async () => {
    emit('approval.request', { tool: 'Bash' });
    await store().respondApproval('once', true);

    expect(call).toHaveBeenCalledWith('approval.respond', {
      session_id: 's1',
      choice: 'once',
      all: true,
    });
    expect(store().approval).toBeNull();
  });

  it('surfaces a rejected answer', async () => {
    emit('approval.request', { tool: 'Bash' });
    call.mockRejectedValueOnce(new Error('gateway said no'));
    await store().respondApproval('deny');
    expect(store().error).toBe('gateway said no');
  });
});

describe('submitting', () => {
  it('adds the bubble and calls the gateway', async () => {
    await store().submitPrompt('hello');
    expect(call).toHaveBeenCalledWith('prompt.submit', { session_id: 's1', text: 'hello' });
    expect(store().messages[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect(store().running).toBe(true);
  });

  it('ignores an empty prompt', async () => {
    await store().submitPrompt('   ');
    expect(call).not.toHaveBeenCalled();
  });

  it('ignores a prompt with no session', async () => {
    store().reset();
    await store().submitPrompt('hello');
    expect(call).not.toHaveBeenCalled();
  });

  /**
   * Losing what someone typed is the worst possible answer to a dropped
   * connection, so the bubble stays and offers to send itself again.
   */
  it('keeps a failed submit in the transcript, marked', async () => {
    call.mockRejectedValueOnce(new Error('not connected'));
    await store().submitPrompt('hello');

    expect(store().messages[0]).toMatchObject({ kind: 'user', text: 'hello', failed: true });
    expect(store().running).toBe(false);
    expect(store().error).toBe('not connected');
  });

  it('marks the bubble that actually failed, not the latest one', async () => {
    let release: (v: unknown) => void = () => {};
    call.mockImplementationOnce(() => new Promise((_, rej) => (release = rej)));
    const first = store().submitPrompt('first');

    // A second message typed while the first is in flight is queued, not sent.
    await store().submitPrompt('second');

    release(new Error('boom'));
    await first;

    const users = store().messages.filter((m) => m.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: 'first', failed: true });
  });

  it('resends a failed bubble without asking the gateway to undo anything', async () => {
    call.mockRejectedValueOnce(new Error('not connected'));
    await store().submitPrompt('hello');
    const id = store().messages[0]!.id;

    call.mockResolvedValueOnce({});
    await store().resendFailed(id);

    expect(undoTurns).not.toHaveBeenCalled();
    expect(store().messages.filter((m) => m.kind === 'user')).toHaveLength(1);
    expect(store().messages[0]).not.toHaveProperty('failed', true);
  });

  it('keeps the short invocation visible for an expanded skill command', async () => {
    await store().submitPrompt('EXPANDED PROMPT', { display: '/digest' });
    expect(store().messages[0]).toMatchObject({
      text: 'EXPANDED PROMPT',
      displayText: '/digest',
    });
  });
});

describe('queueing during a turn', () => {
  it('holds a message typed mid-turn instead of losing it', async () => {
    emit('message.start');
    await store().submitPrompt('while you were busy');

    expect(call).not.toHaveBeenCalled();
    expect(store().queued).toEqual({ text: 'while you were busy', display: undefined });
  });

  it('keeps only the latest, matching what the box shows', async () => {
    emit('message.start');
    await store().submitPrompt('first');
    await store().submitPrompt('second');
    expect(store().queued).toMatchObject({ text: 'second' });
  });

  it('releases it when the turn completes', async () => {
    emit('message.start');
    await store().submitPrompt('next question');
    emit('message.complete', { text: 'done' });
    await Promise.resolve();

    expect(store().queued).toBeNull();
    expect(call).toHaveBeenCalledWith('prompt.submit', {
      session_id: 's1',
      text: 'next question',
    });
  });

  /**
   * The user stopped the agent. Firing the next prompt at it immediately is
   * the opposite of what they asked for.
   */
  it('holds it back when the turn was interrupted', async () => {
    emit('message.start');
    await store().submitPrompt('next question');
    emit('message.complete', { text: 'half', status: 'interrupted' });
    await Promise.resolve();

    expect(store().queued).toMatchObject({ text: 'next question' });
    expect(call).not.toHaveBeenCalled();
  });

  it('can be discarded', async () => {
    emit('message.start');
    await store().submitPrompt('never mind');
    store().clearQueued();
    expect(store().queued).toBeNull();
  });
});

describe('history', () => {
  const history = [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello' },
    { role: 'tool', name: 'Bash', context: 'ls' },
  ];

  it('rebuilds the transcript from the server copy', () => {
    store().loadHistory(history);
    expect(store().messages.map((m) => m.kind)).toEqual(['user', 'assistant', 'tool']);
    expect(store().messages[2]).toMatchObject({ name: 'Bash', status: 'done' });
  });

  /**
   * `session.history` projects role and text only. Stamping "now" onto every
   * restored line would put a plausible-looking lie next to each one.
   */
  it('leaves restored messages without a time', () => {
    store().loadHistory(history);
    expect(store().messages.every((m) => m.at === null)).toBe(true);
  });

  it('ignores roles it does not render', () => {
    store().loadHistory([...history, { role: 'system', text: 'hidden' }]);
    expect(store().messages).toHaveLength(3);
  });

  it('discards a draft when a different conversation is opened', () => {
    useSession.setState({ queued: { text: 'draft' } });
    store().loadHistory(history);
    expect(store().queued).toBeNull();
  });

  /**
   * A reconnect reconciling the *same* conversation must not strip the clock
   * off every line the user can already see.
   */
  it('keeps known times across a resync', () => {
    store().loadHistory(history);
    useSession.setState({
      messages: store().messages.map((m) => ({ ...m, at: 1234 })),
    });

    store().loadHistory(history, { resync: true });
    expect(store().messages.every((m) => m.at === 1234)).toBe(true);
  });

  it('drops the time when the server copy disagrees', () => {
    store().loadHistory(history);
    useSession.setState({ messages: store().messages.map((m) => ({ ...m, at: 1234 })) });

    store().loadHistory([{ role: 'user', text: 'different' }, ...history.slice(1)], {
      resync: true,
    });
    expect(store().messages[0]!.at).toBeNull();
    expect(store().messages[1]!.at).toBe(1234);
  });

  it('keeps a draft across a resync', () => {
    store().loadHistory(history);
    useSession.setState({ queued: { text: 'draft' } });
    store().loadHistory(history, { resync: true });
    expect(store().queued).toMatchObject({ text: 'draft' });
  });
});

describe('resync after a dropped socket', () => {
  const history = [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello' },
  ];

  /**
   * A turn interrupted by a dropped connection leaves `running` stuck true —
   * the `message.complete` that would have ended it was emitted while nothing
   * was listening.
   */
  it('tears down a stuck turn once the server shows it ended', () => {
    store().loadHistory([history[0]!]);
    useSession.setState({ running: true, streamingText: 'half a repl' });

    store().applyResync(history);

    expect(store().running).toBe(false);
    expect(store().streamingText).toBe('');
    expect(store().messages).toHaveLength(2);
  });

  it('leaves a still-streaming turn alone', () => {
    store().loadHistory(history);
    useSession.setState({ running: true, streamingText: 'still going' });

    store().applyResync(history);

    expect(store().running).toBe(true);
    expect(store().streamingText).toBe('still going');
  });

  /**
   * The server's copy can legitimately be behind ours: a prompt submitted just
   * as the socket dropped exists here but was never recorded there. Adopting a
   * shorter history would wipe it off the screen.
   */
  it('refuses a history shorter than what is on screen', () => {
    store().loadHistory(history);
    useSession.setState({ error: 'stale' });

    store().applyResync([history[0]!]);

    expect(store().messages).toHaveLength(2);
    expect(store().error).toBeNull();
  });
});

describe('rewinding', () => {
  beforeEach(() => {
    store().loadHistory([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'a reply' },
      { role: 'user', text: 'second' },
      { role: 'assistant', text: 'another reply' },
    ]);
  });

  /**
   * `undoTurns` counts in *user turns*, not transcript entries — the entries
   * between them are the replies and tool cards it is dropping.
   */
  it('undoes the right number of user turns and resubmits', async () => {
    await store().retryLast();

    expect(undoTurns).toHaveBeenCalledWith('s1', 1);
    expect(call).toHaveBeenCalledWith('prompt.submit', { session_id: 's1', text: 'second' });
  });

  it('counts every user turn from the edit point onward', async () => {
    const firstUser = store().messages[0]!.id;
    await store().editTurn(firstUser, 'rewritten');

    expect(undoTurns).toHaveBeenCalledWith('s1', 2);
    expect(call).toHaveBeenCalledWith('prompt.submit', { session_id: 's1', text: 'rewritten' });
  });

  it('truncates the transcript to the rewind point', async () => {
    const firstUser = store().messages[0]!.id;
    await store().editTurn(firstUser, 'rewritten');

    const texts = store().messages.filter((m) => m.kind === 'user').map((m) => 'text' in m && m.text);
    expect(texts).toEqual(['rewritten']);
  });

  /**
   * The backend is the source of truth for what got dropped, so nothing is
   * removed locally until the rewind has actually succeeded.
   */
  it('leaves the transcript intact when the rewind fails', async () => {
    undoTurns.mockRejectedValueOnce(new Error('cannot undo'));
    await store().retryLast();

    expect(store().messages).toHaveLength(4);
    expect(store().error).toBe('cannot undo');
    expect(store().rewinding).toBe(false);
  });

  it('prefers the prefill the gateway hands back', async () => {
    undoTurns.mockResolvedValueOnce('what the gateway remembers');
    await store().retryLast();
    expect(call).toHaveBeenCalledWith('prompt.submit', {
      session_id: 's1',
      text: 'what the gateway remembers',
    });
  });

  it('refuses to rewind mid-turn', async () => {
    useSession.setState({ running: true });
    await store().retryLast();

    expect(undoTurns).not.toHaveBeenCalled();
    expect(store().error).toMatch(/stop the current turn/i);
  });

  it('ignores an edit with no text', async () => {
    const firstUser = store().messages[0]!.id;
    await store().editTurn(firstUser, '   ');
    expect(undoTurns).not.toHaveBeenCalled();
  });

  it('does nothing with no user turn to retry', async () => {
    store().reset();
    store().adoptSession({ sessionId: 's1' });
    await store().retryLast();
    expect(undoTurns).not.toHaveBeenCalled();
  });
});

describe('metadata', () => {
  it('adopts session info from the gateway', () => {
    emit('session.info', { model: 'opus', approval_mode: 'ask' });
    expect(store().info).toMatchObject({ model: 'opus', approval_mode: 'ask' });
  });

  it('records the title and the stored session id together', () => {
    emit('session.title', { title: 'Refactor the parser', session_id: 'stored-1' });
    expect(store().title).toBe('Refactor the parser');
    expect(store().storedSessionId).toBe('stored-1');
  });

  it('keeps the stored id when a title arrives without one', () => {
    store().adoptSession({ sessionId: 's1', storedSessionId: 'stored-1' });
    emit('session.title', { title: 'Renamed' });
    expect(store().storedSessionId).toBe('stored-1');
  });

  it('tracks usage', () => {
    emit('session.usage', { input: 100, output: 20, context_percent: 12 });
    expect(store().usage).toMatchObject({ input: 100, output: 20 });
  });

  it('surfaces a control error and stops the turn', () => {
    useSession.setState({ running: true });
    emit('control.error', { message: 'the model refused' });
    expect(store().error).toBe('the model refused');
    expect(store().running).toBe(false);
  });

  it('ignores an event type it does not know', () => {
    const before = store().messages;
    emit('something.entirely.new', { whatever: true });
    expect(store().messages).toBe(before);
  });

  it('leaves usage alone when a refresh fails', async () => {
    emit('session.usage', { input: 100 });
    call.mockRejectedValue(new Error('offline'));
    await store().refreshUsage();
    expect(store().usage).toMatchObject({ input: 100 });
  });
});

describe('notices', () => {
  it('records local output alongside the conversation', () => {
    store().addNotice('No such command', 'error', '/nope');
    expect(store().messages[0]).toMatchObject({
      kind: 'notice',
      text: 'No such command',
      tone: 'error',
      label: '/nope',
    });
  });
});

describe('reset', () => {
  it('clears everything a conversation owns', async () => {
    turn('hello');
    emit('approval.request', { tool: 'Bash' });
    useSession.setState({ queued: { text: 'draft' }, error: 'oops' });

    store().reset();

    expect(store()).toMatchObject({
      sessionId: null,
      messages: [],
      running: false,
      approval: null,
      queued: null,
      error: null,
      title: '',
      usage: null,
    });
  });
});
