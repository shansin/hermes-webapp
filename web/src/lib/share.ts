/**
 * Copying and sharing text out of the transcript.
 *
 * Both modern APIs here — `navigator.clipboard` and `navigator.share` — are
 * gated on a secure context, and this app's default deployment is plain HTTP
 * on a LAN IP (see README). So neither can be the only path, or the buttons
 * would be dead on the setup most people actually run.
 *
 * Copy degrades to the deprecated `execCommand('copy')`, which still works on
 * insecure origins everywhere we care about — deprecated is not removed. Share
 * has no equivalent shim, so it degrades to copying instead: the text still
 * leaves the screen, which is what was being asked for. Only when both fail is
 * there nothing to report.
 */
import type { ChatMessage } from '../store/session';

/**
 * Copy through the legacy selection API.
 *
 * This is the insecure-origin path. It is fiddly on purpose: the textarea has
 * to be in the layout (`display:none` and `visibility:hidden` both make the
 * selection uncopyable) but invisible, and iOS Safari will only copy an
 * explicit Range, ignoring `select()` on a readonly field.
 */
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // `position: fixed` at the origin rather than a negative offset: an
  // off-screen field scrolls the page when it takes selection on iOS.
  ta.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;outline:none;box-shadow:none;background:transparent;opacity:0;';
  document.body.appendChild(ta);

  // Copying must not clobber whatever the user had selected themselves.
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  try {
    const range = document.createRange();
    range.selectNodeContents(ta);
    selection?.removeAllRanges();
    selection?.addRange(range);
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}

/** Put `text` on the clipboard by whatever route this context allows. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  // Undefined on insecure origins, and it can still reject on a secure one
  // when the document isn't focused — so a failure here falls through rather
  // than being reported.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Legacy path below.
    }
  }
  return legacyCopy(text);
}

/**
 * How the text was delivered. The caller words its toast from this — "shared"
 * and "copied" are different outcomes to someone holding a phone, and claiming
 * the wrong one sends them looking in the wrong place.
 */
export type ShareOutcome = 'shared' | 'copied' | 'failed';

export async function shareText(text: string, title?: string): Promise<ShareOutcome> {
  if (!text) return 'failed';

  if (navigator.share) {
    try {
      await navigator.share(title ? { title, text } : { text });
      return 'shared';
    } catch (err) {
      // Dismissing the sheet is a decision, not a failure — don't fall back to
      // copying something the user just declined to send anywhere.
      if (err instanceof DOMException && err.name === 'AbortError') return 'shared';
    }
  }

  return (await copyText(text)) ? 'copied' : 'failed';
}

/** Toast wording for an outcome, so every caller says the same thing. */
export function outcomeToast(o: ShareOutcome): { text: string; tone: 'success' | 'error' } {
  if (o === 'shared') return { text: 'Shared', tone: 'success' };
  if (o === 'copied') return { text: 'Copied to clipboard', tone: 'success' };
  return { text: 'Nothing could copy or share here', tone: 'error' };
}

/** The shareable text of a single message, or '' when it has none. */
export function messageText(m: ChatMessage): string {
  switch (m.kind) {
    case 'user':
      // The short invocation is what the user sees; sharing the expansion
      // would hand over a prompt they never wrote.
      return m.displayText ?? m.text;
    case 'assistant':
    case 'notice':
      return m.text;
    case 'tool':
      return `⚒ ${m.name}${m.context ? ` — ${m.context}` : ''}`;
    case 'subagent':
      return m.summary ? `${m.goal}\n\n${m.summary}` : m.goal;
  }
}

/**
 * Render a span of the live transcript as Markdown.
 *
 * The sibling of `toMarkdown` in `sessionExport.ts`, which does the same job
 * for the *stored* record. Two functions rather than one because the two
 * inputs genuinely differ: the store's messages carry tool results and
 * subagent cards that the stored projection drops.
 */
export function chatToMarkdown(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.kind === 'user') {
      lines.push('### You', '', m.displayText ?? m.text, '');
    } else if (m.kind === 'assistant') {
      lines.push('### Hermes', '');
      if (m.reasoning) {
        lines.push('> **Reasoning**', ...m.reasoning.split('\n').map((l) => `> ${l}`), '');
      }
      lines.push(m.text, '');
    } else if (m.kind === 'tool') {
      lines.push(`\`⚒ ${m.name}\`${m.context ? ` — ${m.context}` : ''}`, '');
    } else if (m.kind === 'subagent') {
      lines.push(`**Subagent:** ${m.goal}`, '');
      if (m.summary) lines.push(m.summary, '');
    } else if (m.kind === 'notice') {
      lines.push(`> ${m.text}`, '');
    }
  }
  return lines.join('\n').trim();
}
