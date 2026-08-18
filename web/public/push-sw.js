/**
 * Push handlers, imported into the Workbox-generated service worker.
 *
 * This file exists separately because the build uses `generateSW`: the worker
 * is produced entirely from config, so there is nowhere to put a `push`
 * listener. `workbox.importScripts` in vite.config.ts pulls this in at the top
 * of the generated worker, which keeps every line of caching behaviour there
 * untouched — the alternative, switching to `injectManifest`, would mean
 * hand-porting all of it for the sake of the two listeners below.
 */

/* global self, clients */

/**
 * VAPID keys travel as base64url text but `subscribe()` wants bytes. The spec
 * allows the string form, and Chrome accepts it — Safari has historically not,
 * and Safari is the browser this feature exists for on iOS.
 */
function vapidKeyToBytes(base64url) {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = self.atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Show the banner — unless the app is already on screen.
 *
 * A phone with the app open gets an in-app toast from `useEventToasts` over
 * the WebSocket, so showing a system banner too would double every event. The
 * page is told instead, and shows its own toast.
 *
 * The cost of that: `userVisibleOnly` subscriptions are expected to display
 * something for every push, and browsers track a budget for the ones that
 * don't. Suppressing only while a client is genuinely *visible* keeps this
 * rare — that window is exactly when the user is looking at the app and the
 * WebSocket is delivering anyway.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A malformed payload still deserves a banner — falls through to defaults.
  }

  const title = data.title || 'Hermes';
  const body = data.body || 'Something happened.';
  const url = data.url || '/chat';

  event.waitUntil(
    (async () => {
      const open = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const visible = open.filter((c) => c.visibilityState === 'visible');

      if (visible.length) {
        for (const client of visible) {
          client.postMessage({ source: 'hermes-push', kind: data.kind || '', text: body, url });
        }
        return;
      }

      await self.registration.showNotification(title, {
        body,
        // `tag` collapses repeats of the same kind of event rather than
        // stacking them; the server picks it per event type.
        tag: data.tag || 'hermes',
        renotify: true,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url },
      });
    })(),
  );
});

/**
 * Focus an existing window rather than opening a second copy of the app —
 * a standalone PWA that spawns duplicate windows on every tap is unusable.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/chat';

  event.waitUntil(
    (async () => {
      const open = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of open) {
        if ('focus' in client) {
          // Route in place when we can: `navigate` reloads the SPA and loses
          // the live WebSocket, so postMessage first and let the app route.
          client.postMessage({ source: 'hermes-push-click', url });
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })(),
  );
});

/**
 * Browsers rotate push endpoints — after a long idle period, or when the push
 * service rekeys. Without this the app stays subscribed as far as the UI is
 * concerned while every send 410s.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const oldEndpoint = event.oldSubscription && event.oldSubscription.endpoint;

      const res = await fetch('/push/config');
      const { enabled, publicKey } = await res.json();
      if (!enabled || !publicKey) return;

      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyToBytes(publicKey),
      });

      await fetch('/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription }),
      });

      if (oldEndpoint && oldEndpoint !== subscription.endpoint) {
        await fetch('/push/unsubscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: oldEndpoint }),
        });
      }
    })(),
  );
});
