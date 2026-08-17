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

export interface CronJob {
  id: string;
  name?: string;
  prompt?: string;
  schedule?: string;
  enabled?: boolean;
  paused?: boolean;
  next_run?: number | null;
  last_run?: number | null;
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

export interface UsageDay {
  day: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  estimated_cost: number;
  sessions: number;
  api_calls: number;
}

export function useUsageAnalytics() {
  return useQuery({
    queryKey: ['analytics', 'usage'],
    queryFn: () => api.get<{ daily: UsageDay[] }>('/api/analytics/usage'),
    staleTime: 60_000,
  });
}

export interface ModelUsage {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  sessions: number;
  api_calls: number;
  tool_calls: number;
  last_used_at: number | null;
  estimated_cost: number;
}

export function useModelAnalytics() {
  return useQuery({
    queryKey: ['analytics', 'models'],
    queryFn: () => api.get<{ models: ModelUsage[] }>('/api/analytics/models'),
    staleTime: 60_000,
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
      }>('/healthz'),
    refetchInterval: 30_000,
    retry: false,
  });
}
