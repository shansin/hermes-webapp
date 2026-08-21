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

const clarifyCalls = () => call.mock.calls.filter(([method]) => method === 'clarify.respond');

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
    expect(clarifyCalls()[0]![1]).toEqual({
      session_id: 's1',
      request_id: 'r1',
      answer: 'RSS feed',
    });
  });

  /**
   * A lone question carries no `qid`, and sending one would have the gateway
   * reject it as an unknown question in a batch that does not exist.
   */
  it('omits question_id when there is only one question', async () => {
    emit('clarify.request', single);
    await store().respondClarify({ '': 'RSS feed' });

    expect(clarifyCalls()[0]![1]).not.toHaveProperty('question_id');
  });

  /**
   * The gateway locks a batch per question and releases the agent only on the
   * last one, so every qid has to be sent — one call each.
   */
  it('sends a batch one call per question, each keyed by its qid', async () => {
    emit('clarify.request', batch);
    await store().respondClarify({ q1: 'RSS', q2: 'Daily' });

    expect(clarifyCalls()).toHaveLength(2);
    expect(clarifyCalls().map(([, p]) => (p as Record<string, unknown>).question_id)).toEqual([
      'q1',
      'q2',
    ]);
    expect((clarifyCalls()[1]![1] as Record<string, unknown>).answer).toBe('Daily');
  });

  it('clears the prompt so the reply is not covered by the question', async () => {
    emit('clarify.request', single);
    await store().respondClarify({ '': 'RSS feed' });

    expect(store().clarify).toBeNull();
  });

  /**
   * The gateway keeps accepting an answer whose wait already expired, and says
   * so. Reporting it beats a silent no-op: the person just made a choice and
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

  it('stops after an expired answer rather than sending the rest of a batch', async () => {
    call.mockResolvedValue({ status: 'expired' });
    emit('clarify.request', batch);
    await store().respondClarify({ q1: 'RSS', q2: 'Daily' });

    expect(clarifyCalls()).toHaveLength(1);
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
