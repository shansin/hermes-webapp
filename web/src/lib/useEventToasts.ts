/**
 * In-app notifications for things that finish while you're elsewhere.
 *
 * The gateway broadcasts `background.complete`, `cron.changed` and
 * `subagent.complete` on the same socket the chat uses, so no extra connection
 * is needed. On plain HTTP this is the only notification channel available —
 * real push needs a service worker, which needs HTTPS.
 *
 * Over HTTPS the same events also arrive as web push (see `lib/push.ts`). The
 * service worker suppresses its banner while the app is visible and forwards
 * the text here instead, so the two channels never both fire on screen.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { hermes } from '../ws/client';
import { useUi } from '../store/ui';
import { buzz } from './haptics';

export function useEventToasts(): void {
  const toast = useUi.getState().toast;
  const navigate = useNavigate();

  useEffect(
    () =>
      hermes.onEvent(({ type, payload }) => {
        const p = (payload ?? {}) as Record<string, unknown>;

        switch (type) {
          case 'background.complete': {
            buzz('done');
            const label = typeof p.title === 'string' ? p.title : 'Background task';
            toast(`${label} finished`, 'success');
            return;
          }

          case 'subagent.complete': {
            const name = typeof p.name === 'string' ? p.name : 'Subagent';
            toast(`${name} finished`, 'info');
            return;
          }

          case 'notification.show': {
            const text =
              (typeof p.text === 'string' && p.text) ||
              (typeof p.message === 'string' && p.message) ||
              '';
            if (text) {
              buzz('tap');
              toast(text, 'info');
            }
            return;
          }

          case 'cron.changed': {
            toast('A scheduled job ran', 'info');
            return;
          }

          default:
            return;
        }
      }),
    [toast],
  );

  /**
   * Messages from the push service worker.
   *
   * `hermes-push` is a notification the worker chose not to show because a
   * window was visible. Toasting it unconditionally would double up with the
   * WebSocket handler above, which has already reported the same event — so it
   * only surfaces when the socket is *not* open, which is exactly the case the
   * worker's message is the sole delivery for.
   */
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const onMessage = (event: MessageEvent) => {
      const data = (event.data ?? {}) as { source?: string; text?: string; url?: string };

      if (data.source === 'hermes-push' && data.text && hermes.state !== 'open') {
        buzz('tap');
        toast(data.text, 'info');
        return;
      }

      if (data.source === 'hermes-push-click' && data.url) {
        // Route in place rather than letting the worker `navigate()` the
        // window: a reload would drop the live socket and replay the whole
        // cold start just to move between two screens.
        navigate(data.url);
      }
    };

    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [toast, navigate]);
}
