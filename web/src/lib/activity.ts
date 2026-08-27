/**
 * What Hermes is doing right now, gathered from the three places it says so.
 *
 * The case this exists for: a chat session calls `delegate_task`, and the only
 * sign of it anywhere in the app is a subagent card inside that one
 * conversation — `store/session.ts` discards every event whose `session_id` is
 * not the session on screen. Open another chat and the work is invisible while
 * it is still running.
 *
 * Hermes knows. `/api/sessions` rows carry `is_active` and a
 * `last_activity_description` that reads, verbatim off the wire,
 * "delegate_task: subagent running execute_code (iteration 5/250)". That
 * string is the whole feature; the app simply never declared the fields.
 *
 * Built on REST rather than on the gateway socket, deliberately. A socket-fed
 * view only ever contains work that started while someone was watching, which
 * is precisely wrong for the thing you go and check *because* you were not
 * watching. The socket is still used, but only to invalidate these queries
 * early — see `useActivity`.
 *
 * Sessions lead here for that reason, and because they are the one source that
 * survives the socket being down. They are no longer the only window onto a
 * delegation, though — that note used to say there wasn't one. `_active_subagents`
 * in `tools/delegate_tool.py` *is* reachable, over the gateway's
 * `delegation.status`, and it is the only thing that can see a **background**
 * delegation: those children get no session rows and emit no `subagent.*`
 * events, so three researchers running in parallel showed up here as the one
 * parent session that dispatched them. See `api/delegation.ts`.
 */
import type { ActiveSubagent } from '../api/delegation';
import { isRunning } from '../api/delegation';
import type { SessionRow } from '../api/sessions';
import type { Task } from '../api/kanban';
import type { CronJob } from '../api/hub';
import { humanCron } from './cronText';

export type ActivityKind = 'session' | 'kanban' | 'cron' | 'subagent';
export type ActivityState = 'running' | 'queued' | 'stalled';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  state: ActivityState;
  title: string;
  /** The live progress line, where the source has one. */
  detail: string | null;
  /** Epoch **seconds**, matching `relTime`. Null when the source has no clock. */
  since: number | null;
  /** Where tapping the row goes. */
  url: string;
  /** Set on a `stalled` row: why we doubt it. */
  note?: string;
  /**
   * Which agent this belongs to — a profile name for a session or a cron job,
   * the assignee for a kanban card.
   *
   * The pane merges three sources that each span every profile, so without
   * this a row saying "running" cannot tell you whether it is the research
   * agent or the one you are talking to. Undefined where the source does not
   * say, and rendered only when there is more than one profile to tell apart.
   */
  owner?: string;
  /**
   * `since` is when this started, not when it last moved.
   *
   * Every other source carries a last-activity clock, so a row that has not
   * moved for a while can be marked quiet. The delegation registry keeps only
   * `started_at` — so treating it the same way would print "no update in 6m"
   * over a child that is running a tool right now, which is worse than saying
   * nothing. Rows with this flag say how long they have been going and are
   * never marked quiet.
   */
  sinceIsStart?: boolean;
}

/**
 * When a session's progress line stops counting as current.
 *
 * Hermes decides `is_active` itself, as `ended_at is None and (now -
 * last_active) < 300`, so a dead session drops off on its own after five
 * minutes and this does not re-implement that. What it does is admit the gap:
 * inside those five minutes a crashed session still reads as active, so a row
 * that has not moved for a while is shown with its age rather than presented
 * as freshly working. The row stays listed either way — Hermes says it is
 * active, and quietly disagreeing would be its own kind of lie.
 */
export const QUIET_AFTER_S = 90;

function seconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Some Hermes timestamps are milliseconds; anything past the year ~2286 in
    // seconds is really milliseconds.
    return value > 1e11 ? value / 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed / 1000;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** How long a row has been quiet, in seconds, or null if it has no clock. */
export function quietFor(item: ActivityItem, nowS: number): number | null {
  return item.since == null ? null : Math.max(0, nowS - item.since);
}

