/**
 * Hub data: skills, cron jobs, memory, analytics and config.
 * One module because each domain is only a couple of hooks.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// --- skills ------------------------------------------------------------------

/**
 * Add `?profile=` to a path, or leave it alone.
 *
 * Every profile-scoped Hermes endpoint takes the name this way, and an omitted
 * parameter is never "no profile" — it is "whichever profile happens to be
 * active", which is the wrong one exactly when you are looking at another
 * profile's screen and cannot see that you are. Hence a named helper with a
 * test rather than a template string at each call site.
 */
export function withProfile(path: string, profile?: string | null): string {
  if (!profile) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}profile=${encodeURIComponent(profile)}`;
}

export interface Skill {
  name: string;
  description: string;
  /**
   * Null on skills the agent wrote itself — Hermes only fills a category in
   * for the bundled set. Anything grouping or rendering this has to survive
   * that; `SkillsTab` did not, and one such skill blanked the whole app.
   */
  category: string | null;
  enabled: boolean;
  usage: number;
  provenance: string;
}

/**
 * @param profile read another profile's skills instead of the active one.
 *   Needed wherever you are configuring a profile you are not currently
 *   running as — pinning skills onto a cron job that belongs to `research`
 *   must offer research's skills, not the ones in front of you.
 *
 * @param enabled hold the request back entirely. The cron screen only needs
 *   this list while its create sheet is open, and firing it on every visit to
 *   a screen that mostly reads jobs is two requests nobody asked for.
 *
 * The key keeps its old shape when no profile is named, so every existing
 * caller and every `invalidateQueries(['skills'])` behaves as before — and
 * prefix matching means those invalidations still reach the scoped copies.
 */
export function useSkills(profile?: string | null, enabled = true) {
  return useQuery({
    queryKey: profile ? ['skills', profile] : ['skills'],
    queryFn: () => api.get<Skill[]>(withProfile('/api/skills', profile)),
    staleTime: 30_000,
    enabled,
  });
}

/**
 * @param profile toggle the skill in another profile than the active one.
 *   The endpoint takes it in the body; without it the toggle silently lands
 *   on whichever profile is running, which is the wrong one whenever you are
 *   editing a profile from the profiles screen.
 *
 * Invalidates the whole `['skills']` prefix rather than the one scoped key,
 * because the active profile's list and the edited profile's list can be the
 * same list.
 */
export function useToggleSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      name,
      enabled,
      profile,
    }: {
      name: string;
      enabled: boolean;
      profile?: string | null;
    }) => api.put('/api/skills/toggle', { name, enabled, ...(profile ? { profile } : {}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export interface HubSkill {
  name: string;
  description?: string;
  source?: string;
  /**
   * What install actually takes — `skills-sh/anthropics/skills/pdf`, not the
   * bare name. One search for `pdf` returns the same `name` from three
   * different repos, so the name identifies nothing: it is the display label
   * and this is the address.
   */
  identifier?: string;
  repo?: string;
  installed?: boolean;
}

/**
 * @param profile which profile's hub to search. It decides where a subsequent
 *   install lands, and the `installed` flags come back relative to it.
 */
export function useSkillHubSearch(q: string, profile?: string | null) {
  const query = q.trim();
  return useQuery({
    queryKey: profile ? ['skills', 'hub', query, profile] : ['skills', 'hub', query],
    queryFn: () =>
      api.get<{ results?: HubSkill[]; skills?: HubSkill[] }>(
        withProfile(`/api/skills/hub/search?q=${encodeURIComponent(query)}`, profile),
      ),
    enabled: query.length >= 2,
  });
}

/**
 * The body field is `identifier`, and the endpoint rejects anything else —
 * this used to post `{ name, source }`, which is a 422 every time.
 */
export function useInstallSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ identifier, profile }: { identifier: string; profile?: string | null }) =>
      api.post(withProfile('/api/skills/hub/install', profile), { identifier }),
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
  /**
   * Which profile's job store this came out of.
   *
   * A cron job is not *tagged* with a profile — it lives in that profile's own
   * `cron/jobs.json`, and runs against that profile's home: its config, model,
   * skills and memory. Hermes stamps every job it hands back with the store it
   * was read from (`profile`, `profile_name`, `hermes_home`), which is the only
   * way to tell two jobs apart in the merged listing below.
   */
  profile?: string;
  profile_name?: string;
  hermes_home?: string;
  /** Pinned per-job, and narrower than the profile's own set. Empty/absent
      means the job runs with whatever the profile has enabled. */
  skills?: string[];
  enabled_toolsets?: string[];
  [k: string]: unknown;
}

/**
 * `withProfile` under the name the cron screen calls it, kept because the cron
 * defaults are the sharpest case of why the parameter is never optional in
 * practice: the *list* endpoint defaults to `all` (every profile's jobs,
 * merged) while create and the per-job actions default to whichever profile
 * happens to be active. So an omitted parameter there is not one behaviour,
 * it is two.
 */
export const cronUrl = withProfile;

/**
 * Every profile's jobs at once — which is the server's default, and worth
 * saying out loud because it does not look like it from here.
 *
 * The screen renders one list, so without the `profile` stamp on each row a
 * second profile's jobs simply appear in it, indistinguishable from the ones
 * you were looking at.
 */
export function useCronJobs() {
  return useQuery({
    queryKey: ['cron'],
    queryFn: () => api.get<CronJob[] | { jobs: CronJob[] }>('/api/cron/jobs'),
    select: (d) => (Array.isArray(d) ? d : (d.jobs ?? [])),
    refetchInterval: 30_000,
  });
}

export function useCronRuns(jobId: string | null, profile?: string | null) {
  return useQuery({
    queryKey: ['cron', 'runs', jobId, profile ?? null],
    queryFn: () =>
      api.get<{ runs?: unknown[] } | unknown[]>(
        cronUrl(`/api/cron/jobs/${encodeURIComponent(jobId!)}/runs`, profile),
      ),
    enabled: Boolean(jobId),
  });
}

/**
 * Pause, resume or trigger.
 *
 * The profile is passed whenever the caller knows it, and the caller always
 * does — it came back on the job. Without it Hermes falls back to
 * `_find_cron_job_profile`, which walks every profile's store and matches on
 * **id or name**: two profiles each holding a job called `morning-brief`
 * resolve to whichever is scanned first. That is a silent wrong-job action,
 * and it only ever happens to someone who has more than one profile.
 */
export function useCronAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      profile,
    }: {
      id: string;
      action: 'pause' | 'resume' | 'trigger';
      profile?: string | null;
    }) => api.post(cronUrl(`/api/cron/jobs/${encodeURIComponent(id)}/${action}`, profile)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cron'] }),
  });
}

/**
 * Create a job in a named profile's store.
 *
 * `profile` is a query parameter, not a body field — Hermes writes the job
 * into `<that profile's home>/cron/jobs.json`, which is what makes the job run
 * as that agent. Omitting it silently files the job under whichever profile is
 * active at the moment of creation, which is the behaviour every job made
 * before this had, and the reason the picker defaults to the active one rather
 * than to nothing.
 */
