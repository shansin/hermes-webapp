/**
 * The share target's landing pad, for the case where nothing catches it.
 *
 * The Android share sheet posts a multipart body at `/share`, and normally
 * `web/public/share-sw.js` answers it inside the service worker — the request
 * never reaches this process. It gets here when the worker is missing or was
 * being replaced at the moment of the share: rare, but the alternative is a
 * browser error page in front of someone who just picked this app out of a
 * share sheet.
 *
 * What survives the fallback is the text. A shared link or selection becomes
 * `/chat?new=1&title=…&text=…&url=…`, which the chat screen already knows how
 * to seed a draft from. Files cannot: attaching one needs a gateway session,
 * and the session belongs to the phone that is about to arrive at `/chat`.
 * When files were part of the share, `share=` is sent empty so the screen says
 * so rather than leaving someone to notice later that the photo went nowhere.
 *
 * It lives outside `/api` for the same reason the push routes do — that prefix
 * is forwarded verbatim to Hermes, which knows nothing about any of this.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

export const shareRouter = new Hono();

/**
 * Above this, the body is not read past the limit.
 *
 * A shared photo is megabytes, and parsing it here would buffer every one of
 * them on the event loop this process also relays the chat WebSocket on — only
 * to throw them away, since there is nowhere to put them. Text shares are
 * orders of magnitude below the limit.
 *
 * Enforced on the bytes, by `bodyLimit`, not on `content-length` alone: a
 * chunked upload declares no length, and a check of the header let it through
 * to `formData()` unbounded.
 */
const SHARE_BODY_LIMIT = 256 * 1024;

/** The fields the manifest declares, and the chat screen reads back. */
const TEXT_FIELDS = ['title', 'text', 'url'] as const;

/** 303, not 302: the redirect has to turn the POST into a GET. */
const toChat = (c: Context, query: URLSearchParams) => c.redirect(`/chat?${query}`, 303);

/** An oversized share keeps nothing but the apology. */
const tooLarge = (c: Context) => toChat(c, new URLSearchParams({ new: '1', share: '' }));

shareRouter.post('/share', bodyLimit({ maxSize: SHARE_BODY_LIMIT, onError: tooLarge }), async (c) => {
  const query = new URLSearchParams({ new: '1' });

  try {
    const form = await c.req.formData();
    for (const field of TEXT_FIELDS) {
      const value = form.get(field);
      if (typeof value === 'string' && value.trim()) query.set(field, value);
    }
    // A `File` entry rather than a string is the only signal that something
    // was attached, and that it is about to be lost.
    if (form.getAll('files').some((v) => typeof v !== 'string')) query.set('share', '');
  } catch {
    // An unreadable body leaves nothing to carry across but the apology.
    query.set('share', '');
  }

  return toChat(c, query);
});