export function isQuiet(item: ActivityItem, nowS: number): boolean {
  // A start time is not a heartbeat: see `sinceIsStart`.
  if (item.sinceIsStart) return false;
  const quiet = quietFor(item, nowS);
  return quiet != null && quiet > QUIET_AFTER_S;
}

/**
 * Sessions with a turn in flight.
 *
 * `is_active` is Hermes' own flag; `ended_at` is belt and braces for a row
 * that carries both, which should not happen and would mean the session is
 * over.
 */
export function fromSessions(sessions: readonly SessionRow[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const s of sessions) {
    if (!s.is_active || s.ended_at) continue;
    const owner = text(s.profile) ?? text(s.profile_name) ?? undefined;
    out.push({
      id: `session:${s.id}`,
      kind: 'session',
      state: 'running',
      title: text(s.title) ?? 'Untitled session',
      detail: text(s.last_activity_description),
      since: seconds(s.last_activity_at) ?? seconds(s.started_at),
      /* The profile rides in the link. Sessions live in per-profile stores and
         a resume that does not name one looks the id up in the active profile
         and finds nothing — so a row for another agent's work would open an
         empty chat. */
      url: `/chat?session=${encodeURIComponent(s.id)}${owner ? `&profile=${encodeURIComponent(owner)}` : ''}`,
      ...(owner ? { owner } : {}),
    });
  }
  return out;
}

/**
 * Delegated children, from the registry the gateway keeps in memory.
 *
 * These sit alongside the parent's own session row rather than replacing it,
 * because they are not the same agent: a session dispatching three researchers
 * is four things working, and collapsing them to one row is the bug this lane
 * exists to fix. `owner_agent_session_id` names the parent, which is where the
 * row leads and where the controls for it live.
 *
 * `last_tool` is the whole value of the row — "web_extract · 5 tools" is the
 * difference between three agents working and three agents wedged — so a child
 * that has not called one yet says so rather than showing an empty line.
 */
