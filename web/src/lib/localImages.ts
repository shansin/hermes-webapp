/**
 * Images that live on the agent's disk, not on the web.
 *
 * Both directions of an image in a transcript point at a filesystem path, and
 * neither can be handed to an `<img>` as-is:
 *
 *  - **Received.** The agent writes markdown — `![shot](file:///home/…/x.png)`
 *    after a screen capture, sometimes a bare absolute path. A page served
 *    over http cannot read `file://` (the browser blocks it silently, so the
 *    picture is simply missing), and react-markdown strips the scheme before
 *    it ever reaches the DOM.
 *  - **Sent.** Hermes persists an attached image as an `@image:<path>`
 *    directive line appended to the user's own message — the same form its
 *    desktop client parses. Left alone it renders as a stray line of path.
 *
 * So both are turned into a path and fetched through `/api/fs/read-data-url`,
 * which is authenticated and already the way the file viewer shows a PNG.
 *
 * The quoting rules mirror Hermes' `format_reference_value`: a value holding
 * whitespace or brackets is wrapped in the first of `` ` ``, `"`, `'` it does
 * not itself contain, because the unquoted alternative in its own pattern is
 * `\S+` and a path with a space would otherwise parse as a truncated ref.
 */

/** Extensions `/api/fs/read-data-url` is worth calling for. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

/**
 * The absolute path an image source refers to, or null if it isn't one.
 *
 * Accepts `file://` URLs, bare absolute paths, `workspace://` (the agent's own
 * scheme for a file it touched) and paths relative to the session's working
 * directory. Anything with a real scheme — `http:`, `https:`, `data:` — is
 * left alone, which is what returning null means to the caller.
 */
export function localImagePath(src: string | undefined, cwd?: string): string | null {
  if (!src) return null;

  if (src.startsWith('file://')) {
    const rest = src.slice('file://'.length).replace(/^localhost/, '');
    return decodePath(rest.startsWith('/') ? rest : `/${rest}`);
  }

  if (src.startsWith('workspace://')) {
    const rel = src.slice('workspace://'.length).replace(/^\/+/, '');
    if (!rel || !cwd) return null;
    return `${cwd.replace(/\/+$/, '')}/${decodePath(rel)}`;
  }

  // A scheme we don't handle (http, https, data, blob) is not ours to resolve.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;

  if (src.startsWith('/')) return decodePath(src);
  if (src.startsWith('~/')) return null; // No home directory to expand against.

  // A relative path only means something with a working directory to hang it
  // on, and only when it looks like an image — otherwise every ordinary
  // relative link would start a file read.
  if (!cwd || !IMAGE_EXT.test(src)) return null;
  return `${cwd.replace(/\/+$/, '')}/${decodePath(src)}`;
}

/** `%20` and friends, tolerating a path that was never encoded. */
function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A quoted-or-bare `@image:` value, matching Hermes' REFERENCE_PATTERN. */
const IMAGE_REF = /(?<![\w/])@image:(?:`([^`]+)`|"([^"]+)"|'([^']+)'|(\S+))/g;

export interface AttachedImages {
  /** The message with its `@image:` lines removed. */
  text: string;
  /** Absolute paths, in the order they appeared, deduplicated. */
  images: string[];
}

/**
 * Lift the `@image:` refs out of a user message.
 *
 * The refs trail the caption on their own lines (Hermes puts them there so a
 * session preview isn't a truncated file path), but they are matched anywhere
 * in the text and by line, because that placement is the client's to ignore.
 */
export function splitAttachedImages(text: string): AttachedImages {
  if (!text.includes('@image:')) return { text, images: [] };

  const images: string[] = [];
  const kept: string[] = [];

  for (const line of text.split('\n')) {
    let found = false;
    const rest = line.replace(IMAGE_REF, (_m, backtick, dquote, squote, bare) => {
      const path = backtick ?? dquote ?? squote ?? bare;
      found = true;
      if (path && !images.includes(path)) images.push(path);
      return '';
    });
    // A line that was nothing but refs goes with them; a caption that happened
    // to carry one inline keeps its words.
    if (found && rest.trim() === '') continue;
    kept.push(found ? rest.trimEnd() : line);
  }

  return { text: kept.join('\n').trim(), images };
}

/** Quote a path so `splitAttachedImages` — and Hermes — read it back whole. */
export function formatImageRef(path: string): string {
  if (!/[\s()[\]{}<>"'`]/.test(path)) return `@image:${path}`;
  for (const quote of ['`', '"', "'"]) {
    if (!path.includes(quote)) return `@image:${quote}${path}${quote}`;
  }
  return `@image:${path}`;
}

/** The trailing name of a path, for alt text and the can't-load fallback. */
export function imageName(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}
