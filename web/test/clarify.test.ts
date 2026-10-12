/**
 * `clarify.request` — the agent asking a question and parking its turn on the
 * answer.
 *
 * The bug this covers was total and silent. The event fell through the
 * `applyEvent` switch, which ignores unknown types by design, so the question
 * never reached the UI: the transcript showed a tool card pulsing "running"
 * until the gateway's hour-long timeout expired and the agent proceeded
 * without an answer. Worse, typing the answer could not help — the composer
 * queues anything sent while a turn is running, and the turn could not end
 * until the clarify was answered.
 *
 * So the things worth pinning down are the ones that were wrong: that the
 * event produces a prompt at all, that answering it sends what the gateway
 * expects, and that the prompt cannot outlive the turn it belongs to.
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
  CONTROL_TIMEOUT_MS: 15_000,
}));
vi.mock('../src/api/gateway', () => ({ undoTurns: async () => '' }));

const { useSession } = await import('../src/store/session');

const store = () => useSession.getState();
const emit = (type: string, payload?: unknown, session_id = 's1') =>
  store().applyEvent({ type, session_id, payload });

/** The single-question shape, as the gateway emits it. */
const single = {
  request_id: 'r1',
  question: 'Which data source?',
  choices: ['RSS feed', 'GitHub releases'],
};

/** The batch shape: answered per `qid`, completed only when all are in. */
const batch = {
  request_id: 'r2',
  questions: [
    { qid: 'q1', question: 'Which source?', choices: ['RSS', 'API'] },
    { qid: 'q2', question: 'How often?', choices: ['Hourly', 'Daily'] },
  ],
};

/**
 * A question raised by the old event has no live server request behind it,
 * so its answer goes over `request.answer` — the RPC form of the response
 * frame, which is what these cases exercise. The frame itself is covered under
 * "as a server request" below.
 */
const clarifyCalls = () => call.mock.calls.filter(([method]) => method === 'request.answer');

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({ status: 'ok' });
  store().reset();
  store().adoptSession({ sessionId: 's1' });
});

describe('receiving a question', () => {
  it('raises a prompt where before the event was dropped', () => {
    emit('clarify.request', single);

    expect(store().clarify).not.toBeNull();
    expect(store().clarify!.questions).toHaveLength(1);
    expect(store().clarify!.questions[0]!.question).toBe('Which data source?');
    expect(store().clarify!.questions[0]!.choices).toEqual(['RSS feed', 'GitHub releases']);
  });

  it('folds the batch shape into the same list', () => {
    emit('clarify.request', batch);

    expect(store().clarify!.questions.map((q) => q.qid)).toEqual(['q1', 'q2']);
    expect(store().clarify!.questions[1]!.question).toBe('How often?');
  });

  /**
   * An open-ended clarify arrives with `choices: null`, not with the key
   * missing — a schema that only tolerated `undefined` would reject the whole
   * payload and put us back to dropping the question.
   */
  it('accepts an open-ended question, whose choices are null', () => {
    emit('clarify.request', { request_id: 'r3', question: 'What should I name it?', choices: null });

    expect(store().clarify!.questions[0]!.choices).toEqual([]);
    expect(store().clarify!.questions[0]!.multiSelect).toBe(false);
  });

  it('ignores multi_select on a question with nothing to select', () => {
    emit('clarify.request', { request_id: 'r4', question: 'Why?', multi_select: true });
    expect(store().clarify!.questions[0]!.multiSelect).toBe(false);
  });

  /** Keyed like approvals, so a stale sheet cannot answer a newer question. */
  it('gives each prompt a fresh id', () => {
    emit('clarify.request', single);
    const first = store().clarify!.id;
    emit('clarify.request', { ...single, request_id: 'r9' });

    expect(store().clarify!.id).toBeGreaterThan(first);
  });

  it('drops a payload with no request_id, which nothing could answer', () => {
    emit('clarify.request', { question: 'Orphaned?' });
    expect(store().clarify).toBeNull();
  });
});

