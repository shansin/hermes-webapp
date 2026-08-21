/**
 * Collecting what the Android share sheet sent us.
 *
 * `public/share-sw.js` receives the share as a POST, files it in Cache
 * Storage and redirects here with `?share=<id>`. This is the other end: ask
 * the worker for that id, get text and blobs back, and hand the screen real
 * `File` objects the composer can attach exactly as if they had come from the
 * paperclip.
 *
 * The claim goes through `postMessage` rather than reading the cache directly
 * so that the worker stays the only side that knows the storage layout, and so
 * the delete happens where the write did — a share must be consumed once, or a
 * reload re-attaches the same photo to a second turn.
 */

export interface SharedPayload {
  /** Title, selection and URL as the share sheet supplied them, newline-joined. */
  text: string;
  files: File[];
}

/**
 * How long to wait for the worker to answer.
 *
 * The realistic failure is not a slow reply but no reply at all: an update
 * swapped the worker between the POST and this call, or the page is somehow
 * running uncontrolled. Both leave the promise pending forever, and the screen
 * would sit on a share that is never coming.
 */
const CLAIM_TIMEOUT_MS = 5000;

interface ClaimReply {
  ok: boolean;
  text?: string;
  files?: { name: string; type: string; blob: Blob }[];
}

/**
 * Take the shared payload for `id`, or null if there isn't one.
 *
 * Null is an ordinary outcome, not an error: it is what a reload of an
 * already-consumed `?share=` looks like, and what the worker returns when the
 * POST failed and redirected with an empty id.
 */
export async function takeShared(id: string): Promise<SharedPayload | null> {
  if (!id) return null;

  const worker = navigator.serviceWorker?.controller;
  if (!worker) return null;

  const reply = await new Promise<ClaimReply | null>((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, CLAIM_TIMEOUT_MS);

    channel.port1.onmessage = (event: MessageEvent<ClaimReply>) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data ?? null);
    };

    worker.postMessage({ source: 'hermes-share-claim', id }, [channel.port2]);
  });

  if (!reply?.ok) return null;

  const files = (reply.files ?? []).map(
    (f) =>
      // Rebuilt as a File rather than passed on as a Blob: the composer keys
      // its attachment pills on `name`, and `image.attach_bytes` sends the
      // filename to the gateway, which puts it in the placeholder line the
      // agent sees.
      new File([f.blob], f.name || 'shared', { type: f.type || f.blob.type }),
  );

  const text = reply.text ?? '';
  return text || files.length ? { text, files } : null;
}
