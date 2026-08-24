import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
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
   * Which profile's store this row came out of.
   *
   * Present on every row the backend returns (alongside `profile_name` and
   * `is_default_profile`), and the thing that has to travel with a session
   * anywhere it is opened, deleted or flagged — those endpoints resolve the id
   * inside one profile's `state.db` and answer 404 for a session that is
   * simply somewhere else.
   */
  profile?: string | null;
  profile_name?: string | null;
  is_default_profile?: boolean;
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

/**
 * Sessions are stored **per profile**, and every endpoint here addresses one
 * profile at a time.
 *
 * Omitting `profile` addresses whichever profile is active, which is why this
 * app went years without noticing: with one profile that is the only answer.
 * With two it is a silent filter — a kanban task running as `research` writes
 * its session into that profile's `state.db`, and a list, a detail read or a
 * resume that does not name the profile simply cannot see it. The detail route
 * does not even fail loudly: it answers **404 Session not found** for a session
 * that plainly exists.
 *
 * So `profile` is part of every key below. A cached list belonging to one
 * profile must never be handed to a screen asking about another.
 *
 * Unlike cron, there is no `profile=all`; the backend rejects it with
 * "Profile 'all' does not exist". Merging profiles is therefore N requests
 * against N paginated stores whose offsets do not align, which is why the
 * Sessions screen picks a profile rather than merging them.
 */
export const sessionKeys = {
  all: ['sessions'] as const,
  list: (limit: number, archived: ArchivedFilter = 'exclude', profile?: string | null) =>
    ['sessions', 'list', limit, archived, profile ?? null] as const,
  detail: (id: string, profile?: string | null) =>
    ['sessions', 'detail', id, profile ?? null] as const,
  messages: (id: string, profile?: string | null) =>
    ['sessions', 'messages', id, profile ?? null] as const,
  search: (q: string, profile?: string | null) =>
    ['sessions', 'search', q, profile ?? null] as const,
  stats: ['sessions', 'stats'] as const,
};

/**
 * Add `?profile=` to a session URL, or leave it alone.
 *
 * Same shape as `cronUrl` in `api/hub.ts`, and for the same reason: the
 * parameter is optional in a way that quietly changes which store is read, so
 * it is a named function with a test rather than a template string repeated at
 * eight call sites.
 */
export function sessionUrl(path: string, profile?: string | null): string {
  if (!profile) return path;
  return `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}`;
}

/** The API rejects a limit above 100, so clamp rather than 422. */
export const MAX_SESSION_LIMIT = 100;

