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

export const shareRouter = new Hono();

/**
 * Above this, the body is not read at all.
 *
 * A shared photo is megabytes, and parsing it here would buffer every one of
 * them on the event loop this process also relays the chat WebSocket on — only
 * to throw them away, since there is nowhere to put them. Text shares are
 * orders of magnitude below the limit.
 */
const SHARE_BODY_LIMIT = 256 * 1024;

/** The fields the manifest declares, and the chat screen reads back. */
const TEXT_FIELDS = ['title', 'text', 'url'] as const;

shareRouter.post('/share', async (c) => {
  const query = new URLSearchParams({ new: '1' });

  try {
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > SHARE_BODY_LIMIT) {
      query.set('share', '');
    } else {
      const form = await c.req.formData();
      for (const field of TEXT_FIELDS) {
        const value = form.get(field);
        if (typeof value === 'string' && value.trim()) query.set(field, value);
      }
      // A `File` entry rather than a string is the only signal that something
      // was attached, and that it is about to be lost.
      if (form.getAll('files').some((v) => typeof v !== 'string')) query.set('share', '');
    }
  } catch {
    // An unreadable body leaves nothing to carry across but the apology.
    query.set('share', '');
  }

  // 303, not 302: the redirect has to turn the POST into a GET.
  return c.redirect(`/chat?${query}`, 303);
});
