/**
 * Agent profiles.
 *
 * A profile is a whole Hermes configuration — its own model, skills, memory,
 * cron jobs and MCP servers, rooted at its own directory. Switching is a
 * server-side reload rather than a restart, but it changes what nearly every
 * other screen shows, so callers should invalidate broadly afterwards.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface Profile {
  name: string;
  path: string;
  is_default: boolean;
  model: string | null;
  provider: string | null;
  has_env: boolean;
  skill_count: number;
  /** Whether this profile's gateway process is up. */
  gateway_running: boolean;
  description: string;
  description_auto: boolean;
}

export interface ProfileCreate {
  name: string;
  description?: string;
  provider?: string;
  model?: string;
  /** Copy another profile's config as the starting point. */
  clone_from?: string;
  no_skills?: boolean;
}

export const profileKeys = {
  all: ['profiles'] as const,
  list: ['profiles', 'list'] as const,
  active: ['profiles', 'active'] as const,
};

export function useProfiles() {
  return useQuery({
    queryKey: profileKeys.list,
    queryFn: () => api.get<{ profiles: Profile[] }>('/api/profiles'),
    staleTime: 30_000,
  });
}

export function useActiveProfile() {
  return useQuery({
    queryKey: profileKeys.active,
    queryFn: () => api.get<{ active: string; current: string }>('/api/profiles/active'),
    staleTime: 30_000,
  });
}

/**
 * Switch the active profile.
 *
 * This reloads config, skills, memory, cron and models server-side, so every
 * cached domain is stale afterwards — hence clearing the whole query cache
 * rather than a targeted invalidation.
 */
export function useSwitchProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post('/api/profiles/active', { name }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useCreateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileCreate) => api.post('/api/profiles', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: profileKeys.all }),
  });
}

export function useDeleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.del(`/api/profiles/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: profileKeys.all }),
  });
}

export function useSetProfileModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, provider, model }: { name: string; provider?: string; model: string }) =>
      api.put(`/api/profiles/${encodeURIComponent(name)}/model`, { provider, model }),
    onSuccess: () => qc.invalidateQueries({ queryKey: profileKeys.all }),
  });
}
