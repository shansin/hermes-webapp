import { useEffect, useRef, useState } from 'react';

/**
 * Rate-limit how often a fast-changing value reaches the render tree.
 *
 * Streaming deltas arrive 30–60×/second, and the chat bubble re-parses its
 * whole markdown AST for each one. The eye cannot read faster than ~10 fps of
 * text growth, so rendering every delta spends most of its work invisibly —
 * on a phone that is the difference between smooth and janky.
 *
 * Trailing edge, so the last delta of a turn is never dropped. An empty value
 * flushes immediately: that is a turn resetting, and lag there is visible.
 */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  latest.current = value;

  useEffect(() => {
    if (value === '' || value == null) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setShown(value);
      return;
    }
    if (timer.current) return; // a flush is already pending
    timer.current = setTimeout(() => {
      timer.current = null;
      setShown(latest.current);
    }, ms);
  }, [value, ms]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return shown;
}
