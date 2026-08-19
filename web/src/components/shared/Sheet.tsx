/**
 * Bottom sheet — the primary modal idiom on a phone.
 *
 * Dismissable by backdrop tap, a downward drag on the grip, Escape, or the
 * system back button. Body scroll is locked while open so the page behind
 * doesn't move under the sheet.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
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

export function Sheet({ open, title, onClose, children, actions, dismissible = true }: Props) {
  const [dragY, setDragY] = useState(0);
  const startY = useRef<number | null>(null);

  // Back closes the sheet rather than the screen underneath it. A sheet that
  // demands an explicit choice opts out — the same reason it has no close
  // button — so back can't be used to duck the question.
  useHistoryDismiss(open && dismissible, onClose);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
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
        style={dragY ? { transform: `translateY(${dragY}px)` } : undefined}
        role="dialog"
        aria-modal="true"
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
            <div className="sheet__title">{title}</div>
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