export function fromDelegations(active: readonly ActiveSubagent[] | undefined): ActivityItem[] {
  const out: ActivityItem[] = [];

  for (const child of active ?? []) {
    if (!isRunning(child)) continue;
    const owner = text(child.owner_agent_session_id);

    const tools = child.tool_count ?? 0;
    const detail = [
      text(child.last_tool) ?? 'starting up',
      tools > 0 ? `${tools} tool${tools === 1 ? '' : 's'}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    out.push({
      id: `subagent:${child.subagent_id}`,
      kind: 'subagent',
      state: 'running',
      title: text(child.goal) ?? 'Delegated agent',
      detail,
      since: seconds(child.started_at),
      sinceIsStart: true,
      /* The parent conversation, which is where the controls are. A child has
         no screen of its own — it is not a session. */
      url: owner ? `/chat?session=${encodeURIComponent(owner)}` : '/activity',
    });
  }
  return out;
}

/**
 * A kanban worker whose claim has lapsed.
 *
 * Unlike a session, a running task has real liveness fields, and a crashed
 * worker leaves the row sitting in `running` looking busy until the dispatcher
 * reclaims it. Saying so is the difference between "still working" and "died
 * twenty minutes ago".
 */
function kanbanStalled(task: Task, nowS: number): boolean {
  const expires = seconds((task as { claim_expires?: unknown }).claim_expires);
  return expires != null && expires < nowS;
}

export function fromKanban(
  columns: readonly { name: string; tasks: Task[] }[] | undefined,
  nowS: number,
): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const column of columns ?? []) {
    const queued = column.name === 'ready' || column.name === 'scheduled';
    if (column.name !== 'running' && !queued) continue;

    for (const task of column.tasks) {
      const stalled = column.name === 'running' && kanbanStalled(task, nowS);
      out.push({
        id: `kanban:${task.id}`,
        kind: 'kanban',
        state: stalled ? 'stalled' : queued ? 'queued' : 'running',
        title: text(task.title) ?? task.id,
        detail: text(task.latest_summary) ?? (queued ? 'Waiting for a worker' : null),
        since: seconds(task.started_at) ?? seconds(task.created_at),
        url: `/kanban?task=${encodeURIComponent(task.id)}`,
        ...(task.assignee ? { owner: task.assignee } : {}),
        ...(stalled ? { note: 'Worker claim expired' } : {}),
      });
    }
  }
  return out;
}

/**
 * `latest_execution.status` values that mean the job is done with this fire.
 *
 * Read as an allow-list of endings rather than a list of running states: an
 * unfamiliar status counts as in flight, which shows a row that should not be
 * there rather than hiding one that should.
 */
const CRON_FINISHED = ['completed', 'complete', 'failed', 'error', 'cancelled', 'canceled', 'skipped'];

function cronRunning(job: CronJob): boolean {
  const execution = (job as { latest_execution?: unknown }).latest_execution;
  if (!execution || typeof execution !== 'object') return false;
  const status = text((execution as { status?: unknown }).status);
  if (!status) return false;
  return !CRON_FINISHED.includes(status.toLowerCase());
}

/**
 * Cron: the job mid-fire, plus what is due next.
 *
 * The scheduler's live set is not exposed over REST — `_running_job_ids` stays
 * inside the gateway — so `latest_execution.status` is the signal available
 * from the job list. `GET /api/cron/jobs/{id}/runs` would be authoritative but
 * costs a request per job, which is not worth it for a pane that refreshes.
 *
 * `queuedLimit` keeps four daily jobs from out-numbering the live work: this
 * is a list of what is happening, with a glance at what is next.
 */
export function fromCron(jobs: readonly CronJob[] | undefined, queuedLimit = 3): ActivityItem[] {
  const running: ActivityItem[] = [];
  const queued: ActivityItem[] = [];

  for (const job of jobs ?? []) {
    if (job.paused || job.enabled === false) continue;
    const title = text(job.name) ?? job.id;
    // Hermes stamps every job with the store it was read from, and the list
    // endpoint merges every profile by default — so this is populated whenever
    // more than one profile owns jobs.
    const owner = text(job.profile) ?? text(job.profile_name) ?? undefined;
    const base = {
      kind: 'cron' as const,
      title,
      url: `/cron?job=${encodeURIComponent(job.id)}`,
      ...(owner ? { owner } : {}),
    };

    if (cronRunning(job)) {
      running.push({
        ...base,
        id: `cron:${job.id}`,
        state: 'running',
        detail: 'Running now',
        since: seconds(job.last_run_at),
      });
      continue;
    }

    const next = seconds(job.next_run_at);
    if (next != null) {
      queued.push({
        ...base,
        id: `cron:${job.id}`,
        state: 'queued',
        /* `schedule_display` is the cron expression echoed back, not a
           rendered string — see `humanCron`, which falls back to the raw
           expression rather than guessing at a shape it does not know. */
        detail: humanCron(text(job.schedule_display)) ?? text(job.schedule_display) ?? 'Scheduled',
        since: next,
      });
    }
  }

  // Soonest first, then capped — the ones you would actually want to know about.
  queued.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
  return [...running, ...queued.slice(0, queuedLimit)];
}

const STATE_ORDER: Record<ActivityState, number> = { running: 0, stalled: 1, queued: 2 };

/**
 * One list: live work first, then anything doubtful, then what is coming.
 *
 * Within running, most recently active leads — that is the one you are
 * probably here about. Within queued, soonest leads, which for a future
 * timestamp is the opposite sort.
 */
export function mergeActivity(...groups: ActivityItem[][]): ActivityItem[] {
  return groups.flat().sort((a, b) => {
    const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (byState !== 0) return byState;
    if (a.state === 'queued') return (a.since ?? Infinity) - (b.since ?? Infinity);
    return (b.since ?? 0) - (a.since ?? 0);
  });
}

export function countRunning(items: readonly ActivityItem[]): number {
  return items.reduce((n, i) => (i.state === 'running' ? n + 1 : n), 0);
}