export function useCreateCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ profile, ...body }: Record<string, unknown> & { profile?: string | null }) =>
      api.post(cronUrl('/api/cron/jobs', profile), body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cron'] }),
  });
}

/** Same scoping argument as `useCronAction` — deleting the wrong profile's
    same-named job is the worst version of that mistake. */
export function useDeleteCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, profile }: { id: string; profile?: string | null }) =>
      api.del(cronUrl(`/api/cron/jobs/${encodeURIComponent(id)}`, profile)),
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
/**
 * Write the model Hermes uses for auxiliary work.
 *
 * `scope: "auxiliary"` with no `task` sets every auxiliary task at once —
 * `vision`, `compression`, `title_generation`, `approval` and the rest — which
 * is the whole point: these are the jobs nobody wants to configure one at a
 * time, and pointing them all at one cheap model is the setting people
 * actually want. Passing a `task` narrows it to that one, which the backend
 * validates; this app does not expose per-task control because eleven pickers
 * on a phone is not a feature.
 *
 * `provider: "auto"` with an empty `model` is the factory state, and how you
 * get back to "let Hermes decide" — there is no separate reset call.
 */
export function useSetAuxiliaryModel() {
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
        scope: 'auxiliary',
        provider,
        model,
        confirm_expensive_model: confirmExpensive,
      }),
    onSuccess: (res) => {
      if (!res.confirm_required) void qc.invalidateQueries({ queryKey: ['model', 'default'] });
    },
  });
}

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
        /**
         * The build the *server* is serving, and when the proxy last started.
         * Compare `webBuild` against the bundle's own `__BUILD_ID__` to catch a
         * service worker still holding an older copy of the app.
         */
        webBuild?: string | null;
        serverStartedAt?: string;
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
