/**
 * Two shapes for the same reply: the whole thing for a feed card, one line for
 * a lock screen.
 *
 * These were one function, and the feed paid for it. A push body is capped at
 * 140 characters because that is all an OS will show, and the feed stored what
 * push had already thrown away — so a card could never display more than a
 * lock screen no matter how much room it had. `fullText` is what a row keeps;
 * `flatten` is what a banner gets, derived from the same reply at send time.
 *
 * `flatten` itself is shared for the reason it always was: it had been written
 * twice, as `previewOf` in `events.ts` for live gateway events and `flatten`
 * in `cron.ts` for a finished run, down to the same 140 characters. A reply
 * that reads cleanly as a banner from one path and badly from the other is a
 * bug nobody would think to look for.
 */

/** How much of a reply fits on a lock screen before the OS truncates anyway. */
export const PREVIEW_CHARS = 140;

/**
 * How much of one reply the feed will hold.
 *
 * Not a display limit — the card shows whatever is here. It bounds the JSON
 * file, which keeps 300 of these and is read and rewritten on every append.
 *
 * Sized against the real thing rather than guessed: the nightly trial digests
 * that prompted the whole change run 4300–4600 characters, so a 4000 cap cut
 * the exact content it was meant to preserve. This leaves room for one about
 * twice that long, and a full feed still lands around 2 MB.
 */
export const MAX_BODY_CHARS = 8000;

/**
 * The reply as written, kept for the feed card.
 *
 * Barely touched, deliberately: paragraph breaks are how a digest is readable
 * at all, and the card renders with `pre-wrap` so they survive. Runs of blank
 * lines collapse to one, because markdown written for a wide screen leaves
 * gaps that read as broken on a phone.
 */
export function fullText(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_BODY_CHARS
    ? `${trimmed.slice(0, MAX_BODY_CHARS - 1).trimEnd()}…`
    : trimmed;
}

/**
 * The first line or so, as banner text.
 *
 * Replies are markdown and a lock screen renders none of it, so a leading
 * heading or bullet marker is noise, fenced code collapses to a marker, and
 * the newlines that separate them become spaces. Enough to recognise the
 * answer, not to read it.
 */
export function flatten(text: string | null | undefined): string | null {
  if (!text) return null;

  const flat = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/^\s{0,3}[#>*-]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!flat) return null;
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : flat;
}
