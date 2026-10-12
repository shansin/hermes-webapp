/**
 * The kanban board's vocabulary: column order and labels, and the shapes the
 * plugin's routes answer with.
 *
 * Separate from `kanban.ts`, which is the hooks, because these are read by
 * code that has no business pulling in TanStack Query or the HTTP client —
 * pure derivations, tests, components that only render a card. `kanban.ts`
 * re-exports all of it, so existing imports are unchanged.
 */
/**
 * Column order as the kernel defines it, left to right on the board.
 *
 * `archived` is deliberately not here. It is a real ninth status and the board
 * endpoint returns it under `include_archived=true`, but it is an *end state*,
 * not a stage: putting it in the strip would offer "advance to archived" from
 * Review and give the swimlane layout a ninth lane that is empty on every
 * healthy board. It gets a toggle instead — see `ARCHIVED`.
 */
export const COLUMNS = [
  'triage',
  'todo',
  'scheduled',
  'ready',
  'running',
  'blocked',
  'review',
  'done',
] as const;

export type Column = (typeof COLUMNS)[number];

/** The ninth status, reachable only through the archive action and the toggle. */
export const ARCHIVED = 'archived';

export const COLUMN_LABEL: Record<Column, string> = {
  triage: 'Triage',
  todo: 'To do',
  scheduled: 'Scheduled',
  ready: 'Ready',
  running: 'Running',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
};

/** Every status label, including the one that is not a column. */
export const STATUS_LABEL: Record<string, string> = { ...COLUMN_LABEL, archived: 'Archived' };

/**
 * Reasoning depth a task can pin for its worker, independent of the model.
 * `none` turns thinking off; the rest are Hermes' own ladder.
 */
export const REASONING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/**
 * Where the worker runs. `scratch` is a throwaway directory; `worktree` cuts a
 * real git branch under the board's project; `dir` runs in a path you name.
 */
export const WORKSPACE_KINDS = ['scratch', 'worktree', 'dir'] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export interface Task {
  id: string;
  title: string;
  body: string | null;
  assignee: string | null;
  status: Column | string;
  priority: number;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  last_failure_error: string | null;
  consecutive_failures: number;
  current_run_id: number | null;
  /** Last sign of life from the worker. Stale + claimed is what "stuck" looks like. */
  last_heartbeat_at?: number | null;
  worker_pid?: number | null;
  session_id: string | null;
  block_kind: string | null;
  /**
   * How many times this card has been re-blocked for the same reason after an
   * unblock. Hermes deliberately does *not* reset it on unblock — only on a
   * successful completion — because resetting it is what let an unblock/
   * re-block loop run unbounded. At `BLOCK_RECURRENCE_LIMIT` the card is routed
   * to Triage instead of Blocked, so a rising number here is the warning that
   * answering the same way again will not work.
   */
  block_recurrences?: number;
  latest_summary: string | null;
  tenant?: string | null;
  /** Where the worker ran, for the log and the workspace hint. */
  workspace_kind?: WorkspaceKind | string | null;
  workspace_path?: string | null;
  branch_name?: string | null;
  project_id?: string | null;
  /** Per-task overrides for the spawned worker. Null means "use the profile's". */
  model_override?: string | null;
  provider_override?: string | null;
  reasoning_effort?: string | null;
  skills?: string[] | string | null;
  max_runtime_seconds?: number | null;
  max_retries?: number | null;
  goal_mode?: boolean;
  goal_max_turns?: number | null;
  comment_count?: number;
  link_counts?: { parents: number; children: number };
  /** Children done vs total, on a card that has children. Board rows only. */
  progress?: { done: number; total: number } | null;
  /**
   * Hermes' own rule engine, already computed and already on the board row.
   *
   * `kanban_diagnostics` is what the CLI's `doctor` prints: crash loops, spawn
   * failures, a card blocked for days, a worker referencing card ids that do
   * not exist. The board endpoint attaches the summary to every card and the
   * app was throwing it away — which meant the one thing on the board that
   * knows a card is in trouble was the only thing not shown.
   */
  warnings?: {
    count: number;
    /**
     * A map of kind → count (`{repeated_failures: 2}`), not the list of names
     * it reads like. Typed here as `string[]` it cost nothing at compile time
     * and threw `kinds.join is not a function` on the first card that carried
     * a warning — and with no error boundary above it that unmounted every
     * screen, so the board was blank rather than the badge. Both shapes are
     * accepted because the one thing this must not do is take the app down
     * again for a shape drift.
     */
    kinds: Record<string, number> | string[];
    latest_at: number | null;
    highest_severity: string;
  } | null;
  age?: { created_age_seconds: number | null };
}

export interface Board {
  columns: { name: Column | string; tasks: Task[] }[];
  assignees: string[];
  tenants: string[];
  latest_event_id: number;
  now: number;
}

/**
 * The warning badge's tooltip: `repeated_failures ×2, spawn_failure`.
 *
 * Hermes sends `kinds` as a kind → count map; an older plugin sent a plain
 * array of names. Both render, and anything else answers `''` — a missing
 * tooltip is invisible, a thrown render takes the board with it.
 */
export function warningKinds(
  kinds: Record<string, number> | string[] | null | undefined,
): string {
  if (Array.isArray(kinds)) return kinds.filter((k) => typeof k === 'string').join(', ');
  if (!kinds || typeof kinds !== 'object') return '';
  return Object.entries(kinds)
    .map(([kind, n]) => (typeof n === 'number' && n > 1 ? `${kind} ×${n}` : kind))
    .join(', ');
}

export interface TaskComment {
  id: number;
  task_id: string;
  author: string;
  body: string;
  created_at: number;
}

export interface TaskRun {
  id: number;
  task_id: string;
  status: string;
  outcome: string | null;
  summary: string | null;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  /**
   * The profile the worker actually ran as.
   *
   * Not the same thing as `task.assignee`, which is only where the card points
   * *now*: reassigning a card after a run, or a decomposer routing a child to a
   * specialist, leaves the two disagreeing. Every per-profile lookup about a
   * run — its session above all — has to use this one, because the session was
   * written to this profile's store and no other.
   */
  profile?: string | null;
  worker_pid?: number | null;
  /**
   * Free-form JSON the worker wrote when it finished. Sometimes carries
   * `worker_session_id`, which is the only *exact* join from a run to the
   * conversation it ran in — see `useTaskSession`.
   */
  metadata?: Record<string, unknown> | null;
}

/** The exact session id a run recorded, when it recorded one. */
export function runSessionId(run: TaskRun): string | null {
  const id = run.metadata?.worker_session_id;
  return typeof id === 'string' && id ? id : null;
}

export interface TaskEvent {
  id: number;
  task_id: string;
  kind: string;
  created_at: number;
  payload?: unknown;
  run_id?: number | null;
}

export interface TaskAttachment {
  id: number;
  task_id: string;
  filename: string;
  content_type: string | null;
  size: number;
  uploaded_by: string | null;
  created_at: number;
}

export interface TaskDetail {
  task: Task;
  comments: TaskComment[];
  runs: TaskRun[];
  events: TaskEvent[];
  /**
   * **Ids, not tasks.** The endpoint answers `{parents: ["t_ab12"], children:
   * [...]}` — bare strings. This was typed as `Task[]`, which nothing noticed
   * only because nothing rendered it; the moment a subtask list reads
   * `.title` off one of these it gets `undefined`, silently, on every row.
   */
  links: { parents: string[]; children: string[] };
  /** What the children finished with, so a parent can be read on its own. */
  child_results?: { id: string; title: string; status: string; latest_summary: string | null; result: string | null }[];
  attachments: TaskAttachment[];
}
