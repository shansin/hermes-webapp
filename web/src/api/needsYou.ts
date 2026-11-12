/**
 * The three reads behind Activity's "Needs you" lane that no other screen
 * makes: which live sessions are blocked on a person, which messaging users
 * are asking to pair, and how many kanban cards sit in Blocked or Review.
 *
 * Each is chosen for what it costs on a screen that is not open, because the
 * count drives a badge on the hamburger — mounted on every screen — and not
 * only the pane.
 *
 * - **Waiting sessions come from `session.active_list`, over the socket.**
 *   There is no REST equivalent: it enumerates the gateway's in-process
 *   registry, and `status` is `_session_live_status` collapsing a pending
 *   approval, clarify or plain input into one value, `waiting`
 *   (`tui_gateway/server.py`). The proxy's push sweep reads the same call for
 *   the same reason (`server/src/push/sessions.ts`). Its rows carry **no
 *   profile**, and `id` is the 8-hex live handle — `session_key` is the stored
 *   id that `/chat?session=` takes. Like the delegation lane, the rows are
 *   *absent* rather than stale while the socket is down, so the query is
 *   disabled then instead of reporting "nobody is waiting".
 *
 *   `session.resume` / `session.activate` carry richer state (which of the
 *   three it is waiting on) and must never be called from here: both bind the
 *   session's transport to the caller, and the pane would steal the session
 *   from whichever device is holding it.
 *
 * - **Pairing requests are per profile.** `GET /api/pairing` answers from the
 *   pairing store of the profile named in `?profile=` (`default` maps to the
 *   global store; omitted means the dashboard's own), each pending entry being
 *   `{platform, request_id, user_id, user_name, age_minutes}` — codes are never
 *   returned (`hermes_cli/web_routers/ops.py`, `gateway/pairing.py`
 *   `list_pending`). So it fans out the way the session lane does, at a slow
 *   rate: a pairing request is a person on Telegram waiting minutes, not an
 *   agent waiting seconds.
 *
 * - **The badge reads `/stats`, not the board.** The drawer deliberately does
 *   not poll the board (a full card payload) from every screen; the kanban
 *   plugin's `/stats` is a `GROUP BY status` count over the same non-archived
 *   tasks and costs a few bytes. The pane itself reads the board it already
 *   polls, because it needs the cards.
 *
 * Every interval here pauses while the document is hidden — React Query's
 * default (`refetchIntervalInBackground: false`) — so a phone in a pocket asks
 * nothing.
 */
import { useQueries, useQuery } from '@tanstack/react-query';
import * as z from 'zod/mini';
import { api } from './client';
import { ACTIVITY_PROFILE_CAP } from './sessions';
import { hermes, CONTROL_TIMEOUT_MS } from '../ws/client';
import { useUi } from '../store/ui';

/** One row of `session.active_list` — `_session_live_item` on the backend. */
export const LiveSessionSchema = z.looseObject({
  /** The gateway's live handle. Means nothing to REST or to a chat link. */
  id: z.string(),
  /** The stored id — what `/chat?session=` and every REST route take. */
  session_key: z.nullish(z.string()),
  /** `idle` | `working` | `starting` | `waiting`. */
  status: z.nullish(z.string()),
  title: z.nullish(z.string()),
  /** Epoch seconds. */
  last_active: z.nullish(z.number()),
  started_at: z.nullish(z.number()),
  message_count: z.nullish(z.number()),
});
export type LiveSession = z.infer<typeof LiveSessionSchema>;

/**
 * Parse row by row rather than as one array: a single odd row must cost that
 * row, not the whole lane — a throw here would read as "nobody is waiting".
 */
