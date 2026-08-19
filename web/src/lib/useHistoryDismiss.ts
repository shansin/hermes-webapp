/**
 * Make an overlay dismissable with the system back button.
 *
 * On a phone — and especially in `display: standalone`, where there is no
 * browser chrome — back is how people close things. Without this, back on an
 * open sheet navigates the route *behind* it, or leaves the app entirely, and
 * the sheet is still there when they come back.
 *
 * The mechanism is a sentinel history entry pushed when the overlay opens:
 *
 *   - back pops it, `popstate` fires, and the overlay closes instead of the
 *     route changing — the URL never moved, so React Router has nothing to do
 *   - closing any other way (backdrop, Escape, a drag, a button) pops the
 *     sentinel back off, so it can't pile up
 *
 * Nesting works because every sentinel carries its own id. A sheet opened on
 * top of another pushes a second entry, and on back each overlay asks whether
 * the entry we just landed on is *its own*: the one below stays open, only the
 * top one closes.
 *
 * The existing history state is spread into the sentinel rather than replaced.
 * React Router keeps its own bookkeeping (`idx`, `key`) in there, and pushing
 * a bare object would strand it.
 */
import { useEffect, useRef } from 'react';

let overlaySeq = 0;

interface SentinelState {
  __overlayId?: number;
}

export function useHistoryDismiss(open: boolean, onClose: () => void): void {
  /**
   * Callers pass inline arrows, so `onClose` is a new function on every
   * render. Kept in a ref rather than in the dependency list, or the effect
   * would tear down and push a fresh sentinel each time the parent re-renders.
   */
  const cb = useRef(onClose);
  useEffect(() => {
    cb.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    const id = ++overlaySeq;
    const current = (history.state ?? {}) as SentinelState;
    history.pushState({ ...current, __overlayId: id }, '');

    const onPop = () => {
      // Landing on our *own* sentinel means something above us was dismissed
      // and we are now the top overlay — which is a reason to stay open.
      if ((history.state as SentinelState | null)?.__overlayId === id) return;
      cb.current();
    };
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('popstate', onPop);
      // Pop the sentinel only while it is still the entry we are sitting on.
      // If a navigation replaced or moved past it, going back here would undo
      // that navigation instead.
      if ((history.state as SentinelState | null)?.__overlayId === id) {
        history.back();
      }
    };
  }, [open]);
}
