/**
 * Collapsible reasoning ("chain of thought") block.
 *
 * Always collapsed by default, streaming or not. Reasoning is the model's
 * working, not its answer, and most of the time nobody opened the app to read
 * it — so it announces itself and stays out of the way until asked for.
 *
 * The live turn used to auto-expand this so there was something to watch
 * before the answer started. That job now belongs to the status line, which
 * `StreamingTail` shows for the whole pre-answer phase: it says what the agent
 * is actually doing in one line, rather than unrolling a wall of thinking the
 * reader then has to scroll past to reach the reply.
 *
 * A block the user opens stays open for as long as it lives: nothing collapses
 * it back, since opening it was a deliberate act. Note that the live turn's
 * block and the finished message's are separate instances — `StreamingTail`
 * renders one, `MessageRow` the other — so expanding mid-turn does not carry
 * over when the reply lands. The finished message starts collapsed like the
 * rest of the transcript.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { IconChevron } from '../shared/Icons';
import { buzz } from '../../lib/haptics';

interface Props {
  text: string;
  streaming?: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({ text, streaming = false }: Props) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Follow the tail of the reasoning as it streams in.
  useEffect(() => {
    if (open && streaming && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [text, open, streaming]);

  if (!text.trim()) return null;

  return (
    <div className="think">
      <button
        className="think__head"
        onClick={() => {
          buzz('tap');
          setOpen((v) => !v);
        }}
        aria-expanded={open}
      >
        <span className={`think__caret${open ? ' think__caret--open' : ''}`}>
          <IconChevron size={14} />
        </span>
        <span>{streaming ? 'Thinking…' : 'Reasoning'}</span>
        {!open && (
          <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>
            {text.length.toLocaleString()} chars
          </span>
        )}
      </button>
      {open && (
        <div className="think__body" ref={bodyRef}>
          {text}
        </div>
      )}
    </div>
  );
});
