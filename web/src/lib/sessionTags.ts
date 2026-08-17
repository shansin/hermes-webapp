/**
 * Session tags, parsed out of the title.
 *
 * There's no tag field on the wire — `SessionRename` carries a title and two
 * flags, nothing more — so a `#tag` written into the title *is* the storage.
 * That's the same convention hermes-webui uses, and it means tags survive being
 * set from the CLI, from Discord, or by the agent naming its own session.
 */

export interface TaggedTitle {
  /** The title with its tags removed, for display. */
  text: string;
  tags: string[];
}

/**
 * `#` followed by a word character, so a `#1` issue reference or a `#` inside a
 * URL fragment doesn't become a tag. Tags are compared lower-case but shown as
 * written.
 */
const TAG_RE = /(^|\s)#([a-zA-Z][\w-]*)/g;

export function parseTags(title: string | null): TaggedTitle {
  if (!title) return { text: '', tags: [] };
  const tags: string[] = [];
  const text = title
    .replace(TAG_RE, (_m, lead: string, tag: string) => {
      tags.push(tag);
      return lead;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  // A title that is *only* tags would otherwise render as an empty row.
  return { text: text || (title.trim() || ''), tags };
}

/** Every distinct tag across a set of titles, de-duplicated case-insensitively. */
export function collectTags(titles: (string | null)[]): string[] {
  const seen = new Map<string, string>();
  for (const t of titles) {
    for (const tag of parseTags(t).tags) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) seen.set(key, tag);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export function hasTag(title: string | null, tag: string): boolean {
  const want = tag.toLowerCase();
  return parseTags(title).tags.some((t) => t.toLowerCase() === want);
}

/**
 * A stable colour per tag, so the same tag looks the same everywhere without
 * storing a palette. Hue only — saturation and lightness come from the theme.
 */
export function tagHue(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % 360;
  return h;
}
