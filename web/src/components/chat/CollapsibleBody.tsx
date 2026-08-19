/**
 * An assistant reply, clamped when it runs long.
 *
 * Tool output and reasoning were already individually capped and scrollable,
 * but assistant text was not — a four-hundred-line answer pushed the rest of
 * the conversation off a phone screen and made scrolling back past it a chore.
 *
 * The clamp is measured, not guessed from character count: markdown collapses
 * to wildly different heights depending on what's in it, and a reply that is
 * mostly one wide code block is far shorter on screen than its length implies.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Clamp height in px. Roughly a phone screen's worth of prose — past this the
 * message is costing more than it's giving, and the reader gets a choice.
 */
const CLAMP_PX = 420;

/**
 * Slack before clamping. A reply a little over the limit should just render:
 * collapsing to save forty pixels is pure annoyance.
 */
const SLACK_PX = 120;

export function CollapsibleBody({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);

  // Measure after paint, and re-measure when the content resizes — markdown
  // can grow late as fonts settle or a mermaid diagram finishes rendering.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > CLAMP_PX + SLACK_PX);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);

  const clamped = overflows && !open;

  return (
    <>
      <div
        ref={ref}
        className={`msg__body${clamped ? ' msg__body--clamped' : ''}`}
        style={clamped ? { maxHeight: CLAMP_PX } : undefined}
      >
        {children}
      </div>
      {overflows && (
        <button className="msg__more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}
