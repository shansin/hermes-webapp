/**
 * Kanban board.
 *
 * Hermes ships a complete kanban REST API as a dashboard plugin, so we drive
 * that rather than touching `kanban.db` directly: the kernel owns claim locks,
 * run bookkeeping and status routing, and writing SQL underneath it would race
 * the dispatcher.
 *
 * **Every route takes `?board=`, and an omitted one is the server's *current*
 * board — not "the only one".** `POST /boards/<slug>/switch` moves a
 * process-wide pointer, so a second client (the desktop app, a CLI) switching
 * boards silently redirects every unqualified call this app makes: the board
 * on screen would keep its title while the card you dragged landed in another
 * store. The selector is therefore threaded explicitly, the same way `?profile=`
 * is on sessions, and `kanbanUrl` is the single place it is applied. Query keys
 * carry it too, or two boards would share one cache entry.
 *
 * The board is a **hook argument**, not a mutation variable: it is a property
 * of the screen, constant for the life of a render, and putting it in every
 * `mutate()` call was thirty chances to forget it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { sessionUrl, type SessionRow } from './sessions';

const BASE = '/api/plugins/kanban';

/**
 * Address a board. An absent slug means the server's current board, which is
 * the right request for the single-board install almost everyone has.
 */
export function kanbanUrl(path: string, board?: string | null): string {
  const full = `${BASE}${path}`;
  if (!board) return full;
  return `${full}${full.includes('?') ? '&' : '?'}board=${encodeURIComponent(board)}`;
}

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

export const kanbanKeys = {
  /** Everything under one board, for a blanket invalidate after a switch. */
  scope: (board?: string | null) => ['kanban', board ?? null] as const,
  board: (board?: string | null, tenant?: string | null, archived?: boolean) =>
    ['kanban', board ?? null, 'board', tenant ?? null, Boolean(archived)] as const,
  task: (id: string, board?: string | null) => ['kanban', board ?? null, 'task', id] as const,
  boards: ['kanban', 'boards'] as const,
};

export interface BoardQuery {
  board?: string | null;
  /** Multi-tenant isolation. Absent on almost every install. */
  tenant?: string | null;
  includeArchived?: boolean;
  enabled?: boolean;
  /**
   * Whether the plugin's event socket is currently carrying changes.
   *
   * The poll slows down when it is, and only when it is. It is never turned
   * off: the socket is unavailable on an older proxy, an older plugin, or a
   * network that will not carry an upgrade, and in each case it fails in a way
   * indistinguishable from the others — so the poll stays as the thing that
   * cannot silently stop working. See `lib/useKanbanEvents.ts`.
   */
  live?: boolean;
}

/** How often to poll with, and without, the event socket behind it. */
const BOARD_POLL_MS = 10_000;
const BOARD_POLL_LIVE_MS = 60_000;

export function useBoard({
  board,
  tenant,
  includeArchived,
  enabled = true,
  live = false,
}: BoardQuery = {}) {
  const query = new URLSearchParams();
  if (tenant) query.set('tenant', tenant);
  if (includeArchived) query.set('include_archived', 'true');
  const suffix = query.toString();
  return useQuery({
    queryKey: kanbanKeys.board(board, tenant, includeArchived),
    queryFn: () => api.get<Board>(kanbanUrl(`/board${suffix ? `?${suffix}` : ''}`, board)),
    // The agent moves cards on its own, so poll while the board is on screen.
    refetchInterval: live ? BOARD_POLL_LIVE_MS : BOARD_POLL_MS,
    enabled,
    retry: 1,
  });
}

export function useTask(id: string | null, board?: string | null) {
  return useQuery({
    queryKey: kanbanKeys.task(id ?? '', board),
    queryFn: () => api.get<TaskDetail>(kanbanUrl(`/tasks/${encodeURIComponent(id!)}`, board)),
    enabled: Boolean(id),
  });
}

/**
 * Invalidate every board query regardless of tenant or archived flag.
 *
 * The board key carries both, so a mutation that invalidated one exact key
 * would leave the "including archived" view stale next to the one it just
 * refreshed. Matching on the prefix costs nothing and cannot drift.
 */
function boardKeyPrefix(board?: string | null) {
  return ['kanban', board ?? null, 'board'] as const;
}

