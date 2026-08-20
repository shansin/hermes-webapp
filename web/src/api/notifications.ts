/**
 * The cron notification feed.
 *
 * Served by the proxy itself, not Hermes, because the proxy is what stays
 * connected while the phone is asleep — see `server/src/push/feed.ts`.
 *
 * The path is `/push/feed` and deliberately not `/notifications`: that is the
 * route this data is *displayed* on, and the proxy would answer the browser's
 * navigation with JSON. See the note in `server/src/routers/notifications.ts`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface NotificationEntry {
  id: string;
  /** When the run ended. Epoch milliseconds, unlike the Hermes endpoints. */
  at: number;
  kind: string;
  /** The job's name. */
  title: string;
  /** The agent's own reply, where the run produced one. */
  body: string;
  /** Where this entry leads: the run's conversation. */
  url: string;
  jobId: string | null;
  jobName: string | null;
  runId: string | null;
  /** The run's `end_reason`, e.g. `cron_complete`. */
  status: string | null;
  failed: boolean;
  sessionId: string | null;
}

export const notificationKeys = { all: ['notifications'] as const };

export function useNotifications() {
  return useQuery({
    queryKey: notificationKeys.all,
    queryFn: () => api.get<{ entries: NotificationEntry[]; total: number }>('/push/feed'),
    select: (d) => d.entries,
    /**
     * The socket pushes an invalidation the moment a job finishes (see
     * `useEventToasts`), so this is only the fallback for the case that
     * motivated the whole feature: the app was closed while the job ran, and
     * the socket delivered nothing to invalidate on.
     */
    refetchInterval: 60_000,
  });
}

export function useClearNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<{ ok: boolean; removed: number }>('/push/feed'),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}
