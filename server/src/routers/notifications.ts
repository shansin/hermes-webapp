/**
 * The cron notification feed, read by the "Cron Notifications" screen.
 *
 * Under `/push/*` for two reasons. Everything beneath `/api` is proxied
 * verbatim to Hermes, which knows nothing about this feed and would answer 404
 * — the same reason the subscription endpoints live there.
 *
 * And it must not be `/notifications`, which is the *SPA* route this data is
 * rendered on. The proxy matches its own routers before falling through to the
 * static handler, so a bare `/notifications` would serve this JSON to a
 * browser navigating to the screen — which is exactly what a push tap does
 * from a cold start (`clients.openWindow` in `push-sw.js`).
 */
import { Hono } from 'hono';

import { clearEntries, listEntries } from '../push/feed.js';
import { log } from '../log.js';

export const notificationsRouter = new Hono();

notificationsRouter.get('/push/feed', (c) => {
  const entries = listEntries();
  return c.json({ entries, total: entries.length });
});

notificationsRouter.delete('/push/feed', (c) => {
  const removed = clearEntries();
  log.info(`Cleared ${removed} cron notification(s).`);
  return c.json({ ok: true, removed });
});
