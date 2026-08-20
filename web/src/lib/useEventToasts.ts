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
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { notificationKeys, useNotifications } from '../api/notifications';
import { hermes } from '../ws/client';
import { useUi } from '../store/ui';
import { buzz } from './haptics';

export function useEventToasts(): void {
  const toast = useUi.getState().toast;
  const navigate = useNavigate();
  const qc = useQueryClient();

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
            /**
             * The event is empty — no job, no status, no session (see
             * `server/src/push/cron.ts`). There is nothing to toast from it,
             * and it fires several times per run, so toasting would be both
             * uninformative and repetitive.
             *
             * The proxy is meanwhile fetching what actually happened and
             * appending it to the feed. Pull that forward; `useCronFeedToasts`
             * announces whatever turns up, once per run.
             */
            void qc.invalidateQueries({ queryKey: notificationKeys.all });
            return;
          }

          default:
            return;
        }
      }),
    [toast, qc],
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

/**
 * Announce cron runs in-app, from the feed rather than from the event.
 *
 * `cron.changed` carries nothing and fires several times per run, so the toast
 * has to come from the reconciled feed instead — one entry per run, carrying
 * the agent's actual reply. Mounted once, at the app shell.
 *
 * The first load is adopted silently: arriving at the app with ten runs
 * recorded since yesterday should not stack ten toasts.
 */
export function useCronFeedToasts(): void {
  const toast = useUi.getState().toast;
  const { data } = useNotifications();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!data) return;

    if (seen.current === null) {
      seen.current = new Set(data.map((e) => e.id));
      return;
    }

    // Oldest first, so a batch reads in the order it happened.
    for (const entry of [...data].reverse()) {
      if (seen.current.has(entry.id)) continue;
      seen.current.add(entry.id);
      buzz(entry.failed ? 'warn' : 'done');
      toast(`${entry.title}: ${entry.body}`, entry.failed ? 'error' : 'success');
    }
  }, [data, toast]);
}
