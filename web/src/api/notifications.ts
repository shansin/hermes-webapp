/**
 * The updates feed.
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
  /** When it happened. Epoch milliseconds, unlike the Hermes endpoints. */
  at: number;
  kind: string;
  /** Which of the three writers produced this row — see `push/updates.ts`. */
  source: 'cron' | 'agent' | 'system';
  /** How the row reads. Broader than `failed`, which is cron-specific. */
  severity: 'ok' | 'info' | 'warn' | 'error';
  /** The job's name, or who is speaking for the other two sources. */
  title: string;
  /** The agent's own reply, where the run produced one. */
  body: string;
  /** Where this entry leads: the run's conversation, or Settings. */
  url: string;
  jobId: string | null;
  jobName: string | null;
  runId: string | null;
  /** The run's `end_reason`, e.g. `cron_complete`. */
  status: string | null;
  failed: boolean;
  sessionId: string | null;
}

interface FeedResponse {
  entries: NotificationEntry[];
  total: number;
  /** Entries newer than the last time the screen was opened. */
  unread: number;
  lastReadAt: number;
}

export const notificationKeys = { all: ['notifications'] as const };

/**
 * The feed itself, and the badge, from one query.
 *
 * Deliberately one request rather than a separate count endpoint: the badge is
 * live on every screen, so a second poll would double the traffic to say
 * something the first response already contains.
 */
function useFeed() {
  return useQuery({
    queryKey: notificationKeys.all,
    queryFn: () => api.get<FeedResponse>('/push/feed'),
    /**
     * The socket pushes an invalidation the moment a job finishes (see
     * `useEventToasts`), so this is only the fallback for the case that
     * motivated the whole feature: the app was closed while the job ran, and
     * the socket delivered nothing to invalidate on.
     */
    refetchInterval: 60_000,
  });
}

export function useNotifications() {
  const q = useFeed();
  return { ...q, data: q.data?.entries };
}

/**
 * Just the count, for the badge.
 *
 * Shares the query above, so mounting this in the app shell costs no extra
 * request — React Query dedupes on the key.
 */
export function useUnreadCount(): number {
  return useFeed().data?.unread ?? 0;
}

/**
 * Mark everything currently in the feed as read.
 *
 * Called by the screen on mount. The server watermarks on the newest entry's
 * timestamp rather than the clock, so a run that finishes in the same second
 * the screen opens still counts as unread.
 */
export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean; unread: number }>('/push/feed/read'),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

export function useClearNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<{ ok: boolean; removed: number }>('/push/feed'),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}
