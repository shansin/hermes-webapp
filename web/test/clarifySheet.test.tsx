/**
 * The clarify sheet: where the agent's question becomes something a thumb can
 * answer.
 *
 * Driven rather than asserted structurally, because the encoding is the part
 * that has to be right — the gateway parses what we send, and a multi-select
 * answer that arrives in the wrong shape resolves the block with something
 * matching none of the choices. The turn continues either way, which is what
 * makes getting it wrong hard to notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/lib/haptics', () => ({ buzz: vi.fn(), setHapticsEnabled: vi.fn() }));
vi.mock('../src/lib/useHistoryDismiss', () => ({ useHistoryDismiss: () => {} }));

const call = vi.fn(async () => ({ status: 'ok' }));
vi.mock('../src/ws/client', () => ({
  hermes: {
    call: (...a: unknown[]) => call(...(a as [])),
    onEvent: () => () => {},
    onState: () => () => {},
    state: 'open',
  },
  defaultWsUrl: () => 'ws://test/api/ws',
}));
vi.mock('../src/api/gateway', () => ({ undoTurns: async () => '' }));

const { ClarifySheet } = await import('../src/components/chat/ClarifySheet');
const { ClarifyCard } = await import('../src/components/chat/ClarifyCard');
const { useSession } = await import('../src/store/session');

beforeEach(() => {
  call.mockClear();
  call.mockResolvedValue({ status: 'ok' });
  useSession.getState().reset();
  useSession.getState().adoptSession({ sessionId: 's1' });
  // Mounted before the question arrives, as the shell mounts it: the sheet
  // renders nothing until there is something to ask.
  render(<ClarifySheet />);
});

afterEach(cleanup);

const ask = (payload: Record<string, unknown>) =>
  act(() => {
    useSession.getState().applyEvent({ type: 'clarify.request', session_id: 's1', payload });
  });

const sent = () =>
  call.mock.calls
    .filter(([method]) => method === 'clarify.respond')
    .map(([, params]) => params as Record<string, unknown>);

describe('where the sheet lives', () => {
  /**
   * The same lesson approvals already taught: a prompt that blocks the agent
   * has to be answerable from whatever screen you wandered off to. Moving this
   * back under one screen would make a question raised on Kanban unanswerable
   * again, and nothing else would report it.
   */
  it('is mounted by the app shell, not by one screen', () => {
    const app = readFileSync(resolve(__dirname, '../src/App.tsx'), 'utf8');
    expect(app).toContain('<ClarifySheet />');
  });

  it('is not also mounted by the chat screen, which would double it', () => {
    const chat = readFileSync(resolve(__dirname, '../src/screens/ChatScreen.tsx'), 'utf8');
    expect(chat).not.toContain('<ClarifySheet />');
  });

  /**
   * The agent is parked on an Event until an answer or an interrupt. A sheet
   * that could be swiped away would put the conversation straight back into
   * the state this whole component exists to end.
   */
  it('cannot be dismissed', () => {
    const source = readFileSync(
      resolve(__dirname, '../src/components/chat/ClarifySheet.tsx'),
      'utf8',
    );
    expect(source).toContain('dismissible={false}');
  });
});

describe('a single question with choices', () => {
  beforeEach(() => {
    ask({ request_id: 'r1', question: 'Which data source?', choices: ['RSS feed', 'GitHub'] });
  });

  it('shows the question and every choice the agent offered', () => {
    expect(screen.getByText('Which data source?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'RSS feed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'GitHub' })).toBeInTheDocument();
  });

  /** One question, one choice: a second tap to confirm is ceremony a thumb notices. */
  it('answers on the first tap, with no confirm step', async () => {
    await userEvent.click(screen.getByRole('button', { name: 'RSS feed' }));

    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.answer).toBe('RSS feed');
    expect(sent()[0]!.request_id).toBe('r1');
  });

  it('closes once answered', async () => {
    await userEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(screen.queryByText('Which data source?')).not.toBeInTheDocument();
  });

  /**
   * The escape hatch. The agent guessed its options before it knew what you
   * wanted; a modal that only offers those makes the wrong guess permanent.
   */
  it('takes a free-text answer instead of a choice', async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Something else…' }));
    await userEvent.type(screen.getByPlaceholderText('Type your answer…'), 'Watch ollama ps');
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }));

    expect(sent()[0]!.answer).toBe('Watch ollama ps');
  });

  it('will not send an empty free-text answer', async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Something else…' }));
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();
  });
});

describe('an open-ended question', () => {
  it('offers a text box and no choices', async () => {
    ask({ request_id: 'r2', question: 'What should I call it?', choices: null });

    expect(screen.queryByRole('button', { name: 'Something else…' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('Type your answer…'), 'ollama-watch');
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }));

    expect(sent()[0]!.answer).toBe('ollama-watch');
  });
});

describe('a multi-select question', () => {
  beforeEach(() => {
    ask({
      request_id: 'r3',
      question: 'Which sources?',
      choices: ['RSS, when available', 'GitHub'],
      multi_select: true,
    });
  });

  it('holds the selection open instead of answering on the first tap', async () => {
    await userEvent.click(screen.getByRole('button', { name: /RSS, when available/ }));

    expect(sent()).toHaveLength(0);
    expect(screen.getByText('Which sources?')).toBeInTheDocument();
  });

  /**
   * JSON, not the comma-joined form the gateway also accepts. A choice is
   * prose the agent wrote and may contain a comma — as this one does — which
   * would split into two answers matching nothing.
   */
  it('encodes several answers as a JSON array, comma-safe', async () => {
    await userEvent.click(screen.getByRole('button', { name: /RSS, when available/ }));
    await userEvent.click(screen.getByRole('button', { name: /GitHub/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }));

    expect(JSON.parse(sent()[0]!.answer as string)).toEqual(['RSS, when available', 'GitHub']);
  });

  it('lets a choice be taken back before sending', async () => {
    const rss = screen.getByRole('button', { name: /RSS, when available/ });
    await userEvent.click(rss);
    await userEvent.click(rss);

    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();
  });
});