export interface CreateTaskBody {
  title: string;
  body?: string;
  priority?: number;
  assignee?: string;
  triage?: boolean;
  tenant?: string;
  parents?: string[];
  /**
   * Guards a double-tap on a flaky connection. Hermes returns the *existing*
   * task for a key it has already seen rather than creating a second card, so
   * a retry that the browser fired without telling us is free.
   */
  idempotency_key?: string;
  workspace_kind?: WorkspaceKind;
  workspace_path?: string;
  project_id?: string;
  /**
   * Create-only, all five of them: `UpdateTaskBody` accepts none of these, so
   * a card that did not pin them here cannot be given them later from the API.
   */
  skills?: string[];
  goal_mode?: boolean;
  goal_max_turns?: number;
  max_runtime_seconds?: number;
  model_override?: string;
  provider_override?: string;
  reasoning_effort?: string;
}

export function useCreateTask(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTaskBody) =>
      /**
       * `warning` is not an error. Hermes attaches it when the card landed in
       * `ready` with an assignee and no dispatcher is running — the card is
       * created and correct, and nothing will ever pick it up. Callers surface
       * it; ignoring it is how a board fills up with cards that never start.
       */
      api.post<{ task: Task; warning?: string }>(kanbanUrl('/tasks', board), body),
    onSuccess: () => qc.invalidateQueries({ queryKey: boardKeyPrefix(board) }),
  });
}

/**
 * The subset of a task the PATCH route accepts.
 *
 * Note what is absent and cannot be added: `skills`, `goal_mode`,
 * `goal_max_turns`, `max_runtime_seconds`, `workspace_kind`, `project_id`.
 * Those are fixed at creation. The two `clear_*` booleans exist because `null`
 * in a partial body means "unchanged" — there is no other way to say "go back
 * to the profile's own setting".
 */
export type TaskPatch = Partial<
  Pick<Task, 'title' | 'body' | 'status' | 'priority' | 'assignee'>
> & {
  block_reason?: string;
  result?: string;
  summary?: string;
  model_override?: string;
  provider_override?: string;
  clear_model_override?: boolean;
  reasoning_effort?: string;
  clear_reasoning_effort?: boolean;
};

export function useUpdateTask(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & TaskPatch) =>
      api.patch<{ task: Task }>(kanbanUrl(`/tasks/${encodeURIComponent(id)}`, board), patch),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: boardKeyPrefix(board) });
      qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.id, board) });
    },
  });
}

export function useDeleteTask(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(kanbanUrl(`/tasks/${encodeURIComponent(id)}`, board)),
    onSuccess: () => qc.invalidateQueries({ queryKey: boardKeyPrefix(board) }),
  });
}

/**
 * Move, assign, reprioritise or archive many cards at once.
 *
 * Per-id results, not a single ok: Hermes applies each id independently and a
 * refusal on one — a card already claimed, a transition the kernel will not
 * make — does not abort its siblings. A caller that reads only the HTTP status
 * reports "12 moved" for a call where nine moved, which is exactly the kind of
 * quiet miscount a bulk action must not produce.
 */
export interface BulkResult {
  results: { id: string; ok: boolean; error?: string }[];
}

export function useBulkTasks(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      ids: string[];
      status?: string;
      assignee?: string | null;
      priority?: number;
      archive?: boolean;
      /** Release a live claim before reassigning, rather than 409ing on it. */
      reclaim_first?: boolean;
    }) => api.post<BulkResult>(kanbanUrl('/tasks/bulk', board), body),
    onSuccess: () => qc.invalidateQueries({ queryKey: boardKeyPrefix(board) }),
  });
}

export function useAddComment(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body, author = 'web' }: { id: string; body: string; author?: string }) =>
      api.post(kanbanUrl(`/tasks/${encodeURIComponent(id)}/comments`, board), { body, author }),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.id, board) }),
  });
}

/**
 * Answer a blocked card and let it run again.
 *
 * A blocked card is the agent asking a question and stopping — `block_kind`
 * `needs_input` is literally that — and the board had no way to answer it. The
 * status chips could move the card, but moving it is not replying: the worker
 * starts the next run from the card, and unless the answer is *on* the card
 * the run repeats the question. (Hermes builds the worker prompt from title +
 * body + parent results + **comments**, which is why the note has to be a
 * comment and why it has to be posted before the status changes.)
 *
 * So this is the CLI's `kanban unblock --note` in one call, in that order:
 * comment first, then the transition. If the comment fails the card stays
 * blocked, which is the safe way round — an unblocked card with no answer on
 * it just burns a run rediscovering the same blocker.
 *
 * The transition is `ready`, not `todo`. Only `ready` routes through Hermes'
 * `unblock_task`, which closes a dangling run, re-gates on the parents and
 * lands the card in the phase it was blocked *from* (which may well be `todo`
 * or `review` — the response says which, so callers should report the status
 * that comes back rather than the one they asked for). A direct write to
 * `todo` skips all of it and leaves the run pointer dangling.
 */
