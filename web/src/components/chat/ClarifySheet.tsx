/**
 * The agent's own question, asked mid-turn.
 *
 * Like `ApprovalSheet` this is not dismissible — the gateway has parked the
 * agent thread on an Event and only an answer (or an interrupt) releases it,
 * so a sheet that could be swiped away would put the conversation right back
 * in the state this component exists to fix.
 *
 * Unlike an approval, nothing here is about permission. There is no allow/deny
 * axis and no risk to weigh: the choices are prose the agent wrote, and the
 * honest rendering is a list of them plus a way to say something else. That
 * escape matters more on a phone than it does in a terminal — the agent
 * guessed four options before it knew what you wanted, and being forced to
 * pick the closest wrong one is the failure mode a modal makes permanent.
 */
import { useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { useSession } from '../../store/session';
import type { ClarifyQuestion } from '../../ws/types';
import { buzz } from '../../lib/haptics';

/** The key a question's answer is filed under; a lone question has no qid. */
const keyOf = (qid: string | undefined) => qid ?? '';

export function ClarifySheet() {
  const clarify = useSession((s) => s.clarify);
  const respond = useSession((s) => s.respondClarify);

  /**
   * Keyed by the prompt's id, not merely reset on open. A second question
   * arriving while the first is still on screen would otherwise inherit its
   * half-filled answers, and the ids exist precisely so a stale sheet cannot
   * speak for a newer request.
   */
  const [state, setState] = useState<{
    id: number;
    picked: Record<string, string[]>;
    freeText: Record<string, string>;
    otherOpen: Record<string, boolean>;
  }>({ id: -1, picked: {}, freeText: {}, otherOpen: {} });

  if (!clarify) return null;

  const fresh = state.id !== clarify.id;
  const picked = fresh ? {} : state.picked;
  const freeText = fresh ? {} : state.freeText;
  const otherOpen = fresh ? {} : state.otherOpen;

  const update = (next: Partial<Omit<typeof state, 'id'>>) =>
    setState({ id: clarify.id, picked, freeText, otherOpen, ...next });

  /**
   * What this question would send right now, or null if it isn't answered.
   *
   * Multi-select goes out as a JSON array rather than the comma-joined form
   * the gateway also accepts: a choice is free prose and may well contain a
   * comma, which would silently split into two answers that match nothing.
   */
  const answerFor = (q: ClarifyQuestion): string | null => {
    const key = keyOf(q.qid);

    // An open-ended question has no choices to fall back on, so its text box
    // is the answer whether or not "Something else…" was ever tapped — there
    // is no such button to tap.
    if (q.choices.length === 0 || otherOpen[key]) {
      return (freeText[key] ?? '').trim() || null;
    }

    const chosen = picked[key] ?? [];
    if (!chosen.length) return null;
    return q.multiSelect ? JSON.stringify(chosen) : chosen[0]!;
  };

  const answers: Record<string, string> = {};
  let complete = true;
  for (const q of clarify.questions) {
    const answer = answerFor(q);
    if (answer === null) complete = false;
    else answers[keyOf(q.qid)] = answer;
  }

  const send = () => {
    if (!complete) return;
    buzz('tap');
    void respond(answers);
  };

  /**
   * Whether one tap is the whole answer.
   *
   * Choices are part of the test, not just the count: an open-ended question
   * has nothing to tap, so treating it as single-tap hides the Send button
   * and leaves a text box that can be typed into and never submitted — the
   * same dead end, one screen further along.
   */
  const only = clarify.questions.length === 1 ? clarify.questions[0]! : null;
  const singleTap = Boolean(only && !only.multiSelect && only.choices.length > 0);

  const choose = (q: (typeof clarify.questions)[number], choice: string) => {
    const key = keyOf(q.qid);
    buzz('tap');

    if (q.multiSelect) {
      const chosen = picked[key] ?? [];
      const next = chosen.includes(choice)
        ? chosen.filter((c) => c !== choice)
        : [...chosen, choice];
      update({ picked: { ...picked, [key]: next }, otherOpen: { ...otherOpen, [key]: false } });
      return;
    }

    if (singleTap) {
      // Answer straight through rather than selecting and waiting for a
      // Confirm: one question, one choice, and a second tap to agree with
      // yourself is the kind of ceremony a thumb notices.
      void respond({ [key]: choice });
      return;
    }
    update({ picked: { ...picked, [key]: [choice] }, otherOpen: { ...otherOpen, [key]: false } });
  };

  return (
    <Sheet
      open
      dismissible={false}
      /**
       * Unreachable, and deliberately not wired to anything. `Sheet` only
       * calls this for an Escape or a backdrop tap, both of which it gates on
       * `dismissible` — and unlike an approval, which can always fall back to
       * "deny", there is no answer that is safe to invent on the user's
       * behalf. Interrupting the turn is the way out, from the composer.
       */
      onClose={() => {}}
      title="The agent has a question"
    >
      {clarify.questions.map((q, index) => {
        const key = keyOf(q.qid);
        const chosen = picked[key] ?? [];
        const isOther = otherOpen[key] ?? false;
        const openEnded = q.choices.length === 0;

        return (
          <div key={key || index} style={{ marginBottom: 18 }}>
            <p style={{ margin: '0 0 10px', fontSize: 15, lineHeight: 1.45 }}>{q.question}</p>

            {q.multiSelect && (
              <p style={{ margin: '-4px 0 8px', fontSize: 12.5, color: 'var(--text-faint)' }}>
                Pick as many as apply.
              </p>
            )}

            <div className="approval__actions">
              {q.choices.map((choice) => {
                const active = chosen.includes(choice) && !isOther;
                return (
                  <button
                    key={choice}
                    className={`btn${active ? ' btn--primary' : ''}`}
                    aria-pressed={q.multiSelect ? active : undefined}
                    style={{ textAlign: 'left', whiteSpace: 'normal', lineHeight: 1.35 }}
                    onClick={() => choose(q, choice)}
                  >
                    {q.multiSelect && (
                      <span aria-hidden style={{ marginRight: 8, opacity: active ? 1 : 0.35 }}>
                        {active ? '☑' : '☐'}
                      </span>
                    )}
                    {choice}
                  </button>
                );
              })}

              {!openEnded && (
                <button
                  className={`btn${isOther ? ' btn--primary' : ''}`}
                  aria-pressed={isOther}
                  onClick={() => {
                    buzz('tap');
                    update({ otherOpen: { ...otherOpen, [key]: !isOther } });
                  }}
                >
                  Something else…
                </button>
              )}
            </div>

            {(openEnded || isOther) && (
              <textarea
                autoFocus
                className="field"
                rows={3}
                placeholder="Type your answer…"
                value={freeText[key] ?? ''}
                onChange={(e) => update({ freeText: { ...freeText, [key]: e.target.value } })}
                style={{ width: '100%', marginTop: 10, resize: 'vertical', lineHeight: 1.45 }}
              />
            )}
          </div>
        );
      })}

      {/* One single-select question answers on the tap itself, so a Send
          button would only ever be reachable via "Something else…". */}
      {(!singleTap || Object.values(otherOpen).some(Boolean)) && (
        <button
          className="btn btn--primary"
          disabled={!complete}
          onClick={send}
          style={{ width: '100%', marginTop: 4 }}
        >
          Send answer
        </button>
      )}
    </Sheet>
  );
}
