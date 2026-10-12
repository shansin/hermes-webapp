/**
 * The gateway's `error` event: a failure outside a turn.
 *
 * It used to fall through the event switch as an unknown type, so an agent
 * that could not be built — no provider set up, a model that would not load —
 * left a session that looked ready and answered nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/haptics', () => ({ buzz: vi.fn(), setHapticsEnabled: vi.fn() }));
vi.mock('../src/ws/client', () => ({
  hermes: { call: vi.fn(async () => ({})), onEvent: () => () => {}, onState: () => () => {}, state: 'open' },
  CONTROL_TIMEOUT_MS: 15_000,
}));
vi.mock('../src/api/gateway', () => ({ undoTurns: async () => '' }));

const { useSession } = await import('../src/store/session');
const store = () => useSession.getState();
const emit = (payload: unknown) => store().applyEvent({ type: 'error', session_id: 's1', payload });
const last = () => store().messages.at(-1) as { kind: string; text: string; tone: string; action?: { to: string } };

beforeEach(() => {
  store().reset();
  store().adoptSession({ sessionId: 's1' });
});

describe('an error event', () => {
  it('lands in the transcript as an error notice', () => {
    emit({ message: 'Could not switch to configured model qwen: connection refused' });
    expect(last()).toMatchObject({ kind: 'notice', tone: 'error', text: expect.stringContaining('connection refused') });
    expect(last().action).toBeUndefined();
  });

  it('points a missing provider at the Models screen', () => {
    emit({ message: 'No LLM provider configured', code: 'provider_not_configured' });
    expect(last().action?.to).toBe('/models');
  });

  it("carries the conversation's profile into that link", () => {
    store().adoptSession({ sessionId: 's1', profile: 'research' });
    emit({ message: 'No LLM provider configured', code: 'provider_not_configured' });
    expect(last().action?.to).toBe('/models?profile=research');
  });

  it('does not claim a turn is running or stopped', () => {
    emit({ message: 'compression failed: timeout' });
    expect(store().running).toBe(false);
  });
});

/** The answer to a side question, which belongs to no turn. */
describe('btw.complete', () => {
  const answer = (payload: unknown) => store().applyEvent({ type: 'btw.complete', session_id: 's1', payload });

  it('lands as a notice naming the question', () => {
    answer({ task_id: 'btw_1', question: 'what file was that?', text: 'notes/plan.md' });
    expect(store().messages.at(-1)).toMatchObject({
      kind: 'notice',
      tone: 'info',
      text: 'notes/plan.md',
      label: 'Side question — what file was that?',
    });
  });

  it('marks a failed side agent as an error', () => {
    answer({ task_id: 'btw_2', question: 'q', text: 'error: model unavailable' });
    expect(store().messages.at(-1)).toMatchObject({ tone: 'error' });
  });

  it('leaves a running turn alone', () => {
    store().applyEvent({ type: 'message.start', session_id: 's1' });
    answer({ task_id: 'btw_3', question: 'q', text: 'a' });
    expect(store().running).toBe(true);
  });
});
