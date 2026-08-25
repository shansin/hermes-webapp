/**
 * Full-screen viewer for something in the transcript that is unreadable at
 * phone width — a mermaid diagram, a screenshot the agent took.
 *
 * Extracted from `MermaidBlock` when images gained the same affordance: the
 * dialog's hard part is not the backdrop, it is the dismissal, and two copies
 * of that would drift. It was previously dismissable by tap alone — no Escape
 * on a desktop, and on a phone the back button closed the whole screen behind
 * it — so it takes the history sentinel and a short focus trap.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { IconClose } from '../shared/Icons';
import { useHistoryDismiss } from '../../lib/useHistoryDismiss';

export function ZoomOverlay({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const close = useCallback(onClose, [onClose]);
  const panel = useRef<HTMLDivElement>(null);
  useHistoryDismiss(true, close);

  /**
   * Escape, and the focus half of the `aria-modal` promise.
   *
   * The dialog claimed the rest of the page was inert while leaving focus
   * exactly where it was — behind it, on the transcript — so a keyboard tabbed
   * straight through a "modal" it could neither see nor leave. The only
   * focusable thing in here is the close button, so the trap is short: hold
   * focus inside, and hand it back to whatever opened this on the way out.
   * Mirrors `shared/Sheet.tsx`, which is where the full version lives.
   */
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    const root = panel.current;
    root?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const el = panel.current;
      if (!el) return;
      const items = [...el.querySelectorAll<HTMLElement>('button:not([disabled])')];
      const first = items[0] ?? el;
      const last = items[items.length - 1] ?? el;
      const active = document.activeElement;
      if (!el.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, [close]);

  return (
    <div
      ref={panel}
      className="zoom"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
    >
      <button type="button" className="icon-btn zoom__close" aria-label="Close" onClick={close}>
        <IconClose size={20} />
      </button>
      <div className="zoom__inner">{children}</div>
    </div>
  );
}
