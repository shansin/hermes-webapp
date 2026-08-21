/**
 * Reading a finished clarify out of the transcript.
 *
 * The sheet is a moment; this is the record. Once answered, a `clarify` call
 * is just another tool row, and the generic card rendered it as what it
 * literally is — a blob of JSON behind a disclosure triangle. The question the
 * agent asked and the answer you gave are the most human thing in a
 * transcript full of machinery, and they were the least readable.
 *
 * Everything needed is already in the row. The tool's own result carries the
 * question, the choices as offered, and the response together:
 *
 *     {"question": …, "choices_offered": […]|null, "user_response": …}
 *
 * and a batch wraps one of those per question under `responses`, plus
 * `timed_out` when the gateway gave up rather than the user declining.
 *
 * `args` is the fallback. A replayed history carries the call but not its
 * result (the gateway's display projection drops it), so the question can
 * still be shown while the answer needs recovering from elsewhere.
 */

export interface ClarifyExchangeQuestion {
  question: string;
  choices: string[];
  /** What was picked. Several for a multi-select, one for free text, none if unanswered. */
  responses: string[];
  /** True when a choice was offered and the answer matched none of them. */
  freeform: boolean;
}

export interface ClarifyExchange {
  questions: ClarifyExchangeQuestion[];
  /** The wait expired: the blanks are the user walking away, not declining. */
  timedOut: boolean;
  /** No result yet — still being asked, or replayed without one. */
  unanswered: boolean;
}

/** Tool results arrive as a JSON string; history and tests may hand us the object. */
function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text.startsWith('{')) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

const strings = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const one = typeof value === 'string' ? value.trim() : '';
  return one ? [one] : [];
};

function readRow(row: Record<string, unknown>): ClarifyExchangeQuestion {
  const choices = strings(row.choices_offered ?? row.choices);
  const responses = strings(row.user_response);

  return {
    question: typeof row.question === 'string' ? row.question : '',
    choices,
    responses,
    // Worth distinguishing in the card: "you picked the third option" and
    // "you typed something none of these covered" are different answers to
    // the same question, and the second is the more interesting one.
    freeform: choices.length > 0 && responses.some((r) => !choices.includes(r)),
  };
}

/**
 * Build the exchange to display, or null when this isn't one we can read.
 *
 * Null rather than an empty shell: a clarify row we cannot make sense of
 * should fall back to the generic tool card, which at least shows the raw
 * payload, instead of rendering a confident-looking card with nothing in it.
 */
export function readClarify(msg: { args?: unknown; result?: unknown }): ClarifyExchange | null {
  const result = asObject(msg.result);

  if (result) {
    if (Array.isArray(result.responses)) {
      const rows = result.responses
        .map((r) => asObject(r))
        .filter((r): r is Record<string, unknown> => r !== null)
        .map(readRow);
      if (rows.length) {
        return {
          questions: rows,
          timedOut: result.timed_out === true,
          unanswered: rows.every((r) => r.responses.length === 0),
        };
      }
    }

    if (typeof result.question === 'string') {
      const row = readRow(result);
      return { questions: [row], timedOut: false, unanswered: row.responses.length === 0 };
    }
  }

  // No readable result: fall back to what was asked. This is the replayed
  // case, and the running one — the question is on screen before any answer
  // exists to show beside it.
  const args = asObject(msg.args);
  if (!args) return null;

  const batch = Array.isArray(args.questions)
    ? args.questions.map((q) => asObject(q)).filter((q): q is Record<string, unknown> => q !== null)
    : null;
  const rows = (batch?.length ? batch : [args]).map(readRow).filter((r) => r.question);
  if (!rows.length) return null;

  return { questions: rows, timedOut: false, unanswered: true };
}

/**
 * Index the clarify results in a stored transcript, by question text.
 *
 * The gateway's history projection keeps a tool call's arguments but drops its
 * result, so a resumed conversation shows every question and none of the
 * answers — the half a person is more likely to have come back for. The REST
 * copy of the same session does keep the results, so this pulls them out to be
 * grafted back on.
 *
 * Keyed on the question rather than on position. Pairing the *n*th clarify in
 * one list with the *n*th in another would put a real answer under the wrong
 * question the moment the two projections disagree about what to include —
 * and a confidently mislabelled answer is worse than a missing one. A question
 * that finds no match keeps its blank.
 */
export function indexClarifyResults(stored: { role?: string; content?: unknown }[]): Map<string, unknown> {
  const byQuestion = new Map<string, unknown>();

  for (const row of stored) {
    if (row.role !== 'tool') continue;
    const result = asObject(row.content);
    if (!result) continue;

    const rows = Array.isArray(result.responses)
      ? result.responses.map((r) => asObject(r))
      : [result];

    // A batch is filed under each of its questions: whichever one a transcript
    // row asks about, the same whole result is what answers it.
    let clarify = false;
    for (const entry of rows) {
      if (!entry || typeof entry.question !== 'string' || !('user_response' in entry)) continue;
      clarify = true;
      if (entry.question) byQuestion.set(entry.question, result);
    }
    if (!clarify) continue;
  }

  return byQuestion;
}

/** The question a clarify row is about, for looking its answer back up. */
export function clarifyQuestionsOf(args: unknown): string[] {
  const parsed = asObject(args);
  if (!parsed) return [];

  const batch = Array.isArray(parsed.questions)
    ? parsed.questions.map((q) => asObject(q)).filter((q): q is Record<string, unknown> => q !== null)
    : null;

  return (batch?.length ? batch : [parsed])
    .map((q) => (typeof q.question === 'string' ? q.question : ''))
    .filter(Boolean);
}