export function useUnblockTask(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, note, author = 'web' }: { id: string; note?: string; author?: string }) => {
      const text = note?.trim();
      if (text) {
        await api.post(kanbanUrl(`/tasks/${encodeURIComponent(id)}/comments`, board), {
          body: text,
          author,
        });
      }
      return api.patch<{ task: Task }>(kanbanUrl(`/tasks/${encodeURIComponent(id)}`, board), {
        status: 'ready',
      });
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: boardKeyPrefix(board) });
      qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.id, board) });
    },
  });
}

/**
 * How long to give the auxiliary-model calls below.
 *
 * They run the model to completion *inside the HTTP request* — there is no job
 * id to poll — and the model in question is whatever `auxiliary.*` points at,
 * which on this machine is a local one. Minutes is normal; the proxy allows
 * fifteen. Four is long enough not to cut off a slow local model and short
 * enough that a wedged one reports rather than hangs the sheet.
 */
const AUX_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * Outcome shared by specify and decompose.
 *
 * `ok: false` is **not** an HTTP error — a missing auxiliary model answers 200
 * with a reason, deliberately, so the operator is told what to configure
 * instead of getting a bare toast. Callers must check `ok`.
 */
export interface AuxOutcome {
  ok: boolean;
  task_id: string;
  reason: string | null;
  new_title: string | null;
  fanout?: boolean;
  child_ids?: string[];
}

/** Flesh a one-line triage card out into a real spec and promote it to To do. */
export function useSpecifyTask(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<AuxOutcome>(
        kanbanUrl(`/tasks/${encodeURIComponent(id)}/specify`, board),
        { author: 'web' },
        { signal: AbortSignal.timeout(AUX_TIMEOUT_MS) },
      ),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: boardKeyPrefix(board) });
      qc.invalidateQueries({ queryKey: kanbanKeys.task(id, board) });
    },
  });
}

/** Fan a triage card out into child tasks, routed to specialist profiles. */
export function useDecomposeTask(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<AuxOutcome>(
        kanbanUrl(`/tasks/${encodeURIComponent(id)}/decompose`, board),
        { author: 'web' },
        { signal: AbortSignal.timeout(AUX_TIMEOUT_MS) },
      ),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: boardKeyPrefix(board) });
      qc.invalidateQueries({ queryKey: kanbanKeys.task(id, board) });
    },
  });
}

/**
 * A rough read on a card before you commit to it: token cost and S/M/L.
 *
 * Two routes, one shape. The bare one takes a title and body and needs no
 * task, which is what makes it usable from the *create* sheet — the point of
 * an estimate is to see it before the card exists. Like specify and decompose
 * it answers `ok: false` with a reason rather than an HTTP error.
 */
export interface Estimate {
  ok: boolean;
  est_tokens?: number;
  complexity?: 'S' | 'M' | 'L' | null;
  rationale?: string | null;
  model?: string | null;
  reason?: string;
}

export function useEstimate() {
  return useMutation({
    mutationFn: (body: { title: string; body?: string }) =>
      api.post<Estimate>(`${BASE}/estimate`, body, {
        signal: AbortSignal.timeout(AUX_TIMEOUT_MS),
      }),
  });
}

export function useEstimateTask(board?: string | null) {
  return useMutation({
    mutationFn: (id: string) =>
      api.post<Estimate>(kanbanUrl(`/tasks/${encodeURIComponent(id)}/estimate`, board), undefined, {
        signal: AbortSignal.timeout(AUX_TIMEOUT_MS),
      }),
  });
}

/**
 * Release a claim on a card whose worker is gone.
 *
 * The shape of a stuck board: a card in Running with a `current_run_id` and a
 * heartbeat that stopped. The dispatcher will not touch it until the claim TTL
 * expires, and until then nothing on the board explains why nothing is
 * happening. This is `hermes kanban reclaim`, and it 409s rather than lying
 * when the card is not actually claimed.
 */
export function useReclaimTask(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<{ ok: boolean; task_id: string }>(
        kanbanUrl(`/tasks/${encodeURIComponent(id)}/reclaim`, board),
        { reason: reason ?? 'Reclaimed from Hem' },
      ),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: boardKeyPrefix(board) });
      qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.id, board) });
    },
  });
}