export function useSessions(
  limit = MAX_SESSION_LIMIT,
  archived: ArchivedFilter = 'exclude',
  profile?: string | null,
) {
  const capped = Math.min(limit, MAX_SESSION_LIMIT);
  return useQuery({
    queryKey: sessionKeys.list(capped, archived, profile),
    queryFn: () =>
      api.get<SessionList>(
        sessionUrl(`/api/sessions?limit=${capped}&archived=${archived}`, profile),
      ),
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
 * How many profiles the activity fan-out will poll.
 *
 * Three profiles on a 5s poll while something is running is nothing. Twenty
 * would be twenty requests every five seconds, and the pane is a glance at
 * what is in flight, not an audit. Past the cap the extra profiles are simply
 * not polled and the caller is told, which is better than a screen that
 * silently gets slower as profiles accumulate.
 */
export const ACTIVITY_PROFILE_CAP = 6;

/**
 * Recent sessions across every profile, merged.
 *
 * The Activity pane's other two sources already span profiles — the kanban
 * board is one shared store, and the cron list endpoint defaults to
 * `profile=all` — so sessions were the one lane showing only the active
 * profile. The result was a screen that would list a kanban card assigned to
 * `research` while hiding the conversation that card was running in.
 *
 * A picker would be wrong here, unlike on the sessions screen: this is a short
 * unpaginated list of live work, and the point is to see everything at once.
 * So it fans out and merges, matching what the other two sources do.
 *
 * Each profile's query keeps its own key and its own refetch interval, so a
 * profile with nothing running settles to the slow poll on its own rather than
 * being dragged along by a busy one.
 */
export function useActiveSessionsAcrossProfiles(
  profiles: readonly string[],
  limit = 25,
  enabled = true,
): { sessions: SessionRow[]; isLoading: boolean; error: unknown; truncated: number } {
  const capped = Math.min(limit, MAX_SESSION_LIMIT);
  /**
   * An empty profile list means "we do not know them yet" — the profile query
   * has not landed. Query once with no profile, which addresses the active
   * one: the same request this made before fanning out, and correct whatever
   * the active profile happens to be called. Guessing `default` would poll the
   * wrong store for anyone whose active profile is not it.
   */
  const polled: (string | null)[] = profiles.length
    ? profiles.slice(0, ACTIVITY_PROFILE_CAP)
    : [null];

  const results = useQueries({
    queries: polled.map((profile) => ({
      queryKey: ['sessions', 'recent', capped, profile ?? null] as const,
      enabled,
      queryFn: () =>
        api.get<SessionList>(
          sessionUrl(`/api/sessions?limit=${capped}&order=recent&archived=exclude`, profile),
        ),
      staleTime: 2_000,
      refetchInterval: (q: { state: { data?: SessionList } }) =>
        (q.state.data?.sessions ?? []).some((s) => s.is_active && !s.ended_at) ? 5_000 : 30_000,
    })),
  });

  const sessions: SessionRow[] = [];
  for (const r of results) {
    for (const row of r.data?.sessions ?? []) sessions.push(row);
  }

  return {
    sessions,
    // Loading only while nothing has arrived yet: one slow profile must not
    // hold back rows that are already in hand.
    isLoading: results.length > 0 && results.every((r) => r.isLoading),
    /* The first failure, and only while nothing succeeded. One profile's store
       being unreadable should not blank a pane that can still report what the
       others are doing — but a total failure has to say so rather than showing
       an empty list that reads as "nothing is running". */
    error: results.every((r) => r.isError) ? results.find((r) => r.error)?.error : undefined,
    truncated: Math.max(0, profiles.length - polled.length),
  };
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
/**
 * @param profile required for a session belonging to any profile but the
 *   active one. Without it this route answers 404 for a session that exists,
 *   which reads as "deleted" rather than "you are looking in the wrong store".
 */
export function useSessionRow(id: string | null, profile?: string | null) {
  return useQuery({
    queryKey: sessionKeys.detail(id ?? '', profile),
    enabled: Boolean(id),
    staleTime: 30_000,
    queryFn: () =>
      api.get<SessionRow>(sessionUrl(`/api/sessions/${encodeURIComponent(id!)}`, profile)),
  });
}

export function useSessionMessages(id: string | null, profile?: string | null) {
  return useQuery({
    queryKey: sessionKeys.messages(id ?? '', profile),
    queryFn: () =>
      api.get<{ messages: StoredMessage[] }>(
        sessionUrl(`/api/sessions/${encodeURIComponent(id!)}/messages`, profile),
      ),
    enabled: Boolean(id),
  });
}

/** Full-text search across stored sessions. Disabled below 2 characters. */
export function useSessionSearch(q: string, profile?: string | null) {
  const query = q.trim();
  return useQuery({
    queryKey: sessionKeys.search(query, profile),
    queryFn: () =>
      api.get<{ results: SearchHit[] }>(
        sessionUrl(`/api/sessions/search?q=${encodeURIComponent(query)}`, profile),
      ),
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

/** `profile` deletes out of another profile's `state.db`; omit for the active one. */
export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, profile }: { id: string; profile?: string | null }) =>
      api.del(sessionUrl(`/api/sessions/${encodeURIComponent(id)}`, profile)),
    onSuccess: () => qc.invalidateQueries({ queryKey: sessionKeys.all }),
  });
}

/**
 * Bulk delete.
 *
 * The field is `ids`. It was `session_ids` here, which the backend rejects
 * with a 422 — so selecting several sessions and deleting them has never
 * worked, and reported itself as a generic failure rather than as a
 * malformed request. `profile` rides in the body for this one, not the query.
 */
export function useBulkDeleteSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, profile }: { ids: string[]; profile?: string | null }) =>
      api.post('/api/sessions/bulk-delete', { ids, ...(profile ? { profile } : {}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: sessionKeys.all }),
  });
}

export function useRenameSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title, profile }: { id: string; title: string; profile?: string | null }) =>
      api.patch(`/api/sessions/${encodeURIComponent(id)}`, {
        title,
        ...(profile ? { profile } : {}),
      }),
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
    mutationFn: ({
      id,
      profile,
      ...flags
    }: {
      id: string;
      pinned?: boolean;
      archived?: boolean;
      profile?: string | null;
    }) =>
      api.patch(`/api/sessions/${encodeURIComponent(id)}`, {
        ...flags,
        // In the body for PATCH, unlike DELETE where it is a query parameter.
        ...(profile ? { profile } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: sessionKeys.all }),
  });
}

/** The full stored record, including the transcript — the JSON export. */
export async function exportSessionJson(id: string): Promise<unknown> {
  return api.get(`/api/sessions/${encodeURIComponent(id)}/export`);
}

export async function fetchStoredMessages(
  id: string,
  profile?: string | null,
): Promise<StoredMessage[]> {
  const res = await api.get<{ messages: StoredMessage[] }>(
    sessionUrl(`/api/sessions/${encodeURIComponent(id)}/messages`, profile),
  );
  return res.messages;
}
