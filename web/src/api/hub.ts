/**
 * Hub data: skills, cron jobs, memory, analytics and config.
 * One module because each domain is only a couple of hooks.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// --- skills ------------------------------------------------------------------

export interface Skill {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  usage: number;
  provenance: string;
}

export function useSkills() {
  return useQuery({
    queryKey: ['skills'],
    queryFn: () => api.get<Skill[]>('/api/skills'),
    staleTime: 30_000,
  });
}

export function useToggleSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      api.put('/api/skills/toggle', { name, enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export interface HubSkill {
  name: string;
  description?: string;
  source?: string;
  installed?: boolean;
}

export function useSkillHubSearch(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: ['skills', 'hub', query],
    queryFn: () =>
      api.get<{ results?: HubSkill[]; skills?: HubSkill[] }>(
        `/api/skills/hub/search?q=${encodeURIComponent(query)}`,
      ),
    enabled: query.length >= 2,
  });
}

export function useInstallSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; source?: string }) =>
      api.post('/api/skills/hub/install', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

// --- cron --------------------------------------------------------------------

/**
 * A scheduled job, as Hermes actually reports it.
 *
 * `schedule` is an *object* on current builds (`{kind, run_at, display}`),
 * not the string this used to claim — and since the declared type said string,
 * rendering it straight into JSX type-checked fine and then threw "Objects are
 * not valid as a React child" at runtime, taking the whole app down with it.
 * Both shapes are allowed here so an older gateway still works; read it through
 * `scheduleText` rather than touching it directly.
 *
 * The timestamps are the same story: `*_at` ISO strings now, bare epoch
 * numbers on older builds, and the `next_run`/`last_run` spellings this file
 * previously used exist on neither.
 */
export interface CronSchedule {
  kind?: string;
  display?: string;
  run_at?: string;
  [k: string]: unknown;
}

export interface CronJob {
  id: string;
  name?: string;
  prompt?: string;
  schedule?: string | CronSchedule;
  /** Pre-rendered by the backend — the thing to show when it is there. */
  schedule_display?: string;
  enabled?: boolean;
  paused?: boolean;
  paused_at?: string | null;
  /** e.g. "completed" for a one-shot that has already run. */
  state?: string;
  next_run_at?: string | number | null;
  last_run_at?: string | number | null;
  last_status?: string | null;
  /**
   * Set only on a *pinned* job. Null means the job follows the global default
   * at fire time — see the note in `CronTab`, and `model_snapshot`, which is
   * what the gateway compares against to detect drift.
   */
  model?: string | null;
  provider?: string | null;
  /**
   * Why the last run failed, when it failed before producing a run row at all
   * — a drift-guard refusal aborts ahead of one, so this is the only account
   * of it anywhere. `CronTab` falls back to it when the history comes back
   * empty.
   */
  last_error?: string | null;
  [k: string]: unknown;
}

export function useCronJobs() {
  return useQuery({
    queryKey: ['cron'],
    queryFn: () => api.get<CronJob[] | { jobs: CronJob[] }>('/api/cron/jobs'),
    select: (d) => (Array.isArray(d) ? d : (d.jobs ?? [])),
    refetchInterval: 30_000,
  });
}

export function useCronRuns(jobId: string | null) {
  return useQuery({
    queryKey: ['cron', 'runs', jobId],
    queryFn: () =>
      api.get<{ runs?: unknown[] } | unknown[]>(
        `/api/cron/jobs/${encodeURIComponent(jobId!)}/runs`,
      ),
    enabled: Boolean(jobId),
  });
}

