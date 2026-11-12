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

import { clearEntries, feedVersion, lastReadAt, listEntries, markRead, unreadCount } from '../push/feed.js';
import { log } from '../log.js';

export const notificationsRouter = new Hono();

/**
 * Whether an `If-None-Match` names `tag`, by the weak comparison RFC 9110
 * prescribes for it. Weak because the tag does not survive the trip unchanged:
 * `compress()` in index.ts prefixes `W/` when it gzips the body, and so does
 * Cloudflare when it re-encodes one, and the browser hands back whichever it
 * was given.
 */
function matches(inm: string | undefined, tag: string): boolean {
  if (!inm) return false;
  if (inm.trim() === '*') return true;
  const opaque = tag.replace(/^W\//, '');
  return inm.split(',').some((t) => t.trim().replace(/^W\//, '') === opaque);
}

/**
 * Conditional, so the poll is nearly free.
 *
 * Every open tab refetches this every 60s for the badge (`useUnreadCount`),
 * and the whole feed is a few hundred KB. It changes a handful of times a day.
 * `no-cache` is what makes the saving automatic: the browser keeps the body
 * and revalidates it on every fetch, sending `If-None-Match` itself and handing
 * the cached 200 back to the page on a 304 — so the client code is a plain
 * `fetch` and knows none of this. `no-store` would forbid exactly that.
 */
notificationsRouter.get('/push/feed', (c) => {
  // Read before the body is built, and the body from the same tick: nothing
  // can mutate the feed in between on a single-threaded loop.
  const etag = `"${feedVersion()}"`;
  c.header('ETag', etag);
  c.header('Cache-Control', 'no-cache');
  if (matches(c.req.header('if-none-match'), etag)) return c.body(null, 304);

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
