import { useEffect, useState } from 'react';

/**
 * Settle a value only once it stops changing for `ms`.
 *
 * Distinct from `useThrottled`, which emits steadily while a value churns:
 * debouncing waits for quiet, which is what a search box wants. Typing
 * "kanban" fed the raw value straight into a query key, so it fired six
 * requests and threw five of them away.
 */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);

  return settled;
}