/**
 * Reassign, releasing a live claim on the way if asked.
 *
 * Not the same as `PATCH {assignee}`, which is what the sheet used and which
 * **409s on a card a worker currently holds** — the one moment you most want
 * to move it, because it is running as the wrong agent. This route takes
 * `reclaim_first` and does both halves in the right order server-side.
 */
export function useReassignTask(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      profile,
      reclaimFirst = false,
      reason,
    }: {
      id: string;
      /** Empty or null unassigns. */
      profile: string | null;
      reclaimFirst?: boolean;
      reason?: string;
    }) =>
      api.post<{ ok: boolean; task_id: string; assignee: string | null }>(
        kanbanUrl(`/tasks/${encodeURIComponent(id)}/reassign`, board),
        { profile, reclaim_first: reclaimFirst, reason },
      ),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: boardKeyPrefix(board) });
      qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.id, board) });
    },
  });
}

/** Live process stats for a running worker: CPU, memory, threads, cmdline. */
export interface RunInspect {
  run_id: number;
  alive: boolean;
  pid?: number;
  reason?: string;
  error?: string;
  cpu_percent?: number | null;
  memory_rss_bytes?: number | null;
  num_threads?: number | null;
  num_fds?: number | null;
  status?: string | null;
  create_time?: number | null;
  cmdline?: string[] | null;
}

export function useRunInspect(runId: number | null, board?: string | null, enabled = true) {
  return useQuery({
    queryKey: ['kanban', board ?? null, 'run-inspect', runId],
    enabled: runId !== null && enabled,
    // A live process is worth watching; the endpoint is a single psutil read.
    refetchInterval: (q) => (q.state.data?.alive ? 5_000 : false),
    retry: false,
    queryFn: () => api.get<RunInspect>(kanbanUrl(`/runs/${runId}/inspect`, board)),
  });
}

/**
 * Kill a run's worker process.
 *
 * Harder than reclaim, and the difference matters: reclaim releases the *claim*
 * and leaves whatever the process is doing alone, which is right for a worker
 * that has already died. This signals the process. 409s when the run has
 * already ended.
 */
export function useTerminateRun(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, reason }: { runId: number; taskId?: string; reason?: string }) =>
      api.post<{ ok: boolean; run_id: number; task_id: string }>(
        kanbanUrl(`/runs/${runId}/terminate`, board),
        { reason: reason ?? 'Terminated from Hem' },
      ),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: boardKeyPrefix(board) });
      if (vars.taskId) qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.taskId, board) });
    },
  });
}

/**
 * The worker's stdout, the one record of a run that always exists.
 *
 * Every other view of a run depends on something the worker chose to write —
 * a summary, a session that got a title, metadata carrying a session id. The
 * log depends on the worker having been *spawned*, which is the weakest
 * precondition available, so it is what the sheet falls back to when the
 * conversation cannot be found. Tailed, because Hermes rotates the file at
 * 2 MiB and a phone should not be asked to render that.
 */
export function useTaskLog(id: string | null, enabled: boolean, board?: string | null, tail = 64_000) {
  return useQuery({
    queryKey: ['kanban', board ?? null, 'task-log', id, tail],
    enabled: Boolean(id) && enabled,
    staleTime: 5_000,
    retry: false,
    queryFn: () =>
      api.get<{
        task_id: string;
        path: string;
        exists: boolean;
        size_bytes: number;
        content: string;
        truncated: boolean;
      }>(kanbanUrl(`/tasks/${encodeURIComponent(id!)}/log?tail=${tail}`, board)),
  });
}

/**
 * Files on a card.
 *
 * Not decoration: `build_worker_context` surfaces each attachment's absolute
 * stored path to the worker, so a file put here is a file the agent can open.
 * That is the difference between describing a screenshot and handing one over,
 * and it is the only route by which a phone can give an agent a file that is
 * not a chat message.
 *
 * The download link is a plain same-origin URL rather than a fetch: the
 * endpoint answers with a `FileResponse`, the proxy adds the Bearer token, and
 * Cloudflare Access is satisfied by the cookie the browser already holds — so
 * the browser's own downloader handles it, including for a 25 MB video that
 * has no business being read into a phone's memory first.
 */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export function attachmentUrl(id: number, board?: string | null): string {
  return kanbanUrl(`/attachments/${id}`, board);
}

