/**
 * Subscribe to a CSS media query from React.
 *
 * Layout that is purely visual belongs in CSS, and nearly all of this app's
 * is. This exists for the cases where the *markup* has to differ, not just the
 * painting: the docked navigation rail is a `<nav>` with no backdrop, no drag
 * handler, no scroll lock and no history sentinel, and none of those can be
 * turned off from a stylesheet. Rendering the overlay drawer's behaviour and
 * then hiding its consequences with CSS would leave a phantom history entry
 * swallowing the back button on every desktop screen.
 *
 * `useSyncExternalStore` rather than an effect, so the first render already
 * has the right answer — a wide window must not paint one frame of the phone
 * layout on the way to the desktop one.
 */
import { useCallback, useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    // Server snapshot: there is no SSR here, but the test environment renders
    // without `matchMedia` on some paths and the phone layout is the safe
    // answer either way.
    () => false,
  );
}

/**
 * The one breakpoint that decides between the phone layout and the desktop
 * one. Kept next to `--breakpoint-wide` in `global.css`; changing one without
 * the other splits the navigation rail from the space reserved for it.
 */
export const WIDE_QUERY = '(min-width: 1000px)';

export function useWideLayout(): boolean {
  return useMediaQuery(WIDE_QUERY);
}