describe('answering', () => {
  it('sends the answer against the request the gateway is blocked on', async () => {
    emit('clarify.request', single);
    await store().respondClarify({ '': 'RSS feed' });

    expect(clarifyCalls()).toHaveLength(1);
    expect(clarifyCalls()[0]![1]).toEqual({ id: 'r1', result: { answer: 'RSS feed' } });
  });

  /**
   * The result shape is what tells the backend single from batch: `answer`
   * for a lone question, `answers` keyed by qid for a batch. A response with
   * neither is read as cancel-all.
   */
  it('answers a lone question with `answer`, not `answers`', async () => {
    emit('clarify.request', single);
    await store().respondClarify({ '': 'RSS feed' });

    expect((clarifyCalls()[0]![1] as { result: object }).result).not.toHaveProperty('answers');
  });

  it('sends a batch as one response, every qid answered', async () => {
    emit('clarify.request', batch);
    await store().respondClarify({ q1: 'RSS', q2: 'Daily' });

    expect(clarifyCalls()).toHaveLength(1);
    expect(clarifyCalls()[0]![1]).toEqual({ id: 'r2', result: { answers: { q1: 'RSS', q2: 'Daily' } } });
  });

  /** A question left blank is a skip, which the backend spells ''. */
  it('sends a skipped batch question as an empty answer', async () => {
    emit('clarify.request', batch);
    await store().respondClarify({ q1: 'RSS' });

    expect((clarifyCalls()[0]![1] as { result: unknown }).result).toEqual({ answers: { q1: 'RSS', q2: '' } });
  });

  it('clears the prompt so the reply is not covered by the question', async () => {
    emit('clarify.request', single);
    await store().respondClarify({ '': 'RSS feed' });

    expect(store().clarify).toBeNull();
  });

  /**
   * The backend answers an answer whose wait already ended with `expired`.
   * Reporting it beats a silent no-op: the person just made a choice and
   * would otherwise watch it change nothing.
   */
  it('says so when the question timed out before the answer arrived', async () => {
    call.mockResolvedValue({ status: 'expired' });
    emit('clarify.request', single);
    await store().respondClarify({ '': 'RSS feed' });

    const notice = store().messages.at(-1);
    expect(notice?.kind).toBe('notice');
    expect((notice as { text: string }).text).toContain('timed out');
  });

  it('surfaces a failed send instead of losing it', async () => {
    call.mockRejectedValue(new Error('socket closed'));
    emit('clarify.request', single);
    await store().respondClarify({ '': 'RSS feed' });

    expect(store().error).toBe('socket closed');
  });

  it('does nothing when there is no question pending', async () => {
    await store().respondClarify({ '': 'anything' });
    expect(clarifyCalls()).toHaveLength(0);
  });
});

/**
 * A send that fails must not take the question with it.
 *
 * The sheet is cleared before the calls go out, so the reply is not covered
 * while the round trip lands. It was never put back — and a batch is one call
 * per `qid`, released only once every one of them has landed, so a failure
 * partway through parked the agent on the questions that did not send with
 * nothing on screen to finish answering them.
 */
describe('when the answer cannot be sent', () => {
  it('puts a single question back', async () => {
    emit('clarify.request', single);
    const raised = store().clarify;
    call.mockRejectedValueOnce(new Error('not connected'));

    await store().respondClarify({ '': 'RSS feed' });

    expect(store().clarify).toBe(raised);
    expect(store().error).toBe('not connected');
  });

  it('puts a batch back too', async () => {
    emit('clarify.request', batch);
    const raised = store().clarify;
    call.mockRejectedValueOnce(new Error('socket closed'));

    await store().respondClarify({ q1: 'RSS', q2: 'Daily' });

    expect(store().clarify).toBe(raised);
  });

  /* The id is what stops a revived sheet answering a request that has since
     been replaced, so restoring must not mint a new one. */
  it('restores it under the same id', async () => {
    emit('clarify.request', single);
    const id = store().clarify!.id;
    call.mockRejectedValueOnce(new Error('not connected'));
    await store().respondClarify({ '': 'RSS feed' });
    expect(store().clarify!.id).toBe(id);
  });

  /* An expired request is not a failure: the gateway answered, the agent had
     already moved on, and the question is genuinely gone. */
  it('leaves the sheet closed when the gateway says the request expired', async () => {
    emit('clarify.request', single);
    call.mockResolvedValueOnce({ status: 'expired' });

    await store().respondClarify({ '': 'RSS feed' });

    expect(store().clarify).toBeNull();
  });
});