export function parseLiveSessions(raw: unknown): LiveSession[] {
  const rows = (raw as { sessions?: unknown } | null | undefined)?.sessions;
  if (!Array.isArray(rows)) return [];
  const out: LiveSession[] = [];
  for (const row of rows) {
    const parsed = LiveSessionSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export const LIVE_SESSIONS_KEY = ['live-sessions'] as const;

/**
 * How often to ask. One small call on the gateway's long-handler pool (the
 * desktop app polls it too); events that end or start a turn invalidate it
 * early — see `invalidateActivity`.
 */
const LIVE_POLL_MS = 20_000;

export function useLiveSessions(enabled = true): { data: LiveSession[] | undefined } {
  /* The store, not `hermes.state`, so this re-renders when the socket returns. */
  const socketLive = useUi((s) => s.connection) === 'open';
  const q = useQuery({
    queryKey: LIVE_SESSIONS_KEY,
    queryFn: async () =>
      parseLiveSessions(
        await hermes.call('session.active_list', {}, { timeoutMs: CONTROL_TIMEOUT_MS }),
      ),
    enabled: enabled && socketLive,
    refetchInterval: LIVE_POLL_MS,
    staleTime: 5_000,
    retry: false,
  });
  /* A disabled query keeps its last answer. With the socket down that answer
     is the registry as it was, and an approval answered elsewhere since would
     go on counting — so the rows are withheld rather than served stale. */
  return { data: socketLive ? q.data : undefined };
}

/** A pending pairing request, with the profile whose store it came from. */
export interface PendingPairing {
  platform: string;
  requestId: string;
  user: string;
  ageMinutes: number | null;
  /** Null when the profile list had not landed and the default store was read. */
  profile: string | null;
}

const PendingSchema = z.looseObject({
  platform: z.nullish(z.string()),
  request_id: z.nullish(z.string()),
  user_id: z.nullish(z.union([z.string(), z.number()])),
  user_name: z.nullish(z.string()),
  age_minutes: z.nullish(z.number()),
});

export function parsePendingPairing(raw: unknown, profile: string | null): PendingPairing[] {
  const rows = (raw as { pending?: unknown } | null | undefined)?.pending;
  if (!Array.isArray(rows)) return [];
  const out: PendingPairing[] = [];
  for (const row of rows) {
    const parsed = PendingSchema.safeParse(row);
    if (!parsed.success) continue;
    const p = parsed.data;
    const user = (p.user_name ?? '').trim() || String(p.user_id ?? '').trim();
    out.push({
      platform: (p.platform ?? '').trim() || 'messaging',
      requestId: p.request_id ?? '',
      user: user || 'Someone',
      ageMinutes: p.age_minutes ?? null,
      profile,
    });
  }
  return out;
}

const PAIRING_POLL_MS = 120_000;

/**
 * Under the Machine screen's `['machine', 'pairing']` prefix on purpose: its
 * approve, revoke and clear mutations invalidate that prefix, so answering a
 * request there clears the badge here at once rather than at the next poll.
 * The trailing segment keeps it a different entry from Machine's own
 * `['machine', 'pairing', profile]`, which caches a different shape.
 */
export const pairingKey = (profile: string | null) =>
  ['machine', 'pairing', profile, 'pending'] as const;

/**
 * Pending pairing requests across profiles, merged.
 *
 * A profile whose store cannot be read (an older backend without the route, a
 * profile deleted since the list was fetched) contributes nothing rather than
 * failing the lane — the answer this feeds is a count, and "unknown" and
 * "none" have to collapse to the same thing there.
 */
export function usePendingPairing(profiles: readonly string[], enabled = true): PendingPairing[] {
  const polled: (string | null)[] = profiles.length
    ? profiles.slice(0, ACTIVITY_PROFILE_CAP)
    : [null];
  const results = useQueries({
    queries: polled.map((profile) => ({
      queryKey: pairingKey(profile),
      enabled,
      queryFn: async () =>
        parsePendingPairing(
          await api.get<unknown>(
            profile ? `/api/pairing?profile=${encodeURIComponent(profile)}` : '/api/pairing',
          ),
          profile,
        ),
      refetchInterval: PAIRING_POLL_MS,
      staleTime: 60_000,
      retry: false,
    })),
  });
  const out: PendingPairing[] = [];
  for (const r of results) for (const p of r.data ?? []) out.push(p);
  return out;
}

/**
 * Per-status card counts for the server's current board.
 *
 * Keyed as `adminKeys.stats(null)` in `api/kanbanAdmin.ts` builds it, so the
 * Board health sheet and this badge share one cache entry — same endpoint,
 * same shape. Not imported from there because that module is lazy and this
 * one is in the boot graph.
 */
export interface BoardStatusCounts {
  by_status?: Record<string, number> | null;
}

const STATS_POLL_MS = 60_000;

export function useBoardStatusCounts(enabled = true) {
  return useQuery({
    queryKey: ['kanban', null, 'stats'] as const,
    queryFn: () => api.get<BoardStatusCounts>('/api/plugins/kanban/stats'),
    enabled,
    refetchInterval: STATS_POLL_MS,
    staleTime: 15_000,
    retry: false,
  });
}
