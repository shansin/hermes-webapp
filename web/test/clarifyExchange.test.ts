/**
 * Reading a finished clarify back out of the transcript.
 *
 * Pure shape-wrangling, and worth testing directly because every input here is
 * a projection someone else built: the tool's result JSON, the gateway's
 * history (which keeps a call's arguments and drops its result), and the REST
 * copy (which keeps both). The card is only as honest as its ability to tell
 * "you picked the third option" from "you typed something else" from "nobody
 * ever answered" — and the third one is indistinguishable from a bug unless it
 * says so out loud.
 */
import { describe, expect, it } from 'vitest';
import {
  clarifyQuestionsOf,
  indexClarifyResults,
  readClarify,
} from '../src/lib/clarifyExchange';

const single = {
  question: 'Which data source?',
  choices_offered: ['RSS feed', 'GitHub releases', 'Playwright'],
  user_response: 'Playwright',
};

describe('a finished single question', () => {
  it('reads the question, the choices and the answer', () => {
    const x = readClarify({ result: JSON.stringify(single) })!;

    expect(x.questions).toHaveLength(1);
    expect(x.questions[0]!.question).toBe('Which data source?');
    expect(x.questions[0]!.choices).toHaveLength(3);
    expect(x.questions[0]!.responses).toEqual(['Playwright']);
    expect(x.unanswered).toBe(false);
  });

  /** The gateway sends a JSON string; history and tests hand over objects. */
  it('takes the result as an object too', () => {
    expect(readClarify({ result: single })!.questions[0]!.responses).toEqual(['Playwright']);
  });

  it('keeps the options that were not taken, since an answer needs them', () => {
    const x = readClarify({ result: single })!;
    expect(x.questions[0]!.choices).toContain('RSS feed');
  });

  /**
   * The distinction the card is built around: a typed answer means none of the
   * options fitted, which is a different thing from choosing one of them.
   */
  it('marks an answer that matched none of the choices', () => {
    const x = readClarify({
      result: { ...single, user_response: 'Watch ollama ps instead' },
    })!;
    expect(x.questions[0]!.freeform).toBe(true);
  });

  it('does not call a chosen option freeform', () => {
    expect(readClarify({ result: single })!.questions[0]!.freeform).toBe(false);
  });

  it('reads a multi-select answer as the several answers it is', () => {
    const x = readClarify({
      result: { ...single, user_response: ['RSS feed', 'GitHub releases'] },
    })!;
    expect(x.questions[0]!.responses).toEqual(['RSS feed', 'GitHub releases']);
  });

  /** An open-ended question offers nothing, so nothing can fail to match it. */
  it('handles an open-ended question, whose choices are null', () => {
    const x = readClarify({
      result: { question: 'Name it?', choices_offered: null, user_response: 'ollama-watch' },
    })!;
    expect(x.questions[0]!.choices).toEqual([]);
    expect(x.questions[0]!.freeform).toBe(false);
    expect(x.questions[0]!.responses).toEqual(['ollama-watch']);
  });
});

describe('a finished batch', () => {
  const batch = {
    responses: [
      { id: 'a', question: 'Which source?', choices_offered: ['RSS', 'API'], user_response: 'API' },
      { id: 'b', question: 'How often?', choices_offered: ['Hourly'], user_response: 'Hourly' },
    ],
  };

  it('reads every question and its own answer', () => {
    const x = readClarify({ result: batch })!;
    expect(x.questions.map((q) => q.question)).toEqual(['Which source?', 'How often?']);
    expect(x.questions.map((q) => q.responses[0])).toEqual(['API', 'Hourly']);
  });

  /**
   * `timed_out` is the difference between the user declining to answer and the
   * user never seeing the question — the second is a bug report, the first is
   * a decision, and a blank alone cannot tell them apart.
   */
  it('reports a batch the gateway gave up waiting on', () => {
    const x = readClarify({
      result: { responses: [{ question: 'Which?', choices_offered: [], user_response: '' }], timed_out: true },
    })!;
    expect(x.timedOut).toBe(true);
    expect(x.unanswered).toBe(true);
  });

  it('does not call a partly answered batch unanswered', () => {
    const x = readClarify({
      result: {
        responses: [
          { question: 'One?', choices_offered: [], user_response: 'yes' },
          { question: 'Two?', choices_offered: [], user_response: '' },
        ],
      },
    })!;
    expect(x.unanswered).toBe(false);
    expect(x.questions[1]!.responses).toEqual([]);
  });
});

describe('a question with no answer yet', () => {
  /**
   * Both the live case, where the question is on screen before it is answered,
   * and the replayed one, where `session.history` kept the call and dropped
   * what it returned.
   */
  it('falls back to what the call was made with', () => {
    const x = readClarify({
      args: { question: 'Which data source?', choices: ['RSS', 'Playwright'] },
    })!;
    expect(x.questions[0]!.question).toBe('Which data source?');
    expect(x.questions[0]!.choices).toEqual(['RSS', 'Playwright']);
    expect(x.unanswered).toBe(true);
  });

  it('falls back for a batch too', () => {
    const x = readClarify({
      args: { questions: [{ question: 'One?' }, { question: 'Two?' }] },
    })!;
    expect(x.questions.map((q) => q.question)).toEqual(['One?', 'Two?']);
  });

  it('prefers the result once there is one', () => {
    const x = readClarify({ args: { question: 'Which data source?' }, result: single })!;
    expect(x.questions[0]!.responses).toEqual(['Playwright']);
  });
});

describe('what it refuses to render', () => {
  /**
   * Null rather than an empty card: an unreadable row falls back to the
   * generic tool card, which at least shows what actually arrived.
   */
  it('gives up on a row with neither a result nor arguments', () => {
    expect(readClarify({})).toBeNull();
  });

  it('gives up on unparseable output rather than inventing a card', () => {
    expect(readClarify({ result: 'not json at all' })).toBeNull();
  });

  it('gives up when the arguments carry no question', () => {
    expect(readClarify({ args: { unrelated: true } })).toBeNull();
  });
});

describe('recovering answers from the stored transcript', () => {
  const stored = [
    { role: 'assistant', content: 'thinking' },
    { role: 'tool', content: JSON.stringify(single) },
    { role: 'tool', content: '{"output":"ls -la"}' },
  ];

  it('indexes a clarify result by its question', () => {
    const index = indexClarifyResults(stored);
    expect(index.has('Which data source?')).toBe(true);
  });

  it('ignores tool rows that are not clarifies', () => {
    expect(indexClarifyResults(stored).size).toBe(1);
  });

  it('files every question of a batch, so any row can find it', () => {
    const index = indexClarifyResults([
      {
        role: 'tool',
        content: JSON.stringify({
          responses: [
            { question: 'One?', choices_offered: [], user_response: 'a' },
            { question: 'Two?', choices_offered: [], user_response: 'b' },
          ],
        }),
      },
    ]);
    expect(index.has('One?')).toBe(true);
    expect(index.has('Two?')).toBe(true);
  });

  /**
   * The reason this is keyed on the question and not on position: two
   * projections that disagree about what to include would otherwise file a
   * real answer under the wrong question, and a confidently mislabelled
   * answer is worse than a missing one.
   */
  it('reads back the questions a call was about, for the lookup', () => {
    expect(clarifyQuestionsOf({ question: 'Which data source?' })).toEqual(['Which data source?']);
    expect(clarifyQuestionsOf({ questions: [{ question: 'One?' }, { question: 'Two?' }] })).toEqual([
      'One?',
      'Two?',
    ]);
    expect(clarifyQuestionsOf(undefined)).toEqual([]);
  });
});
