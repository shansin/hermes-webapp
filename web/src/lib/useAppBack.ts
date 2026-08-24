/**
 * One definition of what "back" means, for every header that offers it.
 *
 * Three screens had grown three different answers. `HubPage` called
 * `navigate(-1)` unless React Router's location key was still `default`;
 * Updates ignored history entirely and always went to `/chat`, so arriving
 * from Activity and pressing back landed you somewhere you had never been;
 * Kanban, Sessions and Activity offered nothing at all, which in a
 * `display: standalone` install — no browser chrome, no back gesture on iOS —
 * means the only way out of a screen is the hamburger.
 *
 * The rule here is the one every phone app already trained people to expect:
 * go back if there is anywhere to go back *to*, otherwise go up to the app's
 * home screen. Chat is home, so chat is the fallback.
 *
 * `location.key === 'default'` is not the right test for "anywhere to go back
 * to". A redirect — `/` → `/chat`, `/hub?tab=x` → `/x`, `/usage` → `/models` —
 * replaces the entry, which mints a fresh key while leaving the stack exactly
 * as short as it was; the check then says there is history behind us and
 * `navigate(-1)` walks straight out of the app. React Router's own `idx`,
 * which it keeps in `history.state` and does *not* advance on a replace, is
 * the honest count of how deep into this app's stack we are.
 *
 * `useHistoryDismiss` pushes sentinel entries for open overlays, and spreads
 * the existing state — `idx` included — into each one, so an open sheet does
 * not make this read high. It also pops its own sentinel on close, so by the
 * time a header button is pressable the count is back where it belongs.
 */
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

interface RouterHistoryState {
  idx?: number;
}

/** Whether there is an in-app history entry behind the current one. */
export function canGoBack(): boolean {
  const idx = (window.history.state as RouterHistoryState | null)?.idx;
  return typeof idx === 'number' && idx > 0;
}

/**
 * @param fallback where to go when this screen is the entry point — a
 *   bookmark, a home-screen shortcut, a notification tap.
 */
export function useAppBack(fallback = '/chat'): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    if (canGoBack()) navigate(-1);
    // `replace`, so a back press from the fallback does not bounce straight
    // into the screen we just left.
    else navigate(fallback, { replace: true });
  }, [navigate, fallback]);
}
