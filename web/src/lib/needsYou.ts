/**
 * The Activity screen's "Needs you" and "Failed in the last 24h" rows.
 *
 * The lanes in `activity.ts` answer "what is running". These answer "what is
 * waiting on me", which is the question the pane is opened with more often:
 * an agent parked on an approval does nothing until someone answers it, and
 * nothing else in the app lists every one of them at once — across profiles,
 * because the live registry is process-wide.
 *
 * Split from `activity.ts` for the bundle, not for tidiness. That module is in
 * the boot graph (the drawer and the hamburger read its counts on every
 * screen), and Rollup places a module in one chunk whole — so everything
 * written there ships before first paint. Only the lazy Activity screen
 * imports this one. The two counts the badge needs stay in `activity.ts`.
 *
 * Pure, like `activity.ts`: payloads in, rows out.
 */
import type { SessionRow } from '../api/sessions';
import type { Task } from '../api/kanban';
import type { LiveSession, PendingPairing } from '../api/needsYou';
import type { NotificationEntry } from '../api/notifications';
import { isWaiting, seconds, text, type ActivityItem, type Attention } from './activity';

/** The chat link for a stored session, carrying its profile when known. */
function chatUrl(key: string, profile: string | undefined): string {
  return `/chat?session=${encodeURIComponent(key)}${profile ? `&profile=${encodeURIComponent(profile)}` : ''}`;
}

/**
 * Live sessions blocked on a person — an approval, a clarify, or plain input.
 *
 * `session.active_list` collapses all three into `waiting` and says nothing
 * about which; the sheet that answers it is mounted on every screen, so the
 * row only has to get you to the conversation.
 *
 * The live rows carry no profile — the registry is process-wide — so the
 * profile is borrowed from the session rows the pane already fetched across
 * profiles, matched on the stored id. Without it, tapping a row for another
 * agent opens an empty chat (see `fromSessions`). A row with no match keeps a
 * bare link, which is right on a single-profile install and the best
 * available guess on any other.
 */
export function fromWaiting(
  live: readonly LiveSession[] | undefined,
  rows: readonly SessionRow[] = [],
): ActivityItem[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const s of live ?? []) {
    if (!isWaiting(s)) continue;
    /* The stored id, never the live handle: `id` is an 8-hex gateway handle
       that means nothing to `/chat?session=`. Falling back to it only covers a
       session too new to have a stored row, which has nothing to open yet. */
    const key = text(s.session_key) ?? text(s.id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const row = byId.get(key);
    const owner = row ? (text(row.profile) ?? text(row.profile_name) ?? undefined) : undefined;
    out.push({
      // Same id `fromSessions` gives the row, which is what de-duplicates it.
      id: `session:${key}`,
      kind: 'session',
      state: 'attention',
      attention: 'waiting',
      title: text(s.title) ?? text(row?.title) ?? 'Untitled session',
      detail: 'Waiting for an approval or an answer',
      since: seconds(s.last_active) ?? seconds(row?.last_activity_at),
      url: chatUrl(key, owner),
      ...(owner ? { owner } : {}),
    });
  }
  return out;
}

/**
 * Kanban cards waiting on a person: Blocked and Review.
 *
 * Blocked is three different things on the wire and the row says which.
 * `needs_input` is the agent asking a question; a card with a failure count is
 * not a question at all — it ran out of retries, and the error is the useful
 * line (the same split `server/src/push/kanban.ts` makes); anything else is
 * blocked for the reason `block_kind` names.
 */
export function fromKanbanAttention(
  columns: readonly { name: string; tasks: Task[] }[] | undefined,
): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const column of columns ?? []) {
    const blocked = column.name === 'blocked';
    if (!blocked && column.name !== 'review') continue;
    for (const task of column.tasks ?? []) {
      const summary = text(task.latest_summary);
      const failures = typeof task.consecutive_failures === 'number' ? task.consecutive_failures : 0;
      const kind = text(task.block_kind);
      const detail = !blocked
        ? (summary ?? 'Ready for review')
        : failures > 0
          ? (text(task.last_failure_error) ??
            summary ??
            `Gave up after ${failures} failure${failures === 1 ? '' : 's'}`)
          : kind === 'needs_input'
            ? (summary ?? 'Asking you a question')
            : (summary ?? `Blocked${kind ? ` (${kind.replace(/_/g, ' ')})` : ''}`);
      out.push({
        id: `kanban:${task.id}`,
        kind: 'kanban',
        state: 'attention',
        attention: blocked ? 'blocked' : 'review',
        title: text(task.title) ?? task.id,
        detail,
        since: seconds(task.started_at) ?? seconds(task.created_at),
        url: `/kanban?task=${encodeURIComponent(task.id)}`,
        ...(task.assignee ? { owner: task.assignee } : {}),
        ...(blocked && failures > 0 ? { note: 'Gave up' } : {}),
      });
    }
  }
  return out;
}

