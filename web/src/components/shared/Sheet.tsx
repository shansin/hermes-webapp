/**
 * Bottom sheet — the primary modal idiom on a phone.
 *
 * Dismissable by backdrop tap, a downward drag on the grip, Escape, or the
 * system back button. Body scroll is locked while open so the page behind
 * doesn't move under the sheet.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IconClose } from './Icons';
import { buzz } from '../../lib/haptics';
import { useHistoryDismiss } from '../../lib/useHistoryDismiss';

interface Props {
  open: boolean;
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  /** Hide the close button for sheets that demand an explicit choice. */
  dismissible?: boolean;
}

/** Everything focusable, in tab order, excluding anything disabled or hidden. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({ open, title, onClose, children, actions, dismissible = true }: Props) {
  const [dragY, setDragY] = useState(0);
  const startY = useRef<number | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  // Back closes the sheet rather than the screen underneath it. A sheet that
  // demands an explicit choice opts out — the same reason it has no close
  // button — so back can't be used to duck the question.
  useHistoryDismiss(open && dismissible, onClose);

  /**
   * Body scroll lock, Escape, and focus.
   *
   * `aria-modal` is a promise to assistive tech that the rest of the page is
   * inert, and nothing was keeping that promise: focus stayed wherever it was
   * behind the sheet, so tabbing walked the screen underneath while a modal
   * claiming to be exclusive sat on top. That is worst on the approval sheet,
   * which is deliberately not dismissible — the one sheet you must interact
   * with was the one you could tab straight past.
   *
   * Focus moves in on open and returns to whatever opened it on close, which
   * is what makes opening a sheet from a keyboard survivable at all.
   */
  useEffect(() => {
    if (!open) return;

    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const returnTo = document.activeElement as HTMLElement | null;

    // After the open transition, or the move fights the animation — and on a
    // phone, focusing a field mid-transition brings the keyboard up crooked.
    const focusTimer = setTimeout(() => {
      const root = panel.current;
      if (!root) return;
      if (root.contains(document.activeElement)) return;
      /**
       * The body before the head, so focus lands on what the sheet is *for*
       * rather than on its close button — which is the first focusable in DOM
       * order and the last thing anyone opening a sheet wants to be handed.
       */
      const body = root.querySelector('.sheet__body');
      const first =
        body?.querySelector<HTMLElement>(FOCUSABLE) ?? root.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? root).focus();
    }, 60);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const root = panel.current;
      if (!root) return;
      // No visibility filtering: `FOCUSABLE` already excludes disabled controls
      // and anything taken out of the tab order, and a sheet hides a section by
      // not rendering it rather than by CSS. Testing `offsetParent` here would
      // buy nothing and would be wrong wherever layout has not been computed.
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) {
        e.preventDefault();
        root.focus();
        return;
      }

      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;

      // Wrap at both ends, and pull focus back in if it has escaped entirely.
      if (!root.contains(active)) {
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
      clearTimeout(focusTimer);
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
      // Only if focus is still ours to give back; the sheet may have closed by
      // the user tapping something else entirely.
      if (returnTo?.isConnected && !document.activeElement?.closest('.sheet')) {
        returnTo.focus();
      }
    };
  }, [open, onClose, dismissible]);

  // Reset any leftover drag offset when the sheet reopens.
  useEffect(() => {
    if (open) setDragY(0);
  }, [open]);

  if (!open) return null;

  const close = () => {
    buzz('tap');
    onClose();
  };

  return (
    <>
      <div className="sheet-backdrop" onClick={dismissible ? close : undefined} />
      <div
        className="sheet"
        ref={panel}
        style={dragY ? { transform: `translateY(${dragY}px)` } : undefined}
        role="dialog"
        aria-modal="true"
        // Named by its own heading where it has one, so the sheet announces
        // what it is rather than just "dialog".
        aria-labelledby={title ? titleId : undefined}
        // Focusable as a last resort, for a sheet whose body holds no control.
        tabIndex={-1}
      >
        <div
          className="sheet__grip-zone"
          onTouchStart={(e) => {
            if (!dismissible) return;
            startY.current = e.touches[0]?.clientY ?? null;
          }}
          onTouchMove={(e) => {
            if (startY.current === null) return;
            const dy = (e.touches[0]?.clientY ?? 0) - startY.current;
            // Only track downward drags; upward should not lift the sheet.
            if (dy > 0) setDragY(dy);
          }}
          onTouchEnd={() => {
            if (dragY > 90) close();
            else setDragY(0);
            startY.current = null;
          }}
        >
          <div className="sheet__grip" />
        </div>

        {(title || dismissible) && (
          <div className="sheet__head">
            <div className="sheet__title" id={titleId}>
              {title}
            </div>
            {actions}
            {dismissible && (
              <button className="icon-btn" onClick={close} aria-label="Close">
                <IconClose size={20} />
              </button>
            )}
          </div>
        )}

        <div className="sheet__body">{children}</div>
      </div>
    </>
  );
}
