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
}

interface SessionList {
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
  list: (limit: number) => ['sessions', 'list', limit] as const,
  detail: (id: string) => ['sessions', 'detail', id] as const,
  messages: (id: string) => ['sessions', 'messages', id] as const,
  search: (q: string) => ['sessions', 'search', q] as const,
  stats: ['sessions', 'stats'] as const,
};

/** The API rejects a limit above 100, so clamp rather than 422. */
export const MAX_SESSION_LIMIT = 100;

export function useSessions(limit = MAX_SESSION_LIMIT) {
  const capped = Math.min(limit, MAX_SESSION_LIMIT);
  return useQuery({
    queryKey: sessionKeys.list(capped),
    queryFn: () => api.get<SessionList>(`/api/sessions?limit=${capped}`),
    staleTime: 15_000,
  });
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
