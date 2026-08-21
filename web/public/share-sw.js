/**
 * Share-target handler, imported into the Workbox-generated service worker.
 *
 * A share target that accepts *files* has to be `method: "POST"`, and a POST
 * navigation is something a single-page app cannot receive: the browser posts
 * a multipart body at `/share` and expects a document back. There is no
 * JavaScript running on our origin at that moment to intercept it — except
 * here. So the worker takes the POST, puts the parts somewhere the page can
 * reach, and answers with a redirect to an ordinary GET the app already knows
 * how to route.
 *
 * Lives beside `push-sw.js` for the same reason that file does: the build uses
 * `generateSW`, so the worker is produced entirely from config and
 * `workbox.importScripts` is the only seam to add a listener through.
 *
 * Ordering matters and is why this is safe. Scripts imported this way run at
 * the top of the generated worker, so this `fetch` listener is registered
 * before any of Workbox's routing. It calls `respondWith` only for a POST to
 * `/share` and returns untouched for everything else, which leaves every
 * cached GET exactly as it was.
 */

/* global self, caches, Response */

/** Where the shared parts wait between the POST and the page that reads them. */
const SHARE_CACHE = 'hermes-share-inbox';

/**
 * Synthetic URLs, because Cache Storage is keyed by request. Nothing ever
 * fetches these — they are a filing system that happens to store `Response`s,
 * which is the point: a Blob goes in and comes out as a Blob, with no base64
 * round trip through a worker that has no reason to touch the bytes.
 */
const manifestUrl = (id) => `/__share__/${id}/manifest`;
const partUrl = (id, index) => `/__share__/${id}/part/${index}`;

/**
 * How long an unclaimed share may sit in the cache.
 *
 * The page deletes what it consumes, so this only catches the shares that
 * never got claimed — the redirect landed, and the person hit back, or killed
 * the app before a session existed to attach to. Without a sweep those bytes
 * are permanent, and a shared photo is measured in megabytes.
 */
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share') return;
  event.respondWith(receiveShare(event.request));
});

async function receiveShare(request) {
  let id = String(Date.now());
  try {
    const form = await request.formData();

    // `getAll` on every field: Android sends multiple files under one name,
    // and the text fields are absent rather than empty when nothing was typed.
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && 'name' in f);
    const text = ['title', 'text', 'url']
      .map((k) => form.get(k))
      .filter((v) => typeof v === 'string' && v.trim())
      .join('\n');

    const cache = await caches.open(SHARE_CACHE);
    await sweep(cache);

    const parts = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // The name is carried in the manifest rather than inferred from the URL:
      // a shared photo often arrives as `image.jpg` or with no name at all, and
      // whatever it is has to survive into the `image.attach_bytes` call.
      parts.push({ index: i, name: file.name || `shared-${i}`, type: file.type || '' });
      await cache.put(
        partUrl(id, i),
        new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream' } }),
      );
    }

    await cache.put(
      manifestUrl(id),
      new Response(JSON.stringify({ id, at: Date.now(), text, parts }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  } catch {
    // Anything here — a body that never arrived, a cache the browser evicted
    // mid-write — means there is nothing to hand the app. Redirect anyway with
    // no id: a new chat with an apology beats a browser error page, which is
    // what an unhandled rejection in `respondWith` would produce.
    id = '';
  }

  /**
   * 303, not 302: the redirect must turn the POST into a GET. And a redirect
   * rather than rendering the app here, because the app has to arrive at a
   * real URL — one a reload, a back gesture, or an "add to home screen" launch
   * can all make sense of.
   *
   * Resolved against the request rather than left relative. A worker would
   * resolve it against its own location and land in the same place, but only
   * because the worker is served from the root — an assumption with no reason
   * to hold, and one nothing would report if it stopped.
   */
  const target = new URL(`/chat?new=1&share=${encodeURIComponent(id)}`, request.url);
  return Response.redirect(target.toString(), 303);
}

/** Drop shares nobody came back for. Best effort; never blocks the redirect. */
async function sweep(cache) {
  try {
    const keys = await cache.keys();
    const now = Date.now();
    for (const key of keys) {
      if (!key.url.includes('/manifest')) continue;
      const res = await cache.match(key);
      const body = res ? await res.json() : null;
      if (body && now - (body.at || 0) < SHARE_TTL_MS) continue;
      const stale = new URL(key.url).pathname.split('/')[2];
      await forget(cache, stale);
    }
  } catch {
    // A failed sweep costs disk, not correctness.
  }
}

async function forget(cache, id) {
  const keys = await cache.keys();
  await Promise.all(
    keys.filter((k) => new URL(k.url).pathname.startsWith(`/__share__/${id}/`)).map((k) => cache.delete(k)),
  );
}

/**
 * The page asks for its share through `postMessage` rather than reaching into
 * the cache itself, so the worker stays the only thing that knows the layout —
 * and so the delete happens on the same side as the write.
 */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.source !== 'hermes-share-claim') return;
  event.waitUntil(
    (async () => {
      const port = event.ports && event.ports[0];
      try {
        const cache = await caches.open(SHARE_CACHE);
        const res = await cache.match(manifestUrl(data.id));
        if (!res) {
          if (port) port.postMessage({ ok: false });
          return;
        }
        const body = await res.json();
        const files = [];
        for (const part of body.parts || []) {
          const partRes = await cache.match(partUrl(data.id, part.index));
          if (!partRes) continue;
          files.push({ name: part.name, type: part.type, blob: await partRes.blob() });
        }
        if (port) port.postMessage({ ok: true, text: body.text || '', files });
        // Claimed exactly once: a reload of `?share=<id>` must not re-attach
        // the same photo to a second turn.
        await forget(cache, data.id);
      } catch {
        if (port) port.postMessage({ ok: false });
      }
    })(),
  );
});
