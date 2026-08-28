/**
 * The kanban plugin's board-level surface: boards, orchestration, the profile
 * roster, projects, and the three read-only health endpoints.
 *
 * Split from `api/kanban.ts` because nothing here is about a *task*. These are
 * the settings and diagnostics the board runs under, they change rarely, and
 * they are read by two sheets rather than by every card — keeping them out of
 * the task module keeps the chunk a phone loads to look at a card smaller.
 *
 * Two of them are load-bearing in ways the endpoint names do not suggest:
 *
 * - **`/profiles` descriptions are what the decomposer routes on.** When a
 *   triage card is fanned out, each child is assigned by matching the work
 *   against the *description text* of every profile. An empty description does
 *   not mean "no preference", it means that profile cannot be matched — so on
 *   an install where the descriptions were never written, every child lands on
 *   the default assignee and `decompose` looks like it ignores the specialists
 *   it has. `describe-auto` writes one from the profile's own config.
 * - **`/orchestration` holds `auto_decompose`**, which is the gateway
 *   dispatcher's own triage sweep. With it on, a card left in Triage is picked
 *   up and fanned out without anyone pressing anything; with it off, Triage is
 *   a terminal column unless a human acts. That single boolean decides whether
 *   the app's "new cards start in Triage" default is a queue or a parking lot,
 *   so the create sheet reads it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

const BASE = '/api/plugins/kanban';

export const adminKeys = {
  boards: (includeArchived?: boolean) => ['kanban', 'boards', Boolean(includeArchived)] as const,
  config: ['kanban', 'config'] as const,
  orchestration: ['kanban', 'orchestration'] as const,
  profiles: ['kanban', 'plugin-profiles'] as const,
  projects: ['kanban', 'projects'] as const,
  modelOptions: ['kanban', 'model-options'] as const,
  stats: (board?: string | null) => ['kanban', board ?? null, 'stats'] as const,
  diagnostics: (board?: string | null, severity?: string | null) =>
    ['kanban', board ?? null, 'diagnostics', severity ?? null] as const,
  workers: (board?: string | null) => ['kanban', board ?? null, 'workers'] as const,
};

function withBoard(path: string, board?: string | null): string {
  if (!board) return `${BASE}${path}`;
  const full = `${BASE}${path}`;
  return `${full}${full.includes('?') ? '&' : '?'}board=${encodeURIComponent(board)}`;
}

/* ------------------------------------------------------------------ boards */

export interface BoardMeta {
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  default_workdir: string | null;
  project_id: string | null;
  project_name: string | null;
  created_at: number | null;
  archived: boolean;
  db_path: string;
  is_current: boolean;
  counts: Record<string, number>;
  total: number;
  default_workspace_kind: string;
}

/**
 * The boards this Hermes holds, and which one unqualified calls address.
 *
 * `current` is a **server-side** pointer, not a client preference: any other
 * client switching boards moves it under this app. That is why the app pins
 * its own selection into every request rather than relying on it, and why this
 * query is what the picker reconciles against rather than a value in the UI
 * store.
 */
export function useBoards(includeArchived = false, enabled = true) {
  return useQuery({
    queryKey: adminKeys.boards(includeArchived),
    enabled,
    staleTime: 60_000,
    retry: 1,
    queryFn: () =>
      api.get<{ boards: BoardMeta[]; current: string }>(
        `${BASE}/boards${includeArchived ? '?include_archived=true' : ''}`,
      ),
  });
}

export interface BoardInput {
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  /** Must be an absolute path that exists, or the create is rejected. */
  default_workdir?: string;
  project_id?: string;
}

export function useCreateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BoardInput & { slug: string; switch?: boolean }) =>
      api.post<{ board: BoardMeta; current: string }>(`${BASE}/boards`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kanban'] }),
  });
}

