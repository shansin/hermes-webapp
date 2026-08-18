/**
 * Collapsible reasoning ("chain of thought") block.
 *
 * Collapsed by default for finished messages, but auto-expanded while a turn
 * is streaming so there is something to watch before the answer starts.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { IconChevron } from '../shared/Icons';
import { buzz } from '../../lib/haptics';

interface Props {
  text: string;
  streaming?: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({ text, streaming = false }: Props) {
  const [open, setOpen] = useState(streaming);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Follow the tail of the reasoning as it streams in.
  useEffect(() => {
    if (open && streaming && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [text, open, streaming]);

  // Collapse once the turn finishes, so the transcript stays readable.
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming) setOpen(false);
    wasStreaming.current = streaming;
  }, [streaming]);

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
