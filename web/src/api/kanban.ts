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

/** Hand a ready card to the dispatcher so an agent picks it up now. */
export function useDispatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id?: string) => api.post(`${BASE}/dispatch`, id ? { task_id: id } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: kanbanKeys.board }),
  });
}
