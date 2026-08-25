/**
 * Splitting a half-written markdown document into the part that is finished
 * and the part still being typed.
 *
 * The streaming bubble re-parses its whole accumulated text through the
 * unified pipeline — remark-gfm, rehype-highlight and all — on every throttled
 * tick. That cost is a function of the message length, and it is paid ten
 * times a second for as long as the turn runs, so a long reply gets steadily
 * more expensive to watch arrive: the last paragraph of a 4,000-word answer
 * costs 4,000 words of parsing to render.
 *
 * Nearly all of that work is redundant. Markdown above the last blank line is
 * finished — no later token can change how it renders — so it can be parsed
 * once and left alone, and only the block currently being written needs
 * re-parsing per tick. That is what this finds: the boundary between the two.
 *
 * The whole difficulty is that a blank line is not always a boundary.
 *
 *  - A blank line inside a fenced code block is just a blank line, and
 *    splitting there produces two unterminated fences out of one good one.
 *  - A blank line between the items of a loose list still belongs to the list.
 *    Split there and the list becomes two lists — which for an ordered list
 *    means the second half visibly restarts at 1.
 *  - The same goes for a blockquote or a table continuing across a blank line,
 *    and for anything indented, which is a continuation of whatever is above
 *    it.
 *
 * So the rule is conservative in the one direction that is safe: a boundary
 * has to be a blank line outside any fence, followed by a line that plainly
 * begins a fresh top-level block. Anything it is unsure about is left in the
 * open part, where it is re-parsed every tick exactly as it was before — the
 * failure mode of being too careful is the old performance, and the failure
 * mode of being too clever is a mangled transcript.
 *
 * One known limitation, left alone deliberately: a link reference definition
 * (`[ref]: https://…`) in the finished part is not visible to a `[ref]` in the
 * open part, because the two are parsed as separate documents. The link
 * renders as literal text until the turn completes and the whole message is
 * parsed as one — which it is, by the transcript, a moment later.
 */

/** An opening or closing code fence, allowing the three spaces CommonMark does. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A line that continues whatever came before it rather than starting fresh.
 *
 * Leading whitespace, a list marker, a blockquote marker or a table row. Each
 * of these can legally sit across a blank line from the block it belongs to,
 * so none of them is safe to cut in front of.
 */
const CONTINUATION = /^(\s|[-*+] |\d+[.)] |>|\|)/;

export interface StableSplit {
  /** Complete blocks. Parse once; this string only ever grows at a boundary. */
  stable: string;
  /** The block still being written. Re-parsed on every tick. */
  open: string;
}

export function splitStableMarkdown(text: string): StableSplit {
  const lines = text.split('\n');

  let fence: string | null = null;
  let afterBlank = false;
  /** First line of the open part, or -1 while no boundary has been seen. */
  let boundary = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = FENCE.exec(line)?.[1];

    if (fence !== null) {
      // Only a fence of the same character and at least the same length
      // closes one — ``` does not close ~~~~, and ``` does not close ````.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      afterBlank = false;
      continue;
    }

    if (marker) {
      // A fence opening straight after a blank line is a boundary in its own
      // right, and a common one: prose, blank line, code block.
      if (afterBlank && i > 0) boundary = i;
      fence = marker;
      afterBlank = false;
      continue;
    }

    if (line.trim() === '') {
      afterBlank = true;
      continue;
    }

    if (afterBlank) {
      afterBlank = false;
      if (i > 0 && !CONTINUATION.test(line)) boundary = i;
    }
  }

  // No boundary found: one block so far, or one long unterminated fence.
  // Either way the whole thing is still open. (A boundary is never recorded
  // from inside a fence, so an unterminated one always keeps everything from
  // its opening line onwards in the open part.)
  if (boundary <= 0) return { stable: '', open: text };

  return {
    stable: lines.slice(0, boundary).join('\n'),
    open: lines.slice(boundary).join('\n'),
  };
}
