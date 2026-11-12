/**
 * Find-in-chat over the *stored* conversation, for when the screen's copy
 * has nothing.
 *
 * The transcript on screen is the gateway's projection: compacted turns are
 * gone from it, and tool output never was in it. The stored transcript
 * (`fetchWholeTranscript`) has both the compacted turns and every reply, so
 * a miss on screen is worth a second look there. Searched here rather than
 * with the Sessions screen's FTS endpoint, which answers one row per session
 * lineage with a snippet and no message address — it can say a conversation
 * mentions something, not where.
 *
 * Each hit carries the prompt that opens its turn, because that is the only
 * address `/messages/around` accepts (an exact human prompt row); the viewer
 * loads the turn from there and scrolls to the hit.
 */
import type { StoredMessage } from '../api/sessions';

export interface StoredHit {
  rowId: number;
  role: string;
  snippet: string;
  /** Epoch ms. */
  at: number | null;
  /** The user row that opens this hit's turn, or null before the first prompt. */
  anchorRowId: number | null;
}

/** About this much context either side of a match. */
const RADIUS = 60;

export function snippetAt(text: string, at: number, length: number, radius = RADIUS): string {
  const flat = text.replace(/\s+/g, ' ');
  // Whitespace collapsing shifts offsets; re-find in the flattened text.
  const needle = text.slice(at, at + length).replace(/\s+/g, ' ').toLowerCase();
  const pos = Math.max(0, flat.toLowerCase().indexOf(needle));
  const start = Math.max(0, pos - radius);
  const end = Math.min(flat.length, pos + needle.length + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

export function searchStored(rows: readonly StoredMessage[], query: string, max = 50): StoredHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: StoredHit[] = [];
  let anchor: number | null = null;
  for (const r of rows) {
    const text = r.content ?? '';
    if (r.role === 'user' && text.trim()) anchor = r.id;
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) continue;
    hits.push({
      rowId: r.id,
      role: r.role,
      snippet: snippetAt(text, at, q.length),
      at: r.timestamp ? r.timestamp * 1000 : null,
      anchorRowId: anchor,
    });
    if (hits.length >= max) break;
  }
  return hits;
}

/**
 * The rows to show for a hit when `/messages/around` will not answer (the
 * anchor is a synthetic prompt, or sits in an earlier compression segment):
 * the same window cut from the rows already fetched.
 */
export function windowFromRows(
  rows: readonly StoredMessage[],
  hit: StoredHit,
  limit = 120,
): StoredMessage[] {
  const own = rows.findIndex((r) => r.id === hit.rowId);
  const from = hit.anchorRowId != null ? rows.findIndex((r) => r.id === hit.anchorRowId) : -1;
  let start = from >= 0 ? from : Math.max(0, own);
  // A turn longer than the window must not cut the hit itself off.
  if (own >= 0 && own - start >= limit) {
    start = Math.max(0, Math.min(own - Math.floor(limit / 2), rows.length - limit));
  }
  return rows.slice(start, start + limit);
}
