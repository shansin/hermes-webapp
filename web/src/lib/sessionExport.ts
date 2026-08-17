/**
 * Getting a transcript off the phone.
 *
 * Two formats: a Markdown transcript for reading and pasting, and the backend's
 * full JSON record (`GET /api/sessions/{id}/export`) for archiving — that one
 * carries the system prompt and model config, not just the messages.
 *
 * Delivery prefers the native share sheet, which is what you actually want on a
 * phone: the file goes to Notes, Files, a chat, whatever. But `navigator.share`
 * with files requires a secure context, and this app's default is plain HTTP on
 * a LAN IP — so it falls back to a blob download, which works either way.
 */
import { exportSessionJson, fetchStoredMessages, type StoredMessage } from '../api/sessions';

/** A filename stem safe on every platform we might share into. */
function slug(title: string | null, id: string): string {
  const base = (title || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${base || 'session'}-${id.slice(0, 15)}`;
}

function stamp(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return '';
  return new Date(epochSeconds * 1000).toLocaleString();
}

/**
 * Render stored messages as Markdown.
 *
 * Tool rows keep only their name: the stored record holds the call, not the
 * result, so anything more would be inventing detail the transcript doesn't
 * have. Reasoning is included as a blockquote — it's the part most worth
 * keeping when you export a session to read later.
 */
export function toMarkdown(
  messages: StoredMessage[],
  meta: { title: string | null; id: string; model: string | null; started_at: number },
): string {
  const lines: string[] = [`# ${meta.title || 'Untitled session'}`, ''];
  const started = stamp(meta.started_at);
  if (started) lines.push(`*${started}*  `);
  if (meta.model) lines.push(`*Model: ${meta.model}*  `);
  lines.push(`*Session \`${meta.id}\`*`, '', '---', '');

  for (const m of messages) {
    if (m.role === 'user') {
      lines.push(`### You`, '', m.content ?? '', '');
    } else if (m.role === 'assistant') {
      lines.push(`### Hermes`, '');
      if (m.reasoning) {
        lines.push(`> **Reasoning**`, ...m.reasoning.split('\n').map((l) => `> ${l}`), '');
      }
      lines.push(m.content ?? '', '');
    } else if (m.role === 'tool') {
      lines.push(`\`⚒ ${m.tool_name ?? 'tool'}\``, '');
    }
  }
  return lines.join('\n');
}

/**
 * Hand a file to the user by whatever route this context allows.
 *
 * Returns how it was delivered so the caller can word its toast honestly —
 * "shared" and "downloaded" are different outcomes to someone holding a phone.
 */
async function deliver(
  filename: string,
  body: string,
  mime: string,
  title: string,
): Promise<'shared' | 'downloaded'> {
  const file = new File([body], filename, { type: mime });

  // `canShare` is the only reliable probe: Safari exposes `share` but rejects
  // files, and the whole API is absent outside a secure context.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (err) {
      // The user dismissing the sheet is not a failure worth reporting, but
      // any other error should fall through to the download path.
      if (err instanceof DOMException && err.name === 'AbortError') return 'shared';
    }
  }

  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download on some mobile browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'downloaded';
}

export async function shareSessionMarkdown(meta: {
  id: string;
  title: string | null;
  model: string | null;
  started_at: number;
}): Promise<'shared' | 'downloaded'> {
  const messages = await fetchStoredMessages(meta.id);
  const body = toMarkdown(messages, meta);
  return deliver(`${slug(meta.title, meta.id)}.md`, body, 'text/markdown', meta.title || 'Session');
}

export async function shareSessionJson(meta: {
  id: string;
  title: string | null;
}): Promise<'shared' | 'downloaded'> {
  const record = await exportSessionJson(meta.id);
  const body = JSON.stringify(record, null, 2);
  return deliver(
    `${slug(meta.title, meta.id)}.json`,
    body,
    'application/json',
    meta.title || 'Session',
  );
}