describe('a batch of questions', () => {
  beforeEach(() => {
    ask({
      request_id: 'r4',
      questions: [
        { qid: 'q1', question: 'Which source?', choices: ['RSS', 'API'] },
        { qid: 'q2', question: 'How often?', choices: ['Hourly', 'Daily'] },
      ],
    });
  });

  it('shows every question at once', () => {
    expect(screen.getByText('Which source?')).toBeInTheDocument();
    expect(screen.getByText('How often?')).toBeInTheDocument();
  });

  /**
   * The gateway releases the agent only when every qid is locked, so a partial
   * batch would leave the turn parked with the sheet already gone.
   */
  it('refuses to send until every question is answered', async () => {
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'RSS' }));
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Daily' }));
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeEnabled();
  });

  it('sends each answer under its own question_id', async () => {
    await userEvent.click(screen.getByRole('button', { name: 'API' }));
    await userEvent.click(screen.getByRole('button', { name: 'Hourly' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }));

    expect(sent()).toEqual([
      { session_id: 's1', request_id: 'r4', answer: 'API', question_id: 'q1' },
      { session_id: 's1', request_id: 'r4', answer: 'Hourly', question_id: 'q2' },
    ]);
  });
});

describe('one prompt does not answer for another', () => {
  /**
   * The ids exist for this. A second question arriving while the first is on
   * screen must not inherit its half-filled selection, or a tap meant for a
   * question the user never read gets sent as their answer.
   */
  it('starts clean when a new question replaces the old one', async () => {
    // Two questions, so the first tap selects rather than sending — the only
    // arrangement in which a half-filled answer can still be on screen when
    // the next prompt arrives.
    const pair = (id: string, first: string) => ({
      request_id: id,
      questions: [
        { qid: 'a', question: first, choices: ['x', 'y'] },
        { qid: 'b', question: 'And?', choices: ['p', 'q'] },
      ],
    });

    ask(pair('r5', 'First?'));
    await userEvent.click(screen.getByRole('button', { name: 'x' }));

    ask(pair('r6', 'Second?'));

    expect(screen.getByText('Second?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();
  });
});

describe('the card left in the transcript', () => {
  const card = (msg: Record<string, unknown>) =>
    render(
      <ClarifyCard
        msg={
          {
            kind: 'tool',
            id: 'm1',
            toolId: 't1',
            name: 'clarify',
            status: 'done',
            at: null,
            ...msg,
          } as never
        }
      />,
    );

  it('shows the question, the answer, and the options not taken', () => {
    card({
      result: JSON.stringify({
        question: 'Which data source?',
        choices_offered: ['RSS feed', 'Playwright'],
        user_response: 'Playwright',
      }),
    });

    expect(screen.getByText('Which data source?')).toBeInTheDocument();
    // Both, not just the winner: an answer only means something against what
    // else was on offer.
    expect(screen.getByText('RSS feed')).toBeInTheDocument();
    expect(screen.getByText('Playwright')).toBeInTheDocument();
  });

  it('marks which one was taken', () => {
    card({
      result: {
        question: 'Which?',
        choices_offered: ['A', 'B'],
        user_response: 'B',
      },
    });

    expect(screen.getByText('B').closest('li')).toHaveClass('is-taken');
    expect(screen.getByText('A').closest('li')).not.toHaveClass('is-taken');
  });

  it('shows a typed answer as itself rather than as a choice', () => {
    card({
      result: {
        question: 'Which?',
        choices_offered: ['A', 'B'],
        user_response: 'Neither, use ollama ps',
      },
    });

    expect(screen.getByText(/Neither, use ollama ps/)).toBeInTheDocument();
    expect(screen.getByText('Answered instead')).toBeInTheDocument();
  });

  it('says so when nobody ever answered', () => {
    card({
      result: {
        responses: [{ question: 'Which?', choices_offered: ['A'], user_response: '' }],
        timed_out: true,
      },
    });

    expect(screen.getByText(/the agent moved on/i)).toBeInTheDocument();
    expect(screen.getByText('timed out')).toBeInTheDocument();
  });

  it('shows a replayed question that has not got its answer back', () => {
    card({ args: { question: 'Which data source?', choices: ['RSS', 'Playwright'] } });

    expect(screen.getByText('Which data source?')).toBeInTheDocument();
    expect(screen.getByText('Not answered.')).toBeInTheDocument();
  });

  it('reads as a live question while it is still being asked', () => {
    card({ status: 'running', args: { question: 'Which data source?' } });
    expect(screen.getByText('Waiting for your answer')).toBeInTheDocument();
  });

  it('shows every question of a batch', () => {
    card({
      result: {
        responses: [
          { question: 'Which source?', choices_offered: ['RSS'], user_response: 'RSS' },
          { question: 'How often?', choices_offered: ['Daily'], user_response: 'Daily' },
        ],
      },
    });

    expect(screen.getByText('Which source?')).toBeInTheDocument();
    expect(screen.getByText('How often?')).toBeInTheDocument();
  });

  /**
   * The fallback that keeps a malformed row from becoming a confident-looking
   * empty card: the generic tool card at least shows what actually arrived.
   */
  it('falls back to the ordinary tool card when it cannot read the row', () => {
    card({ result: 'not json', context: 'clarify(...)' });
    expect(screen.queryByText('You were asked')).not.toBeInTheDocument();
  });
});
