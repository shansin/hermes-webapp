/**
 * In-app notifications for things that finish while you're elsewhere.
 *
 * The gateway broadcasts `background.complete`, `cron.changed` and
 * `subagent.complete` on the same socket the chat uses, so no extra connection
 * is needed. On plain HTTP this is the only notification channel available —
 * real push needs a service worker, which needs HTTPS.
 */
import { useEffect } from 'react';
import { hermes } from '../ws/client';
import { useUi } from '../store/ui';
import { buzz } from './haptics';

export function useEventToasts(): void {
  const toast = useUi.getState().toast;

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
}
