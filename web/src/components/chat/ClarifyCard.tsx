/**
 * A finished clarify, as it reads in the transcript afterwards.
 *
 * The sheet is gone the moment it is answered, and what stayed behind was a
 * generic tool card — `⚒ clarify`, collapsed, hiding the exchange inside a
 * JSON blob. That is backwards. A question the agent stopped to ask and the
 * answer that unblocked it is the part of a transcript a person actually
 * wants to find later, and it was the one part they had to dig for.
 *
 * So it renders open, with the choices laid out and the one that was taken
 * marked. Showing the options *not* taken is deliberate: an answer is only
 * meaningful against what was on offer, and "I picked the third of four"
 * explains a decision that "Playwright" alone does not.
 */
import { memo } from 'react';
import { readClarify } from '../../lib/clarifyExchange';
import { ToolCallCard } from './ToolCallCard';
import { IconCheck } from '../shared/Icons';

interface ClarifyMessage {
  kind: 'tool';
  id: string;
  toolId: string;
  name: string;
  context?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  durationS?: number;
  status: 'running' | 'done';
  at: number | null;
}

export const ClarifyCard = memo(function ClarifyCard({ msg }: { msg: ClarifyMessage }) {
  const exchange = readClarify(msg);

  // Unreadable payload: the generic card at least shows what actually arrived,
  // which beats a confident-looking card with nothing in it.
  if (!exchange) return <ToolCallCard msg={msg} />;

  const waiting = msg.status === 'running';

  return (
    <div className={`clarify${waiting ? ' clarify--waiting' : ''}`}>
      <div className="clarify__head">
        <span className="clarify__icon" aria-hidden>
          ?
        </span>
        <span className="clarify__label">
          {waiting ? 'Waiting for your answer' : 'You were asked'}
        </span>
        {exchange.timedOut && <span className="clarify__stale">timed out</span>}
      </div>

      {exchange.questions.map((q, index) => (
        <div key={`${q.question}-${index}`} className="clarify__q">
          <p className="clarify__question">{q.question}</p>

          {q.choices.length > 0 && (
            <ul className="clarify__choices">
              {q.choices.map((choice) => {
                const taken = q.responses.includes(choice);
                return (
                  <li key={choice} className={`clarify__choice${taken ? ' is-taken' : ''}`}>
                    <span className="clarify__mark" aria-hidden>
                      {taken ? <IconCheck size={13} /> : null}
                    </span>
                    <span>{choice}</span>
                  </li>
                );
              })}
            </ul>
          )}

          {/*
            A typed answer, shown as itself rather than squeezed into the list
            above — it is not one of the choices, and pretending otherwise
            loses the fact that none of them fitted.
          */}
          {q.responses
            .filter((r) => !q.choices.includes(r))
            .map((r) => (
              <div key={r} className="clarify__typed">
                <span className="clarify__typed-label">
                  {q.choices.length > 0 ? 'Answered instead' : 'You answered'}
                </span>
                {r}
              </div>
            ))}

          {q.responses.length === 0 && !waiting && (
            <div className="clarify__none">
              {exchange.timedOut ? 'No answer — the agent moved on.' : 'Not answered.'}
            </div>
          )}
        </div>
      ))}
    </div>
  );
});
