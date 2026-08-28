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

/**
 * The overlays that are open right now.
 *
 * This is what lets a *hand-off* be told from a *nest*, which look identical
 * from inside a single overlay and need opposite handling.
 *
 * When one sheet opens another and closes itself — a menu item, a slash
 * command that opens a picker — React runs every cleanup in the commit before
 * any new effect, so the departing overlay's `history.back()` is queued first
 * and the arriving overlay pushes its sentinel second. The queued back then
 * lands on the *newcomer's* entry, its `popstate` sees an id that is not its
 * own, and it closes itself a frame after it opened. Verified in Chrome; jsdom
 * fires no `popstate` for `back()` at all, which is why no test caught it.
 *
 * So an overlay opening onto an entry whose owner has already gone reuses that
 * entry instead of stacking on it, and the departing one's back is deferred
 * long enough to notice it has been superseded and skip. Between them the
 * stack ends up exactly one entry deep either way, and back means "close the
 * thing on screen" in both.
 */
const liveOverlays = new Set<number>();

interface SentinelState {
  __overlayId?: number;
}

/** Set while a pop we asked for is still in flight. */
let unwinding = false;
/** Set while an unwind pass is already queued for this tick. */
let unwindQueued = false;

/**
 * Pop the sentinels of overlays that have closed, one at a time.
 *
 * Each overlay used to pop its own, which is right until **two close in the
 * same commit** — a sheet and the sheet it was nested in, dismissed together,
 * which is what "Discard" in the file viewer does. Both cleanups run before
 * either pop lands: the first calls `history.back()`, the second checks while
 * that navigation is still pending, sees the *first* overlay's id on top
 * rather than its own, and correctly declines to pop something that is not
 * hers. The entry underneath is then orphaned — an overlay-less sentinel that
 * swallows the next back press, which is a back button that visibly does
 * nothing on a screen with nothing open.
 *
 * So the pops are driven from here instead: walk down while the entry on top
 * belongs to an overlay that has closed, and stop at the first one that does
 * not. That entry is either a live overlay's sentinel or a real navigation,
 * and popping it would undo something the user actually did.
 *
 * One pop at a time, resumed from the `popstate` it causes, rather than a
 * counted `history.go(-n)`: the count can only ever be a guess about a stack
 * something else may also be writing to, whereas re-reading the top after each
 * pop is a fact.
 */
function unwind(): void {
  if (unwinding) return;
  const top = (history.state as SentinelState | null)?.__overlayId;
  if (typeof top !== 'number' || liveOverlays.has(top)) return;

  unwinding = true;
  const onPop = () => {
    window.removeEventListener('popstate', onPop);
    clearTimeout(escape);
    unwinding = false;
    // The entry underneath may be another closed overlay's.
    unwind();
  };
  /**
   * A pop that never arrives must not wedge this for the life of the page.
   * It should not happen — a sentinel on top means an entry below it — but
   * the cost of being wrong is that no overlay can ever tidy up again.
   */
  const escape = setTimeout(() => {
    window.removeEventListener('popstate', onPop);
    unwinding = false;
  }, 1000);

  window.addEventListener('popstate', onPop);
  history.back();
}

/**
 * Ask for an unwind after the current commit.
 *
 * Deferred so the pass sees the whole of it rather than half: React runs
 * cleanups before effects, so at cleanup time an overlay taking over from a
 * departing one has not pushed yet and the entry still looks abandoned. A
 * microtask runs after the effect flush, by which point a successor has
 * claimed it and there is nothing to pop.
 */
function scheduleUnwind(): void {
  if (unwindQueued) return;
  unwindQueued = true;
  queueMicrotask(() => {
    unwindQueued = false;
    unwind();
  });
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
    /**
     * Whether the entry we are opening onto belongs to an overlay that has
     * already closed. If it does this is a hand-off, and stacking on it would
     * leave a dead entry buried under ours — one back press that closes
     * nothing.
     */
    const supersedes =
      typeof current.__overlayId === 'number' && !liveOverlays.has(current.__overlayId);
    liveOverlays.add(id);
    if (supersedes) history.replaceState({ ...current, __overlayId: id }, '');
    else history.pushState({ ...current, __overlayId: id }, '');

    const onPop = () => {
      // Landing on our *own* sentinel means something above us was dismissed
      // and we are now the top overlay — which is a reason to stay open.
      if ((history.state as SentinelState | null)?.__overlayId === id) return;
      cb.current();
    };
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('popstate', onPop);
      liveOverlays.delete(id);
      // Not "pop mine" — "pop whatever is now abandoned". See `unwind`.
      scheduleUnwind();
    };
  }, [open]);
}
