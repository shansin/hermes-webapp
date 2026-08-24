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
  /**
   * Present on every list row despite not being in the endpoint's docstring:
   * `compact_rows` drops only the prompt blobs, so the rest of the `sessions`
   * table comes through. Optional here because an older backend may not have
   * the column, and the Usage screen sums these.
   */
  api_call_count?: number | null;
  cache_read_tokens?: number | null;
  reasoning_tokens?: number | null;
  /** Why the session ended — `ws_orphan_reap`, `agent_close`, `cron_complete`. */
  end_reason?: string | null;
  /**
   * Whether Hermes considers this session to have work in flight.
   *
   * Computed backend-side as `ended_at is None and (now - last_active) < 300`,
   * so it expires on its own and can be up to five minutes behind reality.
   * Optional because an older backend omits it — `lib/activity.ts` treats a
   * missing flag as "not running" rather than guessing.
   */
  is_active?: boolean | null;
  last_activity_at?: number | null;
  /**
   * The live progress line, and the only place a running `delegate_task` is
   * visible outside the process that owns it: "delegate_task: subagent running
   * execute_code (iteration 5/250)". See `lib/activity.ts`.
   */
  last_activity_description?: string | null;
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
 * Sessions ordered by latest activity, for the Activity pane.
 *
 * `order=recent` is the point: a session with work in flight is by definition
 * recently active, so it lands on the first page. The endpoint has no
 * "active only" filter and caps `limit` at 100 (see
 * `hermes_cli/web_routers/sessions.py`), so a small recent page is both
 * cheaper and more reliable than a large one ordered by creation.
 *
 * `refetchInterval` is a function of the data: once nothing is active there is
 * nothing to watch, and an idle phone should not poll for ever. A running turn
 * updates its progress line every few seconds, so 5s is what makes the
 * iteration counter move.
 */
export function useActiveSessions(limit = 25, enabled = true) {
  const capped = Math.min(limit, MAX_SESSION_LIMIT);
  return useQuery({
    queryKey: ['sessions', 'recent', capped],
    enabled,
    queryFn: () => api.get<SessionList>(`/api/sessions?limit=${capped}&order=recent&archived=exclude`),
    staleTime: 2_000,
    refetchInterval: (q) =>
      (q.state.data?.sessions ?? []).some((s) => s.is_active && !s.ended_at) ? 5_000 : 30_000,
  });
}

/**
 * How many pages of 100 the window fetch will walk before it gives up.
 *
 * A busy install can open more sessions in a day than any single page holds,
 * and the endpoint caps `limit` at 100 — so the window has to be paged. The
 * ceiling exists because this runs on a phone: five round trips is already
 * more than a chart is worth, and the screen says when it stopped early rather
 * than quietly drawing a partial day.
 */
export const MAX_WINDOW_PAGES = 5;

export interface SessionWindow {
  rows: SessionRow[];
  /** True when the page ceiling was hit before reaching `since`. */
  truncated: boolean;
}

/**
 * Every session started since `since` (epoch seconds), newest first.
 *
 * Ordered by creation, not activity, because the window is defined by
 * `started_at` and `order=recent` would page by a different clock and walk past
 * the boundary in the wrong order. Archived sessions are included: the
 * auto-archive sweep is about what clutters a list, and hiding them here would
 * quietly delete usage from the chart.
 *
 * The rows are conversations — sub-agent runs and compression continuations are
 * filtered out upstream and cannot be asked for. See `unattributedShare`, which
 * is how the screen reports what that leaves out.
 */
/**
 * The paging itself, separated from the hook so it can be driven directly.
 *
 * `get` is injectable for that reason alone — everything in the app passes the
 * default.
 */
export async function fetchSessionsSince(
  since: number,
  get: (path: string) => Promise<SessionList> = (path) => api.get<SessionList>(path),
): Promise<SessionWindow> {
  const rows: SessionRow[] = [];

  for (let page = 0; page < MAX_WINDOW_PAGES; page++) {
    const res = await get(
      `/api/sessions?limit=${MAX_SESSION_LIMIT}&offset=${page * MAX_SESSION_LIMIT}&archived=include`,
    );
    const batch = res.sessions ?? [];
    rows.push(...batch.filter((s) => s.started_at >= since));

    // Stop as soon as a page runs past the boundary, or the list ends.
    if (batch.length < MAX_SESSION_LIMIT || batch.some((s) => s.started_at < since)) {
      return { rows, truncated: false };
    }
  }

  // Fell out of the loop: every page was full and still inside the window.
  return { rows, truncated: true };
}

export function useSessionsSince(since: number, enabled = true) {
  return useQuery({
    queryKey: ['sessions', 'since', since],
    enabled,
    staleTime: 30_000,
    queryFn: () => fetchSessionsSince(since),
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

/**
 * One stored session row.
 *
 * The list screen already holds these, but the chat screen does not: it knows a
 * session by its two ids and whatever the gateway told it, and `pinned`,
 * `archived` and `started_at` are only on the stored record. `SessionActionsSheet`
 * needs all three, so the conversation you are *in* can offer the same verbs as
 * a row in the list.
 */
export function useSessionRow(id: string | null) {
  return useQuery({
    queryKey: sessionKeys.detail(id ?? ''),
    enabled: Boolean(id),
    staleTime: 30_000,
    queryFn: () => api.get<SessionRow>(`/api/sessions/${encodeURIComponent(id!)}`),
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
