/**
 * Turning a path the agent mentioned into somewhere you can tap.
 *
 * Agents talk in absolute paths. A research run ends with "wrote
 * `/home/shsin/meta-settlement.md`", a kanban worker names its artefact, a
 * coding turn cites the file it edited — and every one of those was dead text.
 * The file browser could already open any of them (`/files?path=…`, which
 * `workspace://` links have used since they existed); nothing connected the two,
 * so reading a report meant retyping its path into a drill-down.
 *
 * ## What counts as a path, and why the rule is narrow
 *
 * The danger is not missing a link, it is inventing one. A transcript is full
 * of slash-shaped strings that are not files — `/api/plugins/kanban/board`,
 * `/chat?resume=…`, `s/foo/bar/`, a regex, a URL path in prose — and turning
 * one into a tap that lands on "file not found" is worse than leaving it flat,
 * because it teaches you the feature is unreliable.
 *
 * So a bare path qualifies only when it sits under a **root that exists on a
 * real machine** (`/home`, `/Users`, `/tmp`, `/etc`, …), or under the session's
 * own working directory, or is written `~/…`. That covers every path this
 * install's agents actually emit and excludes every API route in the same
 * breath. An explicit `file://` or `workspace://` href needs no such test: the
 * scheme is the author saying what it is.
 *
 * ## Where it is applied, and where it deliberately is not
 *
 * Markdown links and *inline code* — which is where an agent puts a path when
 * it is not linking it. Bare paths in running prose are left alone on purpose:
 * catching those means rewriting every text node of every message, on the same
 * hot path that renders a token at a time during streaming, in exchange for the
 * one context where false positives are likeliest. Backticks are the signal
 * that something is a literal, and agents use them.
 */

/**
 * Directory roots that only exist on a filesystem.
 *
 * `/api`, `/chat`, `/files` and friends are conspicuously absent, which is the
 * point: they are the app's own routes and they appear in transcripts
 * constantly.
 */
const FS_ROOTS = [
  '/home/',
  '/Users/',
  '/root/',
  '/tmp/',
  '/var/',
  '/etc/',
  '/opt/',
  '/srv/',
  '/mnt/',
  '/media/',
  '/data/',
  '/workspace/',
  '/private/',
];

/** A path that is exactly a root, with nothing under it, is still a directory. */
const BARE_ROOTS = FS_ROOTS.map((r) => r.slice(0, -1));

function underKnownRoot(path: string): boolean {
  return FS_ROOTS.some((r) => path.startsWith(r)) || BARE_ROOTS.includes(path);
}

/** Strip a trailing `)`, `.`, `,` or quote the agent's sentence left attached. */
function trimTrailingPunctuation(path: string): string {
  return path.replace(/[).,;:'"`\]]+$/, '');
}

/**
 * Resolve something that might be a path into an absolute one, or null.
 *
 * `cwd` is the session's working directory, which makes a path under it
 * eligible even when its root is not one of the usual ones — an agent working
 * in `/srv/app` or a container's `/code` is the case that covers.
 */
export function resolveFilePath(raw: string | undefined, cwd?: string): string | null {
  if (!raw) return null;
  const text = trimTrailingPunctuation(raw.trim());
  if (!text) return null;

  // An explicit scheme is the author stating the kind; no heuristics needed.
  if (text.startsWith('file://')) {
    const path = decodeURI(text.slice('file://'.length)) || '/';
    return path.startsWith('/') ? path : null;
  }
  if (text.startsWith('workspace://')) {
    const rel = text.slice('workspace://'.length).replace(/^\/+/, '');
    if (!rel || !cwd) return null;
    return `${cwd.replace(/\/+$/, '')}/${rel}`;
  }

  // Anything else carrying a scheme or a query is a URL, not a file.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  if (/[?#]/.test(text)) return null;
  // Whitespace is the reliable sign that this is prose rather than one path.
  // A real path containing a space exists, but a heuristic cannot tell it from
  // a sentence, and guessing wrong here is the failure mode being avoided.
  if (/\s/.test(text)) return null;

  if (text.startsWith('~/') || text === '~') {
    // The backend expands `~` itself, so it can travel as written.
    return text;
  }

  if (!text.startsWith('/')) return null;
  if (underKnownRoot(text)) return text;

  // Under the session's own working directory, whatever that happens to be.
  const root = cwd?.replace(/\/+$/, '');
  if (root && (text === root || text.startsWith(`${root}/`))) return text;

  return null;
}

/** The route that opens a path in the file browser, viewer and all. */
export function filesHref(path: string): string {
  return `/files?path=${encodeURIComponent(path)}`;
}

/**
 * Whether a run of inline code should become a link.
 *
 * Separate from `resolveFilePath` because the bar is higher here: a link's href
 * was written as a link, whereas inline code is used for every literal an agent
 * ever mentions — flags, identifiers, snippets — and only some of them are
 * paths. A single line is required for the same reason.
 */
export function inlineCodePath(text: string, cwd?: string): string | null {
  if (text.includes('\n')) return null;
  if (text.length > 512) return null;
  return resolveFilePath(text, cwd);
}
