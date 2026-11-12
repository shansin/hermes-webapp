/**
 * Cron templates: the blueprint catalogue, the delivery targets, and creating
 * a job from one. See `lib/cronBlueprint.ts` for what the fields mean.
 *
 * Its own module rather than a section of `hub.ts`, which the activity pill
 * pulls into the boot bundle: this is only ever needed with the cron screen's
 * template sheet open. Its query keys stay out of the `['cron']` prefix on
 * purpose: that prefix holds the job list, which `CronTab` edits in place by
 * shape for its undo toasts, and every job write invalidates it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { cronUrl, type CronJob } from './hub';
import { normalizeBlueprints, normalizeTargets } from '../lib/cronBlueprint';

/**
 * The template catalogue for one profile — built-ins plus that profile's
 * plugin blueprints, with each `deliver` slot's options rewritten to the
 * platforms that profile has configured. Fetched only while the template
 * sheet is open. See `lib/cronBlueprint.ts` for what the fields mean.
 */
export function useCronBlueprints(profile: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['cron-templates', 'blueprints', profile],
    queryFn: async () => normalizeBlueprints(await api.get<unknown>(cronUrl('/api/cron/blueprints', profile))),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** `local` plus every configured platform, flagged when it has no home channel. */
export function useCronDeliveryTargets(profile: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['cron-templates', 'delivery-targets', profile],
    queryFn: async () => normalizeTargets(await api.get<unknown>(cronUrl('/api/cron/delivery-targets', profile))),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Create a job from a template. `profile` is required in practice: this route
 * alone defaults to `default` rather than the active profile.
 */
export function useInstantiateBlueprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      profile,
      body,
    }: {
      profile: string | null;
      body: { blueprint: string; values: Record<string, string> };
    }) => api.post<CronJob>(cronUrl('/api/cron/blueprints/instantiate', profile), body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cron'] }),
  });
}