describe('not outliving its turn', () => {
  /**
   * The failure a non-dismissible sheet would make permanent. The gateway
   * gives up on a clarify after an hour and the agent proceeds; if the prompt
   * survived that, the app would be left with a modal that cannot be
   * dismissed, over a turn that has already finished.
   */
  it('drops the question when the turn completes', () => {
    emit('message.start');
    emit('clarify.request', single);
    expect(store().clarify).not.toBeNull();

    emit('message.complete', { text: 'I went with RSS.' });
    expect(store().clarify).toBeNull();
  });

  it('drops it on an interrupted turn too', () => {
    emit('message.start');
    emit('clarify.request', single);
    emit('message.complete', { text: '', status: 'interrupted' });

    expect(store().clarify).toBeNull();
  });

  it('does not carry a question across a reset', () => {
    emit('clarify.request', single);
    store().reset();

    expect(store().clarify).toBeNull();
  });
});

describe('surviving a reconnect', () => {
  /**
   * The event fires once. A phone that was asleep, or mid-reconnect, never
   * saw it — and the agent is still parked. Resuming is the only way back to
   * the question, so the replayed payload has to be adopted rather than noted.
   */
  it('restores a question the gateway replays on resume', () => {
    store().adoptSession({ sessionId: 's1', pendingClarify: single });

    expect(store().clarify).not.toBeNull();
    expect(store().clarify!.requestId).toBe('r1');
  });

  it('restores the answers already locked into a batch', () => {
    store().adoptSession({
      sessionId: 's1',
      pendingClarify: { ...batch, answers: { q1: 'RSS' } },
    });

    expect(store().clarify!.answered).toEqual({ q1: 'RSS' });
  });

  it('leaves no stale question on a session that has none', () => {
    emit('clarify.request', single);
    store().adoptSession({ sessionId: 's2' });

    expect(store().clarify).toBeNull();
  });
});

describe('the record it leaves in the transcript', () => {
  const asked = {
    question: 'Which data source?',
    choices_offered: ['RSS', 'Playwright'],
    user_response: 'Playwright',
  };

  /**
   * `session.history` keeps what a tool was called with and drops what it
   * returned, so a resumed conversation shows the question with no answer
   * under it — the half a person is most likely to have come back for.
   */
  it('keeps the call arguments through a replay, so the question survives', () => {
    store().loadHistory([
      { role: 'assistant', text: 'Let me ask.' },
      { role: 'tool', name: 'clarify', args: { question: 'Which data source?' } },
    ]);

    const row = store().messages.at(-1)!;
    expect(row.kind).toBe('tool');
    expect((row as { args?: Record<string, unknown> }).args).toEqual({
      question: 'Which data source?',
    });
  });

  it('grafts the answer back on from the stored transcript', () => {
    store().loadHistory([
      { role: 'tool', name: 'clarify', args: { question: 'Which data source?' } },
    ]);
    store().restoreClarifyAnswers([{ role: 'tool', content: JSON.stringify(asked) }]);

    expect((store().messages.at(-1) as { result?: unknown }).result).toMatchObject({
      user_response: 'Playwright',
    });
  });

  /**
   * Matching is by question text precisely so this cannot happen: two
   * projections that disagree about what to include would otherwise file a
   * real answer under a question it does not belong to.
   */
  it('leaves a question alone rather than guessing at its answer', () => {
    store().loadHistory([
      { role: 'tool', name: 'clarify', args: { question: 'Something else entirely?' } },
    ]);
    store().restoreClarifyAnswers([{ role: 'tool', content: JSON.stringify(asked) }]);

    expect((store().messages.at(-1) as { result?: unknown }).result).toBeUndefined();
  });

  it('does not overwrite an answer it already has', () => {
    store().loadHistory([
      {
        role: 'tool',
        name: 'clarify',
        args: { question: 'Which data source?' },
        result: { question: 'Which data source?', user_response: 'RSS' },
      },
    ]);
    store().restoreClarifyAnswers([{ role: 'tool', content: JSON.stringify(asked) }]);

    expect((store().messages.at(-1) as { result: { user_response: string } }).result.user_response)
      .toBe('RSS');
  });

  it('leaves other tools untouched', () => {
    store().loadHistory([{ role: 'tool', name: 'terminal', args: { command: 'ls' } }]);
    store().restoreClarifyAnswers([{ role: 'tool', content: JSON.stringify(asked) }]);

    expect((store().messages.at(-1) as { result?: unknown }).result).toBeUndefined();
  });

  /** The live path already has everything: `tool.complete` carries both. */
  it('carries args and result straight through from a live call', () => {
    emit('tool.start', { tool_id: 't1', name: 'clarify' });
    emit('tool.complete', {
      tool_id: 't1',
      name: 'clarify',
      args: { question: 'Which data source?' },
      result: JSON.stringify(asked),
    });

    const row = store().messages.at(-1) as { name: string; result?: unknown };
    expect(row.name).toBe('clarify');
    expect(row.result).toBe(JSON.stringify(asked));
  });
});

