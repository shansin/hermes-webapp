/**
 * Long-press without swallowing taps or fighting the scroller.
 *
 * A press that turns into a scroll must not fire — on a phone almost every
 * touch on the transcript is the start of a drag — so movement past a small
 * threshold cancels the timer. The handler reports whether it fired so a tap
 * handler can bow out when it did.
 */
import { useCallback, useRef, type MouseEvent, type PointerEvent } from 'react';

const HOLD_MS = 450;
/** Movement past this many px is a scroll, not a press. */
const SLOP_PX = 10;

export function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  /** Set when the timer fired, so the click that follows can be suppressed. */
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      // Right-click and stylus barrel presses have their own menus.
      if (e.button !== 0) return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, HOLD_MS);
    },
    [onLongPress],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const o = origin.current;
      if (!o) return;
      if (Math.abs(e.clientX - o.x) > SLOP_PX || Math.abs(e.clientY - o.y) > SLOP_PX) clear();
    },
    [clear],
  );

  /** True when the press already fired, meaning the tap should be ignored. */
  const consumed = useCallback(() => {
    const was = fired.current;
    fired.current = false;
    return was;
  }, []);

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
      // The browser's own text-selection menu competes with the press.
      onContextMenu: (e: MouseEvent) => e.preventDefault(),
    },
    consumed,
  };
}