function platformName(platform: string): string {
  return platform ? platform[0]!.toUpperCase() + platform.slice(1) : 'Messaging';
}

/**
 * Messaging users asking to pair. The approval lives on the Machine screen,
 * which owns the pairing controls; the row only says that someone is asking.
 */
export function fromPairing(pending: readonly PendingPairing[] | undefined, nowS: number): ActivityItem[] {
  const out: ActivityItem[] = [];
  const seen = new Set<string>();
  for (const p of pending ?? []) {
    const id = `pairing:${p.profile ?? ''}:${p.platform}:${p.requestId || p.user}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind: 'pairing',
      state: 'attention',
      attention: 'pairing',
      title: `${p.user} on ${platformName(p.platform)}`,
      detail: 'Wants to talk to the agent — approve or ignore it on Machine',
      since: p.ageMinutes == null ? null : nowS - p.ageMinutes * 60,
      url: '/machine#pairing',
      ...(p.profile ? { owner: p.profile } : {}),
    });
  }
  return out;
}

const ATTENTION_ORDER: Record<Attention, number> = { waiting: 0, blocked: 1, pairing: 2, review: 3 };

/**
 * One "Needs you" list. An agent parked mid-turn leads — it is holding a turn
 * open — then a blocked card, a person waiting to pair, and review last, which
 * is the one ask that blocks nothing. Newest first within each.
 */
export function mergeNeedsYou(...groups: ActivityItem[][]): ActivityItem[] {
  return groups.flat().sort((a, b) => {
    const byKind = ATTENTION_ORDER[a.attention ?? 'review'] - ATTENTION_ORDER[b.attention ?? 'review'];
    if (byKind !== 0) return byKind;
    return (b.since ?? 0) - (a.since ?? 0);
  });
}

/** How far back "Failed" looks. */
export const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isFailure(entry: Pick<NotificationEntry, 'failed' | 'severity'>): boolean {
  return entry.failed === true || entry.severity === 'error';
}

/** The first line of a markdown body, as plain enough text for one row. */
function firstLine(body: unknown): string | null {
  if (typeof body !== 'string') return null;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/^[\s#>*`-]+/, '').replace(/[*_`]/g, '').trim();
    if (line) return line.length > 160 ? `${line.slice(0, 159)}…` : line;
  }
  return null;
}

/**
 * Failures from the updates feed in the last day, one row per thing that
 * failed.
 *
 * The feed is the proxy's own record (`server/src/push/feed.ts`) and is
 * already polled app-wide for the unread badge, so this costs nothing. Rows
 * are grouped — by job for cron, otherwise by where the row leads — because a
 * job failing every five minutes is one problem, not 288 rows; the newest
 * failure speaks for the group and `count` says how many it stands for.
 *
 * `exclude` takes the links already in "Needs you": a card that gave up is
 * both a feed failure and a Blocked card, and it should be listed once, where
 * the action is.
 */
export function recentFailures(
  entries: readonly NotificationEntry[] | undefined,
  nowMs: number,
  exclude: ReadonlySet<string> = new Set(),
): ActivityItem[] {
  const groups = new Map<string, ActivityItem>();
  for (const e of entries ?? []) {
    if (!e || !isFailure(e)) continue;
    if (typeof e.at !== 'number' || e.at < nowMs - FAILED_WINDOW_MS) continue;
    const url = text(e.url) ?? '/notifications';
    if (exclude.has(url)) continue;
    const key = e.jobId ? `job:${e.jobId}` : `url:${url}`;
    const at = e.at / 1000;
    const prior = groups.get(key);
    if (prior) {
      prior.count = (prior.count ?? 1) + 1;
      if (at <= (prior.since ?? 0)) continue;
    }
    groups.set(key, {
      id: `update:${key}`,
      kind: 'update',
      state: 'failed',
      title: text(e.title) ?? text(e.jobName) ?? 'Something failed',
      detail: firstLine(e.body),
      since: at,
      url,
      count: prior?.count ?? 1,
    });
  }
  return [...groups.values()].sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
}