describe('answers that survive a reconnect', () => {
  const asked = {
    question: 'Which data source?',
    choices_offered: ['RSS', 'Playwright'],
    user_response: 'Playwright',
  };
  const replayed = [
    { role: 'assistant', text: 'Let me ask.' },
    { role: 'tool' as const, name: 'clarify', args: { question: 'Which data source?' } },
  ];
  const resultOf = (i = -1) => (store().messages.at(i) as { result?: unknown }).result;

  /**
   * The bug this whole cache exists for, and it was invisible in the unit
   * tests that came before it: the answers came back on resume and then the
   * first reconnect threw them away.
   *
   * `applyResync` rebuilds the transcript from `session.history` on every
   * reconnect, and that projection is exactly the one with no results in it.
   * On a phone — backgrounding, a lift door, a lock screen — that is seconds
   * after opening the conversation, so the card reverted to "Not answered"
   * almost immediately and looked like the recovery had never worked.
   */
  it('keeps a recovered answer through a resync', () => {
    store().loadHistory(replayed);
    store().restoreClarifyAnswers([{ role: 'tool', content: JSON.stringify(asked) }]);
    expect(resultOf()).toBeDefined();

    // The gateway's projection again, as a reconnect delivers it: same rows,
    // still no results.
    store().applyResync([...replayed, { role: 'assistant', text: 'Done.' }]);

    expect(resultOf(-2)).toMatchObject({ user_response: 'Playwright' });
  });

  it('survives repeated reconnects, not just the first', () => {
    store().loadHistory(replayed);
    store().restoreClarifyAnswers([{ role: 'tool', content: JSON.stringify(asked) }]);

    for (let i = 0; i < 3; i++) {
      store().applyResync([...replayed, ...Array.from({ length: i + 1 }, () => ({ role: 'assistant', text: 'x' }))]);
    }

    const row = store().messages.find((m) => m.kind === 'tool') as { result?: unknown };
    expect(row.result).toMatchObject({ user_response: 'Playwright' });
  });

  /**
   * The same loss by the other route: an answer given in this session, with
   * the result arriving live on `tool.complete`, and a reconnect a moment
   * later rebuilding the transcript without it.
   */
  it('keeps an answer watched live through a resync', () => {
    emit('tool.start', { tool_id: 't1', name: 'clarify' });
    emit('tool.complete', {
      tool_id: 't1',
      name: 'clarify',
      args: { question: 'Which data source?' },
      result: JSON.stringify(asked),
    });

    store().applyResync([...replayed, { role: 'assistant', text: 'Done.' }]);

    expect(resultOf(-2)).toMatchObject({ user_response: 'Playwright' });
  });

  it('remembers every question of a batch', () => {
    emit('tool.start', { tool_id: 't2', name: 'clarify' });
    emit('tool.complete', {
      tool_id: 't2',
      name: 'clarify',
      args: { questions: [{ question: 'One?' }, { question: 'Two?' }] },
      result: JSON.stringify({
        responses: [
          { question: 'One?', choices_offered: [], user_response: 'a' },
          { question: 'Two?', choices_offered: [], user_response: 'b' },
        ],
      }),
    });

    store().applyResync([
      { role: 'assistant', text: 'asked' },
      { role: 'tool', name: 'clarify', args: { questions: [{ question: 'One?' }, { question: 'Two?' }] } },
      { role: 'assistant', text: 'done' },
    ]);

    const row = store().messages.find((m) => m.kind === 'tool') as { result?: unknown };
    expect(row.result).toBeDefined();
  });

  it('does not carry answers into a different conversation', () => {
    store().loadHistory(replayed);
    store().restoreClarifyAnswers([{ role: 'tool', content: JSON.stringify(asked) }]);
    store().reset();
    store().loadHistory(replayed);

    expect(resultOf()).toBeUndefined();
  });
});