export function useTaskAttachments(taskId: string | null, board?: string | null) {
  return useQuery({
    queryKey: ['kanban', board ?? null, 'attachments', taskId],
    enabled: Boolean(taskId),
    staleTime: 15_000,
    retry: false,
    queryFn: () =>
      api.get<{ attachments: TaskAttachment[] }>(
        kanbanUrl(`/tasks/${encodeURIComponent(taskId!)}/attachments`, board),
      ),
  });
}

export function useUploadAttachment(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => {
      const form = new FormData();
      form.append('file', file);
      /* The endpoint defaults this to `dashboard`. Naming the app instead is
         what makes an attachment's origin readable next to one an agent added
         with `kanban_attach`. */
      form.append('uploaded_by', 'web');
      return api.upload<{ attachment: TaskAttachment | null }>(
        kanbanUrl(`/tasks/${encodeURIComponent(id)}/attachments`, board),
        form,
      );
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['kanban', board ?? null, 'attachments', vars.id] });
      qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.id, board) });
    },
  });
}

export function useDeleteAttachment(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ attachmentId }: { attachmentId: number; taskId: string }) =>
      api.del<{ ok: boolean; id: number }>(kanbanUrl(`/attachments/${attachmentId}`, board)),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['kanban', board ?? null, 'attachments', vars.taskId] });
      qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.taskId, board) });
    },
  });
}

/**
 * Make one card depend on another, or stop it depending.
 *
 * The child stays in `todo` until every parent is `done`, and Hermes'
 * `recompute_ready` promotes it on its own once they are. `decompose` builds
 * these automatically; this is the manual path, and the reason it is worth
 * having is the inverse operation — a wrong edge from a decomposition is
 * otherwise permanent, and it gates a card indefinitely.
 */
export function useLinkTasks(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ parentId, childId }: { parentId: string; childId: string }) =>
      api.post(kanbanUrl('/links', board), { parent_id: parentId, child_id: childId }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: boardKeyPrefix(board) });
      qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.parentId, board) });
      qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.childId, board) });
    },
  });
}

export function useUnlinkTasks(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ parentId, childId }: { parentId: string; childId: string }) =>
      api.del(
        kanbanUrl(
          `/links?parent_id=${encodeURIComponent(parentId)}&child_id=${encodeURIComponent(childId)}`,
          board,
        ),
      ),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: boardKeyPrefix(board) });
      qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.parentId, board) });
      qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.childId, board) });
    },
  });
}

/**
 * Hermes' own notifier: push a card's completion or blocking to a chat.
 *
 * Distinct from this app's push, and worth having alongside it — the gateway
 * delivers to Telegram/Discord/Slack from the machine, so it works when no
 * browser has ever registered a subscription. `subscribed` on each channel is
 * per-task, which is why the list is fetched with the task id.
 */
export interface HomeChannel {
  platform: string;
  chat_id: string;
  thread_id: string;
  name: string;
  subscribed: boolean;
}

export function useHomeChannels(taskId: string | null, board?: string | null, enabled = true) {
  return useQuery({
    queryKey: ['kanban', board ?? null, 'home-channels', taskId],
    enabled: Boolean(taskId) && enabled,
    retry: false,
    staleTime: 30_000,
    queryFn: () =>
      api.get<{ home_channels: HomeChannel[] }>(
        kanbanUrl(`/home-channels?task_id=${encodeURIComponent(taskId!)}`, board),
      ),
  });
}

export function useHomeSubscription(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, platform, on }: { id: string; platform: string; on: boolean }) => {
      const path = `/tasks/${encodeURIComponent(id)}/home-subscribe/${encodeURIComponent(platform)}`;
      return on ? api.post(kanbanUrl(path, board), undefined) : api.del(kanbanUrl(path, board));
    },
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ['kanban', board ?? null, 'home-channels', vars.id] }),
  });
}

/**
 * Find the conversation a task ran in.
 *
 * There are two joins available and the app used only the weaker one, which is
 * why some cards showed a session and some — the sub-tasks a decomposition
 * fanned out, most visibly — showed nothing at all.
 *
 * **The exact join.** When a worker finishes, `_stamp_worker_session_metadata`
 * writes its own `HERMES_SESSION_ID` into the run's `metadata` blob as
 * `worker_session_id`. That is a real id: it can be fetched directly and it
 * cannot be wrong. It is not a column and not every run has one (a run that
 * crashed, was reclaimed, or is still going never wrote it), so it is a
 * fast path, not the answer.
 *
 * **The correlation.** Failing that, the run's session is looked for by its
 * derived title — `work kanban task <id>` — plus `source: kanban`. This is what
 * the app used to do exclusively, and it has a failure mode that is invisible
 * from the screen: **the title is generated by the auxiliary model, so a
 * session can simply not have one.** Of the kanban sessions in this install's
 * research profile, most are `title: null`; every one of them was unfindable,
 * and the card reported "no matching conversation" for a run that plainly
 * happened. That is the bug, and the exact join above is the fix for the runs
 * that carry it.
 *
 * **The profile.** Both lookups are scoped to `run.profile` — where the worker
 * actually ran — falling back to the card's assignee only when there is no run
 * to ask. `task.assignee` is where the card points *now*, which a reassignment
 * or a decomposer routing a child to a specialist makes a different thing.
 * Sessions live in per-profile stores, so looking in the wrong one returns
 * nothing with no error.
 *
 * A miss still has to read as "cannot tell", never "it did not run" — and the
 * sheet now has something better than a shrug to offer for that case: the
 * worker's log, which exists whenever the worker was spawned at all.
 */
