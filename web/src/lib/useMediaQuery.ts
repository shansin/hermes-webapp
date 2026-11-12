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
 * The breakpoint for the pointer layouts — the Kanban board's side-by-side
 * lanes, the centred dialog sheets. Kept next to `--breakpoint-wide` in
 * `global.css`.
 */
export const WIDE_QUERY = '(min-width: 1000px)';

export function useWideLayout(): boolean {
  return useMediaQuery(WIDE_QUERY);
}

/**
 * When the navigation docks into a permanent rail.
 *
 * Earlier than `WIDE_QUERY`, deliberately: a portrait tablet (768–999px) used
 * to get the phone's modal drawer, a tap to summon a menu there was plenty of
 * room to show. With a slimmer rail (`--rail-w` drops to 256px below 1000px)
 * the content keeps 512px or more — wider than any phone the screens were
 * designed for, so nothing reflows into a cramped shape. An icon-only rail was
 * the alternative, and lost: it hides the hints, the unread and needs-you
 * counts lose their room, and the profile switcher has nowhere to live.
 *
 * The height condition keeps a *landscape phone* (wide but ~400px tall) on the
 * modal drawer, where a docked rail would be a scrolling list taking a third
 * of a short screen. Kanban keeps `WIDE_QUERY`: its lanes assume a pointer,
 * and a tablet is a touch screen.
 *
 * Written twice on purpose, like `WIDE_QUERY` — the `@media` rule that
 * reserves the rail's width in `global.css` must match it exactly, or the rail
 * appears without its space (or the space without its rail).
 */
export const RAIL_QUERY = '(min-width: 1000px), (min-width: 768px) and (min-height: 600px)';

export function useRailLayout(): boolean {
  return useMediaQuery(RAIL_QUERY);
}
