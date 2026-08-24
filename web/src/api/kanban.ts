/**
 * Kanban board.
 *
 * Hermes ships a complete kanban REST API as a dashboard plugin, so we drive
 * that rather than touching `kanban.db` directly: the kernel owns claim locks,
 * run bookkeeping and status routing, and writing SQL underneath it would race
 * the dispatcher.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { sessionUrl, type SessionRow } from './sessions';

const BASE = '/api/plugins/kanban';

/** Column order as the kernel defines it, left to right on the board. */
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
  session_id: string | null;
  block_kind: string | null;
  latest_summary: string | null;
  comment_count?: number;
  link_counts?: { parents: number; children: number };
  progress?: unknown;
  age?: { created_age_seconds: number | null };
}

export interface Board {
  columns: { name: Column; tasks: Task[] }[];
  assignees: string[];
  tenants: string[];
  latest_event_id: number;
  now: number;
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
}

export interface TaskDetail {
  task: Task;
  comments: TaskComment[];
  runs: TaskRun[];
  events: { id: number; kind: string; created_at: number; payload?: unknown }[];
  links: { parents: Task[]; children: Task[] };
  attachments: unknown[];
}

export const kanbanKeys = {
  board: ['kanban', 'board'] as const,
  task: (id: string) => ['kanban', 'task', id] as const,
};

export function useBoard(enabled = true) {
  return useQuery({
    queryKey: kanbanKeys.board,
    queryFn: () => api.get<Board>(`${BASE}/board`),
    // The agent moves cards on its own, so poll while the board is on screen.
    refetchInterval: 10_000,
    enabled,
    retry: 1,
  });
}

export function useTask(id: string | null) {
  return useQuery({
    queryKey: kanbanKeys.task(id ?? ''),
    queryFn: () => api.get<TaskDetail>(`${BASE}/tasks/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string; body?: string; priority?: number; assignee?: string; triage?: boolean }) =>
      api.post<{ task: Task }>(`${BASE}/tasks`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: kanbanKeys.board }),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<Pick<Task, 'title' | 'body' | 'status' | 'priority' | 'assignee'>>) =>
      api.patch<{ task: Task }>(`${BASE}/tasks/${encodeURIComponent(id)}`, patch),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: kanbanKeys.board });
      qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.id) });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`${BASE}/tasks/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: kanbanKeys.board }),
  });
}

export function useAddComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body, author = 'web' }: { id: string; body: string; author?: string }) =>
      api.post(`${BASE}/tasks/${encodeURIComponent(id)}/comments`, { body, author }),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: kanbanKeys.task(vars.id) }),
  });
}

/**
 * Find the session a task is running in.
 *
 * Hermes does not stamp `session_id` onto the task row — it stays null through
 * a run — so this is a **correlation, not a foreign key**: the run opens a
 * session in the assignee profile's store, sourced `kanban`, whose derived
 * title is literally `work kanban task <id>`. Matching on that plus the source
 * is the only join available.
 *
 * Which means it can be wrong in one direction and right in the other: a match
 * is almost certainly the session (the task id is unique and appears verbatim),
 * but no match does not prove there is no session — a retitled session, an
 * older Hermes, or a run whose session has not been flushed to the store yet
 * all look identical to "none". Callers must treat an empty result as "cannot
 * tell", never as "it did not run".
 *
 * Scoped to the task's assignee, because that is the profile the dispatcher
 * runs it as and therefore the only store the session can be in.
 */
export function useTaskSession(taskId: string | null, assignee: string | null) {
  return useQuery({
    queryKey: ['kanban', 'task-session', taskId, assignee ?? null],
    enabled: Boolean(taskId),
    // Cheap and worth being current: the session appears partway through a run.
    refetchInterval: 15_000,
    queryFn: async () => {
      const res = await api.get<{ sessions?: SessionRow[] }>(
        sessionUrl('/api/sessions?limit=100&order=recent&archived=include', assignee),
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

/** Hand a ready card to the dispatcher so an agent picks it up now. */
export function useDispatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id?: string) => api.post(`${BASE}/dispatch`, id ? { task_id: id } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: kanbanKeys.board }),
  });
}
