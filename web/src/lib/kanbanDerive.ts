/**
 * Pure derivations over kanban payloads: which run to read a card's session
 * hints off, and how a dispatcher tick reads as rows.
 *
 * No hooks and no requests — each takes a payload and returns what the
 * screen draws, which is what makes them testable on their own. `api/kanban.ts`
 * re-exports them, so existing imports are unchanged.
 */
import { runSessionId, type Task, type TaskRun } from '../api/kanbanTypes';

/**
 * The newest run's profile and stamped session id, in one pass.
 *
 * Newest *first* rather than newest-with-an-id: reading the profile off one run
 * and the session id off another would build a lookup for a session that never
 * ran there. If the newest run stamped nothing, the correlation covers it.
 */
export function latestRunHints(runs: TaskRun[] | undefined, task: Task | undefined) {
  const newest = (runs ?? []).reduce<TaskRun | null>(
    (best, r) => (best === null || r.started_at > best.started_at ? r : best),
    null,
  );
  return {
    profile: newest?.profile ?? task?.assignee ?? null,
    sessionHint: newest ? runSessionId(newest) : null,
  };
}

/**
 * What one dispatcher tick did, or would do.
 *
 * `dry_run` is the answer to "why is nothing starting": the buckets name every
 * card the tick skipped and why — `skipped_unassigned` above all, which is
 * silent in every other view Hermes offers.
 *
 * **The buckets are top-level keys, not a `skipped` object.** Observed on the
 * wire, a tick answers `{reclaimed, promoted, spawned, skipped_unassigned,
 * skipped_nonspawnable, skipped_per_profile_capped, skipped_locked, crashed,
 * auto_blocked, timed_out, stale, respawn_guarded, rate_limited, ...}` — a flat
 * `asdict` of the dispatcher's own result dataclass. Reading it as nested finds
 * nothing and renders an empty panel, which reads as "the dispatcher had
 * nothing to say" rather than as a bug. The index signature is deliberate: the
 * dataclass gains fields between Hermes versions and a renderer that only knew
 * today's list would silently drop tomorrow's.
 */
export interface DispatchResult {
  spawned?: { task_id?: string; profile?: string; pid?: number }[];
  [key: string]: unknown;
}

/**
 * The buckets worth showing, in the order they answer "why is nothing
 * happening" — most actionable first.
 *
 * A key not listed here still renders, with its underscores turned into
 * spaces; the list exists to name the ones whose raw form is misleading and to
 * fix the order of the ones that matter.
 */
export const DISPATCH_LABEL: Record<string, string> = {
  spawned: 'started',
  skipped_unassigned: 'skipped — nobody assigned',
  skipped_nonspawnable: 'skipped — not in a startable state',
  skipped_per_profile_capped: 'skipped — that agent is at its limit',
  respawn_guarded: 'held back after a recent failure',
  rate_limited: 'rate limited',
  crashed: 'crashed',
  timed_out: 'timed out',
  stale: 'stale claims',
  auto_blocked: 'auto-blocked',
  reclaimed: 'claims reclaimed',
  promoted: 'promoted to ready',
  reconciled_orphans: 'orphan runs closed',
  auto_assigned_default: 'assigned to the default agent',
};

/**
 * One readable row per non-empty bucket.
 *
 * The values are not one type: a bucket is a list of task ids on some keys, a
 * count on others, and `skipped_locked` is a **boolean** — another tick was
 * already running. Anything empty, zero or false is dropped, which is what
 * keeps a healthy tick to one line instead of fourteen zeroes.
 */
export function dispatchRows(result: DispatchResult): { key: string; label: string; detail: string }[] {
  const rows: { key: string; label: string; detail: string }[] = [];
  const order = Object.keys(DISPATCH_LABEL);
  const keys = [...order, ...Object.keys(result).filter((k) => !order.includes(k))];

  for (const key of keys) {
    if (!(key in result)) continue;
    const value = result[key];
    let detail: string | null = null;
    if (Array.isArray(value)) detail = value.length ? String(value.length) : null;
    else if (typeof value === 'number') detail = value ? String(value) : null;
    else if (typeof value === 'boolean') detail = value ? 'yes' : null;
    if (detail === null) continue;
    rows.push({ key, label: DISPATCH_LABEL[key] ?? key.replace(/_/g, ' '), detail });
  }
  return rows;
}