export function useUpdateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, ...body }: BoardInput & { slug: string }) =>
      api.patch<{ board: BoardMeta }>(`${BASE}/boards/${encodeURIComponent(slug)}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kanban', 'boards'] }),
  });
}

/**
 * Archive a board, or destroy it.
 *
 * The default is archive, and the flag that changes that is called `delete`
 * server-side. A hard delete takes the board's whole SQLite file with it —
 * every card, run and comment — and there is no undo anywhere in Hermes, which
 * is why the caller has to ask for it by name.
 */
export function useDeleteBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, hard = false }: { slug: string; hard?: boolean }) =>
      api.del<{ result: unknown; current: string }>(
        `${BASE}/boards/${encodeURIComponent(slug)}${hard ? '?delete=true' : ''}`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kanban'] }),
  });
}

/**
 * Move the server's own pointer.
 *
 * Rarely what this app wants — it addresses boards explicitly — but it is what
 * every *other* client on the machine follows, so "make this the board the CLI
 * and the desktop app see" needs to exist somewhere.
 */
export function useSwitchBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      api.post<{ current: string }>(`${BASE}/boards/${encodeURIComponent(slug)}/switch`, undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kanban'] }),
  });
}

/* ------------------------------------------------------------------ config */

export interface KanbanConfig {
  default_tenant: string;
  lane_by_profile: boolean;
  include_archived_by_default: boolean;
  render_markdown: boolean;
}

/**
 * Hermes' own kanban preferences, which the app used to hard-code against.
 *
 * Two of the four change what this app shows: `include_archived_by_default`
 * seeds the archived toggle, and `render_markdown` decides whether a task body
 * is prose or a fenced block. `default_tenant` seeds the tenant filter on the
 * installs that use tenants at all.
 */
export function useKanbanConfig() {
  return useQuery({
    queryKey: adminKeys.config,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: () => api.get<KanbanConfig>(`${BASE}/config`),
  });
}

/* ----------------------------------------------------------- orchestration */

export interface Orchestration {
  orchestrator_profile: string;
  default_assignee: string;
  auto_decompose: boolean;
  auto_promote_children: boolean;
  /** What the two empty-string settings above actually resolve to. */
  resolved_orchestrator_profile: string;
  resolved_default_assignee: string;
  active_profile: string;
}

export function useOrchestration(enabled = true) {
  return useQuery({
    queryKey: adminKeys.orchestration,
    enabled,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => api.get<Orchestration>(`${BASE}/orchestration`),
  });
}

export function useSetOrchestration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Pick<Orchestration, 'orchestrator_profile' | 'default_assignee' | 'auto_decompose' | 'auto_promote_children'>>) =>
      api.put<Orchestration>(`${BASE}/orchestration`, body),
    onSuccess: (data) => qc.setQueryData(adminKeys.orchestration, data),
  });
}

/* ---------------------------------------------------------------- profiles */

export interface KanbanProfile {
  name: string;
  is_default: boolean;
  model: string;
  provider: string;
  description: string;
  /** Whether the text was written by `describe-auto` rather than by a person. */
  description_auto: boolean;
  skill_count: number;
}

/**
 * The plugin's own profile roster — the same names as `/api/profiles`, plus
 * the description the decomposer routes on. Kept separate from `api/profiles`
 * because that endpoint does not carry the description at all.
 */
export function useKanbanProfiles(enabled = true) {
  return useQuery({
    queryKey: adminKeys.profiles,
    enabled,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => api.get<{ profiles: KanbanProfile[] }>(`${BASE}/profiles`),
  });
}

export function useSetProfileDescription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, description }: { name: string; description: string | null }) =>
      api.patch<{ ok: boolean; profile: string; description: string }>(
        `${BASE}/profiles/${encodeURIComponent(name)}`,
        { description },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.profiles }),
  });
}

/**
 * Have the auxiliary model write a profile's description from its own config.
 *
 * `overwrite` guards the case that matters: a description someone wrote by hand
 * is the authoritative one, and regenerating over it silently is not recoverable
 * — the old text is not stored anywhere. So the default refuses, and the caller
 * has to ask twice.
 */
export function useAutoDescribeProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, overwrite = false }: { name: string; overwrite?: boolean }) =>
      api.post<{ ok: boolean; profile: string; reason: string | null; description: string | null }>(
        `${BASE}/profiles/${encodeURIComponent(name)}/describe-auto`,
        { overwrite },
        { signal: AbortSignal.timeout(2 * 60_000) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.profiles }),
  });
}

/* ---------------------------------------------------------------- projects */

export interface KanbanProject {
  id: string;
  slug: string;
  name: string;
  primary_path: string;
  icon: string | null;
  color: string | null;
}

/**
 * First-class projects, which anchor a `worktree` task to a real repo with a
 * deterministic branch name instead of a random `wt/<task-id>` scratch path.
 */
export function useKanbanProjects(enabled = true) {
  return useQuery({
    queryKey: adminKeys.projects,
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: () => api.get<{ projects: KanbanProject[] }>(`${BASE}/projects`),
  });
}

/* ----------------------------------------------------------- model options */

export interface ProviderModels {
  slug: string;
  label: string;
  models: string[];
}

/**
 * The catalogue for a per-task model override.
 *
 * The plugin's own route, not `/api/model/options`: it answers with every
 * provider the *board* can dispatch to, which is what a per-task pin needs, and
 * it takes no profile — a task override names a provider explicitly, so the
 * profile's own provider is not the constraint.
 */
export function useKanbanModelOptions(enabled = true) {
  return useQuery({
    queryKey: adminKeys.modelOptions,
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: () => api.get<{ providers: ProviderModels[] }>(`${BASE}/model-options`),
  });
}

/* ------------------------------------------------------------------ health */

export interface BoardStats {
  by_status: Record<string, number>;
  by_assignee: Record<string, Record<string, number>>;
  /** How long the oldest card has been waiting to be claimed. The queue's age. */
  oldest_ready_age_seconds: number | null;
  now: number;
}

export function useBoardStats(board?: string | null, enabled = true) {
  return useQuery({
    queryKey: adminKeys.stats(board),
    enabled,
    staleTime: 15_000,
    retry: 1,
    queryFn: () => api.get<BoardStats>(withBoard('/stats', board)),
  });
}

export interface Diagnostic {
  kind: string;
  severity: 'warning' | 'error' | 'critical' | string;
  message?: string;
  detail?: string;
  [key: string]: unknown;
}

export interface TaskDiagnostics {
  task_id: string;
  task_title: string;
  task_status: string;
  task_assignee: string | null;
  diagnostics: Diagnostic[];
}

/**
 * Hermes' rule engine over the whole board.
 *
 * The per-card badge shows a count; this is the list of what those counts are.
 * Crash loops, spawn failures, cards blocked for days, workers citing task ids
 * that do not exist — all of it computed server-side and, until now, only
 * reachable from `hermes kanban doctor` on the machine itself.
 */
export function useDiagnostics(board?: string | null, severity?: string | null, enabled = true) {
  return useQuery({
    queryKey: adminKeys.diagnostics(board, severity),
    enabled,
    staleTime: 15_000,
    retry: 1,
    queryFn: () =>
      api.get<{ diagnostics: TaskDiagnostics[]; count: number }>(
        withBoard(`/diagnostics${severity ? `?severity=${encodeURIComponent(severity)}` : ''}`, board),
      ),
  });
}

export interface ActiveWorker {
  run_id: number;
  task_id: string;
  task_title: string;
  task_status: string;
  task_assignee: string | null;
  profile: string | null;
  worker_pid: number | null;
  started_at: number;
  claim_lock: string | null;
  claim_expires: number | null;
  last_heartbeat_at: number | null;
  max_runtime_seconds: number | null;
}

/**
 * Every live run on the board, with the claim and heartbeat behind it.
 *
 * The Running *column* is not this list: the dispatcher moves a card there
 * before a worker picks it up, and a claim outlives the process that held it.
 * A card in Running with no row here is the shape a stuck board takes, and it
 * is the only place that difference is visible.
 */
export function useActiveWorkers(board?: string | null, enabled = true) {
  return useQuery({
    queryKey: adminKeys.workers(board),
    enabled,
    // Live by definition; the endpoint is one query against the runs table.
    refetchInterval: enabled ? 10_000 : false,
    retry: 1,
    queryFn: () =>
      api.get<{ workers: ActiveWorker[]; count: number; checked_at: number }>(
        withBoard('/workers/active', board),
      ),
  });
}
