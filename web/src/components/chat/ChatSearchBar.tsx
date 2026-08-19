/**
 * Find-in-transcript.
 *
 * Matching is at message granularity, not word: the assistant's text is
 * rendered markdown by the time it's on screen, so highlighting a substring
 * inside it would mean reaching into react-markdown's output and splitting
 * text nodes on every keystroke. Marking whole messages and stepping between
 * them gets you to the right place, which is the actual job, without putting
 * a string search on the render path of every bubble.
 */
import { useEffect, useRef } from 'react';
import { IconChevron, IconClose } from '../shared/Icons';

interface Props {
  query: string;
  onQuery: (q: string) => void;
  /** Total matching messages. */
  count: number;
  /** Zero-based position within the matches, or -1 when there are none. */
  index: number;
  onStep: (delta: number) => void;
  onClose: () => void;
}

export function ChatSearchBar({ query, onQuery, count, index, onStep, onClose }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  // Opening the bar should put the cursor in it — this is reached by tapping a
  // search button, so there is no other thing the user could want next.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="chat-search">
      <input
        ref={ref}
        className="chat-search__input"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Find in conversation…"
        // `search` gets the right virtual keyboard; the form-less input means
        // Enter would otherwise do nothing at all.
        type="search"
        enterKeyHint="next"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />

      <span className="chat-search__count">
        {query ? (count > 0 ? `${index + 1}/${count}` : 'None') : ''}
      </span>

      <button
        className="icon-btn"
        onClick={() => onStep(-1)}
        disabled={count === 0}
        aria-label="Previous match"
      >
        <IconChevron size={16} style={{ transform: 'rotate(-90deg)' }} />
      </button>
      <button
        className="icon-btn"
        onClick={() => onStep(1)}
        disabled={count === 0}
        aria-label="Next match"
      >
        <IconChevron size={16} style={{ transform: 'rotate(90deg)' }} />
      </button>
      <button className="icon-btn" onClick={onClose} aria-label="Close search">
        <IconClose size={17} />
      </button>
    </div>
  );
}