export function useTaskSession(
  taskId: string | null,
  /** `run.profile` of the newest run, else the card's assignee. */
  profile: string | null,
  /** `worker_session_id` off the newest run that recorded one, if any. */
  sessionHint: string | null,
  /**
   * Whether the task could still acquire a session. Only a card that is
   * running or waiting to run can, and for anything else this is a one-shot
   * lookup rather than a poll.
   */
  live = true,
) {
  return useQuery({
    queryKey: ['kanban', 'task-session', taskId, profile ?? null, sessionHint ?? null],
    enabled: Boolean(taskId),
    /**
     * The poll stops the moment there is an answer, and never starts for a
     * card that cannot get one.
     *
     * This was a flat 15s, which meant an open task sheet pulled a hundred
     * session rows off the backend four times a minute for the whole time it
     * sat there — including for a `done` card, whose session was found on the
     * first request and cannot change, and for which every subsequent fetch
     * returned the identical row. The session appears partway through a run,
     * so polling is only ever useful in the window between the run starting
     * and the row landing.
     */
    refetchInterval: (q) => (live && q.state.data == null ? 15_000 : false),
    // A remount — reopening the sheet, or the board refetching under it — is
    // not a reason to go and ask again straight away.
    staleTime: 10_000,
    queryFn: async () => {
      if (sessionHint) {
        try {
          const row = await api.get<SessionRow>(
            sessionUrl(`/api/sessions/${encodeURIComponent(sessionHint)}`, profile),
          );
          if (row?.id) return row;
        } catch {
          /* A stamped id the store no longer holds — deleted, or written by a
             profile we guessed wrong. Fall through to the correlation rather
             than reporting nothing. */
        }
      }

      /**
       * `order=recent` and a page rather than the whole store. A session that
       * belongs to a task open on screen is by construction one of the most
       * recently active in that profile: it is either running now or it ran
       * when the card last did. Fifty is roomy for that and half the rows of
       * the hundred this used to pull on every tick.
       *
       * The cost of guessing that window wrong is already the documented cost
       * of this whole lookup — no match means "cannot tell", never "did not
       * run" — so a miss degrades to the answer the caller already has to
       * handle rather than to a wrong one.
       */
      const res = await api.get<{ sessions?: SessionRow[] }>(
        sessionUrl('/api/sessions?limit=50&order=recent&archived=include', profile),
      );
      const rows = res.sessions ?? [];
      return (
        rows.find(
          (r) =>
            (r.source ?? '').toLowerCase() === 'kanban' &&
            typeof r.title === 'string' &&
            r.title.includes(taskId!),
        ) ?? null
      );
    },
  });
}

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

/** Hand a ready card to the dispatcher so an agent picks it up now. */
export function useDispatch(board?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts?: string | { taskId?: string; dryRun?: boolean; max?: number }) => {
      const o = typeof opts === 'string' ? { taskId: opts } : (opts ?? {});
      const query = new URLSearchParams();
      if (o.dryRun) query.set('dry_run', 'true');
      if (o.max != null) query.set('max', String(o.max));
      const suffix = query.toString();
      return api.post<DispatchResult>(
        kanbanUrl(`/dispatch${suffix ? `?${suffix}` : ''}`, board),
        o.taskId ? { task_id: o.taskId } : {},
      );
    },
    onSuccess: (_d, opts) => {
      // A dry run changed nothing; refetching the board would be a lie about
      // what just happened and a wasted round trip on a slow phone.
      const dry = typeof opts === 'object' && opts?.dryRun;
      if (!dry) qc.invalidateQueries({ queryKey: boardKeyPrefix(board) });
    },
  });
}