export function useCronAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' | 'trigger' }) =>
      api.post(`/api/cron/jobs/${encodeURIComponent(id)}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cron'] }),
  });
}

export function useCreateCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/api/cron/jobs', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cron'] }),
  });
}

export function useDeleteCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/cron/jobs/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cron'] }),
  });
}

// --- memory ------------------------------------------------------------------

/** Read an arbitrary text file (used for MEMORY.md / USER.md / SOUL.md). */
export function useTextFile(path: string | null) {
  return useQuery({
    queryKey: ['fs', 'read', path],
    queryFn: () =>
      api.get<{ content?: string; text?: string }>(
        `/api/fs/read-text?path=${encodeURIComponent(path!)}`,
      ),
    enabled: Boolean(path),
    retry: false,
  });
}

export function useWriteTextFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api.post('/api/fs/write-text', { path, content }),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ['fs', 'read', vars.path] }),
  });
}

export function useMemoryProviders() {
  return useQuery({
    queryKey: ['memory'],
    queryFn: () =>
      api.get<{ active: string; providers: { name: string; description: string; status: string }[] }>(
        '/api/memory',
      ),
    staleTime: 60_000,
  });
}

// --- analytics ---------------------------------------------------------------

/**
 * The window every analytics call takes, in days. The backend clamps to 1-365
 * and the UI offers 1/7/30/90, where 1 is a rolling 24 hours (the cutoff is
 * `now - 86400`, not midnight).
 */
export type UsageDays = 1 | 7 | 30 | 90;

export interface UsageDay {
  day: string;
  input_tokens: number;
  output_tokens: number;
  /** Zero on providers that do not report caching — which is every local one. */
  cache_read_tokens: number;
  reasoning_tokens: number;
  estimated_cost: number;
  actual_cost: number;
  sessions: number;
  api_calls: number;
}

/** Per-model rollup as it appears inside the *usage* payload (thinner than
 *  `/api/analytics/models`), carrying the auxiliary calls billed to it. */
export interface UsageModel {
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  sessions: number;
  api_calls: number;
  aux_tasks?: { task: string; input_tokens: number; output_tokens: number; api_calls: number }[];
}

/**
 * Auxiliary work, aggregated across models: `title_generation`, `approval`,
 * `compression`, and whatever else Hermes bills to a task slot.
 *
 * This is the one breakdown nothing else in the app surfaces, and the only
 * place the machinery tax is visible — every new session pays for a title, and
 * approvals can run to hundreds of calls, none of it attributable to a
 * conversation you remember having.
 */
export interface TaskUsage {
  task: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  api_calls: number;
  models: string[];
}

export interface ToolUsage {
  tool: string;
  count: number;
  percentage: number;
}

export interface SkillUsage {
  skill: string;
  view_count: number;
  manage_count: number;
  total_count: number;
  percentage: number;
  last_used_at: number | null;
}

export interface UsageTotals {
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_reasoning: number;
  total_estimated_cost: number;
  total_actual_cost: number;
  total_sessions: number;
  total_api_calls: number;
}

export interface UsagePayload {
  daily: UsageDay[];
  by_model: UsageModel[];
  by_task: TaskUsage[];
  totals: UsageTotals;
  period_days: number;
  skills: {
    summary: {
      total_skill_loads: number;
      total_skill_edits: number;
      total_skill_actions: number;
      distinct_skills_used: number;
    };
    top_skills: SkillUsage[];
  };
  tools: ToolUsage[];
}

export function useUsageAnalytics(days: UsageDays = 30) {
  return useQuery({
    queryKey: ['analytics', 'usage', days],
    queryFn: () => api.get<UsagePayload>(`/api/analytics/usage?days=${days}`),
    staleTime: 60_000,
  });
}

export interface ModelUsage {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  sessions: number;
  api_calls: number;
  tool_calls: number;
  last_used_at: number | null;
  estimated_cost: number;
  actual_cost: number;
  avg_tokens_per_session: number;
  /** From models.dev, absent for a model it does not know (every local one). */
  capabilities?: {
    supports_tools?: boolean;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    context_window?: number;
    max_output_tokens?: number;
    model_family?: string;
  };
}

export function useModelAnalytics(days: UsageDays = 30) {
  return useQuery({
    queryKey: ['analytics', 'models', days],
    queryFn: () =>
      api.get<{ models: ModelUsage[]; totals: Record<string, number> }>(
        `/api/analytics/models?days=${days}`,
      ),
    staleTime: 60_000,
  });
}

// --- default model -----------------------------------------------------------

export interface ModelAssignment {
  provider: string;
  model: string;
}

/**
 * The model **new** sessions start with, as stored in `~/.hermes/config.yaml`.
 *
 * Read from `/api/model/auxiliary` despite the name: that endpoint returns the
 * auxiliary task slots *and* the main assignment, and it is the only route that
 * reports what is written to disk. `/api/model/info` and the gateway's
 * `model.options` both answer with the live resolved model instead, which drifts
 * from the stored default as soon as any chat switches model for itself.
 */
export function useDefaultModel() {
  return useQuery({
    queryKey: ['model', 'default'],
    queryFn: () =>
      api.get<{ main: ModelAssignment; tasks: { task: string; provider: string; model: string }[] }>(
        '/api/model/auxiliary',
      ),
    staleTime: 60_000,
  });
}

export interface SetModelResult {
  ok?: boolean;
  /**
   * Set when the model is priced steeply enough that Hermes wants a second
   * look. Nothing is written in that case — resend with `confirmExpensive`.
   */
  confirm_required?: boolean;
  confirm_message?: string;
}

/**
 * Write the default model. Affects new sessions only — a chat already running
 * keeps whatever it was using, which is what the in-chat model sheet changes.
 *
 * Note the confirmation path resolves as a 200 with `ok: false`, not an error,
 * so callers must inspect the result rather than trusting the promise.
 */
export function useSetDefaultModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      provider,
      model,
      confirmExpensive = false,
    }: {
      provider: string;
      model: string;
      confirmExpensive?: boolean;
    }) =>
      api.post<SetModelResult>('/api/model/set', {
        scope: 'main',
        provider,
        model,
        confirm_expensive_model: confirmExpensive,
      }),
    onSuccess: (res) => {
      if (!res.confirm_required) void qc.invalidateQueries({ queryKey: ['model', 'default'] });
    },
  });
}

// --- config ------------------------------------------------------------------

export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<Record<string, unknown>>('/api/config'),
    staleTime: 60_000,
  });
}

/** Proxy health — drives the connection banner and the setup screen. */
export function useHealth() {
  return useQuery({
    queryKey: ['healthz'],
    queryFn: () =>
      api.get<{
        ok: boolean;
        backend: 'up' | 'down' | 'unauthorized';
        version: string | null;
        upstream: string;
        hasToken: boolean;
        /** Where another device on the LAN should point. Null if undetectable. */
        lanUrl?: string | null;
        /**
         * Set when the proxy sits behind a public front (`tailscale serve`).
         * Preferred over `lanUrl`: it's HTTPS, so it's the address that gets
         * the other phone an installable PWA rather than a bookmark.
         */
        publicUrl?: string | null;
      }>('/healthz'),
    refetchInterval: 30_000,
    retry: false,
  });
}
