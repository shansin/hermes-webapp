/**
 * The updates feed, read by the "Updates" screen.
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

import { clearEntries, lastReadAt, listEntries, markRead, unreadCount } from '../push/feed.js';
import { log } from '../log.js';

export const notificationsRouter = new Hono();

notificationsRouter.get('/push/feed', (c) => {
  const entries = listEntries();
  return c.json({
    entries,
    total: entries.length,
    // The badge is driven from here rather than counted in the browser: the
    // watermark is the proxy's state, so a phone that has never opened the
    // screen still gets the right number on its first load.
    unread: unreadCount(),
    lastReadAt: lastReadAt(),
  });
});

/**
 * Opening the screen is what marks it read; the screen calls this on mount.
 *
 * A POST rather than folding it into the GET, because the GET is also what the
 * 60s background poll and the socket-driven invalidation use — marking read
 * there would clear the badge for a screen nobody has looked at.
 */
notificationsRouter.post('/push/feed/read', (c) => {
  markRead();
  return c.json({ ok: true, unread: unreadCount() });
});

notificationsRouter.delete('/push/feed', (c) => {
  const removed = clearEntries();
  log.info(`Cleared ${removed} update(s).`);
  return c.json({ ok: true, removed });
});
