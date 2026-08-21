import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface SessionRow {
  id: string;
  title: string | null;
  source: string | null;
  model: string | null;
  started_at: number;
  ended_at: number | null;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number | null;
  cwd: string | null;
  parent_session_id: string | null;
  /**
   * The list endpoint returns real booleans; the single-session endpoint
   * returns SQLite's 0/1. Read them through `isOn` rather than directly.
   */
  pinned: boolean | number | null;
  archived: boolean | number | null;
}

/** Normalize the two shapes the backend uses for these flags. */
export const isOn = (v: boolean | number | null | undefined): boolean =>
  v === true || v === 1;

/** What `GET /api/sessions?archived=` accepts. */
export type ArchivedFilter = 'exclude' | 'only' | 'include';

export interface SessionList {
  sessions: SessionRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface StoredMessage {
  id: number;
  role: string;
  content: string | null;
  tool_name: string | null;
  reasoning: string | null;
  timestamp: number;
}

export interface SearchHit {
  session_id: string;
  id: string;
  title: string | null;
  snippet: string;
  role: string;
  source: string | null;
  started_at: number;
  message_count?: number;
}

export const sessionKeys = {
  all: ['sessions'] as const,
  list: (limit: number, archived: ArchivedFilter = 'exclude') =>
    ['sessions', 'list', limit, archived] as const,
  detail: (id: string) => ['sessions', 'detail', id] as const,
  messages: (id: string) => ['sessions', 'messages', id] as const,
  search: (q: string) => ['sessions', 'search', q] as const,
  stats: ['sessions', 'stats'] as const,
};

/** The API rejects a limit above 100, so clamp rather than 422. */
export const MAX_SESSION_LIMIT = 100;

export function useSessions(limit = MAX_SESSION_LIMIT, archived: ArchivedFilter = 'exclude') {
  const capped = Math.min(limit, MAX_SESSION_LIMIT);
  return useQuery({
    queryKey: sessionKeys.list(capped, archived),
    queryFn: () => api.get<SessionList>(`/api/sessions?limit=${capped}&archived=${archived}`),
    staleTime: 15_000,
  });
}

/**
 * The stored title for one session.
 *
 * Resuming only yields a live title once the agent emits `session.title`, which
 * it does not do for a conversation that was already named — so the header
 * would otherwise sit on its "New chat" placeholder. Returns null when the
 * session has no title yet or the lookup fails; the caller keeps its fallback.
 */
export async function fetchSessionTitle(id: string): Promise<string | null> {
  try {
    const row = await api.get<Partial<SessionRow>>(`/api/sessions/${encodeURIComponent(id)}`);
    return row.title ?? null;
  } catch {
    return null;
  }
}

export function useSessionMessages(id: string | null) {
  return useQuery({
    queryKey: sessionKeys.messages(id ?? ''),
    queryFn: () =>
      api.get<{ messages: StoredMessage[] }>(`/api/sessions/${encodeURIComponent(id!)}/messages`),
    enabled: Boolean(id),
  });
}

/** Full-text search across stored sessions. Disabled below 2 characters. */
export function useSessionSearch(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: sessionKeys.search(query),
    queryFn: () =>
      api.get<{ results: SearchHit[] }>(`/api/sessions/search?q=${encodeURIComponent(query)}`),
    enabled: query.length >= 2,
    staleTime: 10_000,
  });
}

export function useSessionStats() {
  return useQuery({
    queryKey: sessionKeys.stats,
    queryFn: () =>
      api.get<{
        total: number;
        messages: number;
        by_source: Record<string, number>;
      }>('/api/sessions/stats'),
    staleTime: 60_000,
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/sessions/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: sessionKeys.all }),
  });
}

export function useBulkDeleteSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.post('/api/sessions/bulk-delete', { session_ids: ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: sessionKeys.all }),
  });
}

export function useRenameSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch(`/api/sessions/${encodeURIComponent(id)}`, { title }),
    onSuccess: () => qc.invalidateQueries({ queryKey: sessionKeys.all }),
  });
}

/**
 * Pin or archive a session.
 *
 * `PATCH /api/sessions/{id}` takes the same `SessionRename` body as a rename,
 * where a null field means "leave alone" — so one endpoint covers both flags
 * and either can be sent on its own.
 */
export function useSetSessionFlags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...flags }: { id: string; pinned?: boolean; archived?: boolean }) =>
      api.patch(`/api/sessions/${encodeURIComponent(id)}`, flags),
    onSuccess: () => qc.invalidateQueries({ queryKey: sessionKeys.all }),
  });
}

/** The full stored record, including the transcript — the JSON export. */
export async function exportSessionJson(id: string): Promise<unknown> {
  return api.get(`/api/sessions/${encodeURIComponent(id)}/export`);
}

export async function fetchStoredMessages(id: string): Promise<StoredMessage[]> {
  const res = await api.get<{ messages: StoredMessage[] }>(
    `/api/sessions/${encodeURIComponent(id)}/messages`,
  );
  return res.messages;
}