/**
 * The way a question actually arrives now: a server request, answered with a
 * response frame rather than an RPC. The event-shaped cases above still pass
 * through the same sheet and the same answer path; these pin the parts only
 * the request form has.
 */
describe('as a server request', () => {
  const request = (over: Partial<{ id: string; method: string; params: Record<string, unknown>; replayed: boolean }> = {}) => {
    const respond = vi.fn((_: Record<string, unknown>) => true);
    return {
      id: 'srq-1',
      method: 'clarify',
      params: { session_id: 's1', question: 'Which data source?', choices: ['RSS', 'API'] },
      replayed: false,
      respond,
      fail: vi.fn(() => true),
      ...over,
    };
  };

  it('raises the sheet, keyed on the request id', () => {
    expect(store().applyServerRequest(request())).toBe(true);
    expect(store().clarify?.requestId).toBe('srq-1');
  });

  it('answers with the response frame, not an RPC', async () => {
    const req = request();
    store().applyServerRequest(req);
    await store().respondClarify({ '': 'RSS' });

    expect(req.respond).toHaveBeenCalledWith({ answer: 'RSS' });
    expect(clarifyCalls()).toHaveLength(0);
  });

  /** The socket it came in on went away: the live one carries the answer instead. */
  it('falls back to request.answer when the frame cannot go out', async () => {
    const req = request();
    req.respond.mockReturnValue(false);
    store().applyServerRequest(req);
    await store().respondClarify({ '': 'RSS' });

    expect(clarifyCalls()[0]![1]).toEqual({ id: 'srq-1', result: { answer: 'RSS' } });
  });

  it('clears the sheet when the backend withdraws the request', () => {
    store().applyServerRequest(request());
    store().cancelServerRequest('srq-1');
    expect(store().clarify).toBeNull();
  });

  it('leaves the sheet alone when a different request is withdrawn', () => {
    store().applyServerRequest(request());
    store().cancelServerRequest('srq-other');
    expect(store().clarify).not.toBeNull();
  });

  /**
   * Declining would withdraw it and fail the other conversation's tool call;
   * holding it leaves it in that session's `open_requests` for when it is
   * opened again.
   */
  it('holds a request for another conversation without showing it', () => {
    expect(store().applyServerRequest(request({ params: { session_id: 's9', question: 'Elsewhere?' } }))).toBe(true);
    expect(store().clarify).toBeNull();
  });

  /** No UI for these here; declining is what gets them failed fast. */
  it('declines kinds it has no sheet for', () => {
    expect(store().applyServerRequest(request({ method: 'sudo' }))).toBe(false);
  });

  it('shows an approval and answers it with choice and all', async () => {
    const req = request({
      id: 'srq-2',
      method: 'approval',
      params: { session_id: 's1', request_id: 'a1', command: 'rm -rf build', choices: ['once', 'deny'] },
    });
    store().applyServerRequest(req);
    expect(store().approval?.srqId).toBe('srq-2');

    await store().respondApproval('once');
    expect(req.respond).toHaveBeenCalledWith({ choice: 'once', all: false });
    expect(call.mock.calls.some(([m]) => m === 'approval.respond')).toBe(false);
  });

  /**
   * A resume returns the same approval twice — once in `open_requests`,
   * delivered first, and once as `pending_approval`. The second must not
   * replace the first, which is the only copy a response frame can answer.
   */
  it('keeps the server-request approval over a resume\'s pending_approval', () => {
    store().applyServerRequest(
      request({ id: 'srq-3', method: 'approval', params: { session_id: 's1', request_id: 'a1', choices: ['once'] } }),
    );
    store().applyLiveState({ session_id: 's1', pending_approval: { request_id: 'a1', choices: ['once'] } });

    expect(store().approval?.srqId).toBe('srq-3');
  });
});
