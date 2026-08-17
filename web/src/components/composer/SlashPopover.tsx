/**
 * Inline completion list for a partially typed slash command.
 *
 * Sits directly above the composer so the thumb travels the shortest distance
 * from the keyboard to a row. Ranking is the gateway's — `complete.slash`
 * already scores names *and* descriptions and orders skills by usage — so this
 * component only filters out commands with no phone surface and renders.
 */
import { useEffect, useRef } from 'react';
import type { CompletionItem } from '../../api/commands';
import { describeCommand } from '../../lib/slashCommands';
import { buzz } from '../../lib/haptics';

interface Props {
  items: CompletionItem[];
  active: number;
  onPick: (item: CompletionItem) => void;
  onBrowseAll: () => void;
}

/** Completion `text` arrives without a leading slash; displays keep theirs. */
const label = (item: CompletionItem): string =>
  item.display || (item.text.startsWith('/') ? item.text : `/${item.text}`);

export function SlashPopover({ items, active, onPick, onBrowseAll }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the keyboard-selected row in view without scrolling the page behind.
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (items.length === 0) return null;

  return (
    <div className="slash-pop">
      <div className="slash-pop__list" ref={listRef} role="listbox">
        {items.map((item, i) => (
          <button
            key={item.text}
            role="option"
            aria-selected={i === active}
            className={`slash-pop__row${i === active ? ' slash-pop__row--active' : ''}`}
            // Pointer-down, not click: a click would first blur the textarea,
            // and the collapsing keyboard moves the row out from under the tap.
            onPointerDown={(e) => {
              e.preventDefault();
              buzz('tap');
              onPick(item);
            }}
          >
            <span className="slash-pop__name">
              {label(item)}
              {item.kind === 'skill' && <span className="slash-pop__kind">skill</span>}
            </span>
            <span className="slash-pop__meta">{describeCommand(label(item), item.meta)}</span>
          </button>
        ))}
      </div>
      <button className="slash-pop__all" onPointerDown={(e) => { e.preventDefault(); onBrowseAll(); }}>
        Browse all commands
      </button>
    </div>
  );
}
