/**
 * Where a fork cuts the conversation: the `count` that `session.branch` takes.
 *
 * Hermes' `session.branch {count}` keeps "the first N rows of the source
 * history" (`tui_gateway/methods_session_branch.py` `_branch_live`), where the
 * history is the session's *display* projection — compacted turns included —
 * filtered to user/assistant rows with visible text. So N is not an index into
 * the transcript on screen: tool rows are not counted, and a session that has
 * been compacted holds turns the live transcript no longer shows. A count
 * taken off the screen would cut a compacted session in the wrong place.
 *
 * The desktop app resolves this the same way (`selectBranchMessages`): read
 * the stored transcript (oldest first, compacted rows included), find the
 * tapped message in it — by durable row id when the message has one, else by
 * role + text — and count. The text match counts identical messages from the
 * *end*, not the start (where the desktop app counts from): compaction takes
 * turns off the front of the live transcript, so the screen is a suffix of the
 * stored copy and an identical earlier reply hidden by compaction would
 * otherwise be picked instead. The local transcript is the fallback when the
 * stored one cannot be read.
 *
 * Two more backend facts shape the edges. `count: 0` is not "nothing": the
 * branch only slices when `count > 0`, so 0 copies the *whole* history — a
 * fork before the first message therefore cannot be expressed and is refused
 * here. And the branch answers with the rows it copied, which is how
 * `forkLanded` checks after the fact that the cut fell where it was meant to.
 */

export type ForkMode =
  /** Keep everything up to and including the message (an assistant reply). */
  | 'through'
  /** Keep everything before it — "edit in a fork" replaces the message itself. */
  | 'before';

export interface ForkTarget {
  role: 'user' | 'assistant';
  text: string;
  /** The stored row id, when the message came from history that carried one. */
  rowId?: number;
  /** 1-based: how many forkable messages with this role and text follow it, itself included. */
  fromEnd: number;
}

/** A stored transcript row, as `/api/sessions/{id}/messages` returns it. */
export interface StoredForkRow {
  id?: number;
  role: string;
  content: string | null;
}

/** A transcript row as `session.history` / `session.branch` project it. */
export interface HistoryForkRow {
  role: string;
  text?: string;
}

/** A local transcript entry, reduced to what matters here. */
export interface LocalForkRow {
  id: string;
  kind: string;
  text?: string;
  rowId?: number;
}

/**
 * Text as compared across the projections. Image refs are lifted out of a
 * user message differently by each, and whitespace is not significant.
 */
export function forkText(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/^@image:[^\n]*\n?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const isTurnRole = (role: string): role is 'user' | 'assistant' => role === 'user' || role === 'assistant';

/** The local entries that count toward `count`, in order. */
function localForkable(messages: readonly LocalForkRow[]): LocalForkRow[] {
  return messages.filter((m) => isTurnRole(m.kind) && forkText(m.text) !== '');
}

/** Describe a local message as something findable in another projection. */
export function forkTarget(messages: readonly LocalForkRow[], messageId: string): ForkTarget | null {
  const rows = localForkable(messages);
  const idx = rows.findIndex((m) => m.id === messageId);
  const target = rows[idx];
  if (!target || !isTurnRole(target.kind)) return null;
  const text = forkText(target.text);
  const fromEnd = rows
    .slice(idx)
    .filter((m) => m.kind === target.kind && forkText(m.text) === text).length;
  return { role: target.kind, text, rowId: target.rowId, fromEnd };
}

function countFor(idx: number, mode: ForkMode): number | null {
  if (idx < 0) return null;
  const count = mode === 'through' ? idx + 1 : idx;
  // 0 would copy the whole history; see the header.
  return count > 0 ? count : null;
}

/** `count` off the stored transcript, or null when the message cannot be found in it. */
export function forkCountFromStored(
  rows: readonly StoredForkRow[],
  target: ForkTarget,
  mode: ForkMode,
): number | null {
  const forkable = rows.filter((r) => isTurnRole(r.role) && forkText(r.content) !== '');
  let idx = target.rowId != null ? forkable.findIndex((r) => r.id === target.rowId) : -1;
  if (idx < 0) {
    let seen = 0;
    for (let i = forkable.length - 1; i >= 0; i--) {
      const r = forkable[i]!;
      if (r.role === target.role && forkText(r.content) === target.text && ++seen === target.fromEnd) {
        idx = i;
        break;
      }
    }
  }
  return countFor(idx, mode);
}

/** `count` off the transcript on screen — right whenever nothing has been compacted. */
export function forkCountFromLocal(
  messages: readonly LocalForkRow[],
  messageId: string,
  mode: ForkMode,
): number | null {
  return countFor(
    localForkable(messages).findIndex((m) => m.id === messageId),
    mode,
  );
}

/**
 * Whether the branch ended where it was meant to: its last copied row should
 * be the target (`through`) or the forkable message just before it (`before`).
 * Unknown (true) when there is nothing to compare against.
 */
export function forkLanded(
  copied: readonly HistoryForkRow[] | undefined,
  messages: readonly LocalForkRow[],
  messageId: string,
  mode: ForkMode,
): boolean {
  const rows = localForkable(messages);
  const idx = rows.findIndex((m) => m.id === messageId);
  const expected = rows[mode === 'through' ? idx : idx - 1];
  const last = (copied ?? []).filter((r) => isTurnRole(r.role) && forkText(r.text) !== '').at(-1);
  if (!expected || !last) return true;
  return last.role === expected.kind && forkText(last.text) === forkText(expected.text);
}
