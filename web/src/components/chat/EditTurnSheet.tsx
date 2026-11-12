/**
 * Edit a past prompt and run the conversation again from there.
 *
 * Worth being explicit about the cost: resubmitting rewinds the session, so
 * everything after the edited message is dropped on the backend too. The sheet
 * says so rather than letting the transcript quietly lose its tail.
 *
 * "Edit in a fork" is the non-destructive alternative, when offered: the
 * conversation up to this message is copied into a new session and the edited
 * prompt runs there, leaving this one whole (`lib/forkFlow.ts`).
 */
import { useEffect, useRef, useState } from 'react';
import { Sheet } from '../shared/Sheet';

interface Props {
  turn: { id: string; text: string } | null;
  onClose: () => void;
  onSubmit: (text: string) => void;
  /** Absent when a fork is not possible here (the first message, a fork in flight). */
  onSubmitInFork?: (text: string) => void;
}

export function EditTurnSheet({ turn, onClose, onSubmit, onSubmitInFork }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!turn) return;
    setText(turn.text);
    // Focus after the sheet's open transition, or the keyboard fights it.
    const t = setTimeout(() => ref.current?.focus(), 180);
    return () => clearTimeout(t);
  }, [turn]);

  const changed = turn != null && text.trim() !== turn.text.trim();

  return (
    <Sheet
      open={turn != null}
      title="Edit message"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {onSubmitInFork && (
            <button className="btn" disabled={!text.trim() || !changed} onClick={() => onSubmitInFork(text.trim())}>
              Edit in a fork
            </button>
          )}
          <button
            className="btn btn--primary"
            disabled={!text.trim() || !changed}
            onClick={() => onSubmit(text.trim())}
          >
            Resend
          </button>
        </>
      }
    >
      <textarea
        ref={ref}
        className="field"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        style={{ width: '100%', resize: 'vertical', lineHeight: 1.45 }}
      />
      <p style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', margin: '10px 2px 0' }}>
        Resending rewinds the conversation — this message and everything after it are
        removed, then the edited version runs in their place.
        {onSubmitInFork && ' Edit in a fork keeps this conversation as it is and runs the edit in a copy.'}
      </p>
    </Sheet>
  );
}
