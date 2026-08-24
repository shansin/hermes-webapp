/**
 * Agent profiles.
 *
 * A profile is a whole Hermes configuration — its own model, skills, memory,
 * cron jobs and MCP servers, rooted at its own directory. Switching is a
 * server-side reload rather than a restart, but it changes what nearly every
 * other screen shows, so callers should invalidate broadly afterwards.
 */
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { Skill } from './hub';

export interface Profile {
  name: string;
  path: string;
  is_default: boolean;
  model: string | null;
  provider: string | null;
  has_env: boolean;
  /**
   * Skills **installed** in the profile — `SKILL.md` files on disk — not
   * skills the agent will load.
   *
   * Disabling a skill adds it to `skills.disabled` in the profile's config
   * and leaves the file where it is, so a profile deliberately narrowed to a
   * dozen skills still reports the whole bundle here. Rendering this as
   * "89 skills" is how a narrowed profile comes to look untouched. The
   * The enabled count needs a per-profile fetch, which is what
   * `useProfileSkillCounts` below does for the list and `useSkills(name)` in
   * `api/hub.ts` does for a single profile. Both share one query key, so the
   * list warms the cache the editor then reads.
   */
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

/**
 * A profile's `SOUL.md` — its standing instructions.
 *
 * The most consequential thing about a profile and, until now, the one part
 * of it this app could not see. Everything else on the profile screen (model,
 * skills, description) is a knob; this is the document that says what the
 * agent is *for*, and it was editable only over SSH.
 */
export function useProfileSoul(name: string | null) {
  return useQuery({
    queryKey: ['profiles', 'soul', name],
    queryFn: () =>
      api.get<{ content: string; exists: boolean }>(
        `/api/profiles/${encodeURIComponent(name!)}/soul`,
      ),
    enabled: Boolean(name),
    // Never cached across opens: this is a document someone may be editing in
    // a terminal at the same time, and a stale copy would be saved back over
    // their changes.
    staleTime: 0,
    gcTime: 0,
  });
}

export function useSetProfileSoul() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) =>
      api.put(`/api/profiles/${encodeURIComponent(name)}/soul`, { content }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ['profiles', 'soul', vars.name] }),
  });
}

/** The kanban decomposer routes on this text, so it is not cosmetic. */
export function useSetProfileDescription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, description }: { name: string; description: string }) =>
      api.put(`/api/profiles/${encodeURIComponent(name)}/description`, { description }),
    onSuccess: () => qc.invalidateQueries({ queryKey: profileKeys.all }),
  });
}

/**
 * Have the auxiliary model write the description.
 *
 * Reports failure as `ok: false` with a reason rather than an HTTP error —
 * there is no aux client configured, the call failed — so the caller must
 * check the body, not just the absence of a throw.
 */
export function useDescribeProfileAuto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<{ ok: boolean; reason?: string; description?: string }>(
        `/api/profiles/${encodeURIComponent(name)}/describe-auto`,
        { overwrite: true },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: profileKeys.all }),
  });
}

/**
 * Rename.
 *
 * The default profile is a special case the backend handles rather than
 * refuses: its canonical id stays `default` and the new name lands as a
 * presentation-only `display_name`. The response always carries the canonical
 * id, so callers keying on `name` stay correct either way.
 */
export function useRenameProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, newName }: { name: string; newName: string }) =>
      api.patch<{ ok: boolean; name: string; display_name?: string }>(
        `/api/profiles/${encodeURIComponent(name)}`,
        { new_name: newName },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: profileKeys.all }),
  });
}

/**
 * Enabled-skill counts for a list of profiles, one request each.
 *
 * The profile list carries `skill_count`, but that is `SKILL.md` files on disk
 * — disabling a skill leaves the file alone, so a profile narrowed to sixteen
 * still reports eighty-nine. The number worth reading is what the agent will
 * actually load, and it exists nowhere in the list payload.
 *
 * So this fans out. The keys and the URL match `useSkills(profile)` exactly, so
 * the profile editor opening on a row costs nothing extra — it reads the entry
 * this already filled — and both share one 30s stale window. With a handful of
 * profiles that is a handful of small requests on a screen you visit rarely;
 * it would be the wrong trade on a screen that polls.
 *
 * Returns a map of name → enabled count, with profiles still in flight simply
 * absent rather than reported as zero. "Zero skills enabled" is a real and
 * alarming state, and a loading row must not claim it.
 */
export function useProfileSkillCounts(names: string[]): {
  counts: Record<string, number>;
  loading: boolean;
} {
  const results = useQueries({
    queries: names.map((name) => ({
      queryKey: ['skills', name] as const,
      queryFn: () => api.get<Skill[]>(`/api/skills?profile=${encodeURIComponent(name)}`),
      staleTime: 30_000,
    })),
  });

  const counts: Record<string, number> = {};
  results.forEach((r, i) => {
    const name = names[i];
    if (name && Array.isArray(r.data)) {
      counts[name] = r.data.filter((sk) => sk.enabled).length;
    }
  });

  return { counts, loading: results.some((r) => r.isLoading) };
}

export function useSetProfileModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, provider, model }: { name: string; provider?: string; model: string }) =>
      api.put(`/api/profiles/${encodeURIComponent(name)}/model`, { provider, model }),
    onSuccess: () => qc.invalidateQueries({ queryKey: profileKeys.all }),
  });
}
