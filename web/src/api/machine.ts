/**
 * The machine Hermes runs on: the messaging gateway and its platforms, who may
 * DM the bots, the background maintenance commands, and the host itself.
 *
 * All of these are routes the desktop dashboard already uses. Three things
 * about them are easy to get wrong from here:
 *
 * - **Most are per profile, and the destructive ones refuse an unnamed one.**
 *   `destructive_profile` (`hermes_cli/web_routers/_common.py`) answers 400 to
 *   a curator run, a checkpoint prune or an empty-session delete without
 *   `?profile=` as soon as the backend serves more than one profile — so every
 *   call below takes the profile, and the screen always sends a name.
 *   Pairing is per profile too: the gateway keeps one store per served
 *   profile, so a sender waiting on the `research` bot is invisible from an
 *   unscoped read.
 * - **The long ones answer at once and report elsewhere.** Doctor, the audit,
 *   backup, prune and the curator run are spawned in the background
 *   (`spawn_profile_action` → `{ok, pid, name}`), and their only output is a
 *   log tail at `/api/actions/<name>/status`. `useActionTail` polls it.
 * - **"Deny" is not a route.** The pairing store can approve one request,
 *   revoke one approved user, or clear *every* pending request
 *   (`/api/pairing/clear-pending`) — there is no single-request decline. A
 *   request nobody approves lapses after an hour on its own.
 */
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './client';
import { withProfile } from './hub';
import { pairingFrom, type ActionStatus, type PairedUser, type PairingRequest } from '../lib/machine';

export const machineKeys = {
  all: ['machine'] as const,
  status: ['machine', 'status'] as const,
  stats: ['machine', 'stats'] as const,
  pairing: (profile: string | null) => ['machine', 'pairing', profile] as const,
  curator: (profile: string | null) => ['machine', 'curator', profile] as const,
  checkpoints: (profile: string | null) => ['machine', 'checkpoints', profile] as const,
  emptySessions: (profile: string | null) => ['machine', 'empty-sessions', profile] as const,
  action: (name: string, run: number) => ['machine', 'action', name, run] as const,
};

/** The fan-out bound `ACTIVITY_PROFILE_CAP` uses, for the same reason. */
export const MACHINE_PROFILE_CAP = 8;

// --- gateway + platforms ----------------------------------------------------

/**
 * `/api/status`: version, the messaging gateway's state and every platform's
 * health in one read. Polled gently while the screen is open — a restart is
 * the moment it moves, and the screen says whether one is needed.
 */
export function useGatewayStatus() {
  return useQuery({
    queryKey: machineKeys.status,
    queryFn: () => api.get<Record<string, unknown>>('/api/status'),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}

// --- pairing ----------------------------------------------------------------

/**
 * Every profile's pairing store, merged.
 *
 * One request per profile, like the Activity fan-out, because the decision is
 * the same whichever bot was DM'd and a picker would hide the one waiting.
 * `null` in `profiles` is the backend's own store (an install too old to list
 * profiles).
 */
export function usePairing(profiles: (string | null)[]) {
  const results = useQueries({
    queries: profiles.slice(0, MACHINE_PROFILE_CAP).map((profile) => ({
      queryKey: machineKeys.pairing(profile),
      queryFn: async () => pairingFrom(await api.get<unknown>(withProfile('/api/pairing', profile)), profile),
      refetchInterval: 30_000,
    })),
  });
  const pending: PairingRequest[] = [];
  const approved: PairedUser[] = [];
  for (const r of results) {
    pending.push(...(r.data?.pending ?? []));
    approved.push(...(r.data?.approved ?? []));
  }
  return {
    pending,
    approved,
    isLoading: results.some((r) => r.isLoading),
    error: results.find((r) => r.error)?.error ?? null,
  };
}

export function useApprovePairing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (r: PairingRequest) =>
      api.post<{ ok: boolean; user?: { user_id?: string; user_name?: string } }>('/api/pairing/approve', {
        platform: r.platform,
        request_id: r.requestId,
        ...(r.profile ? { profile: r.profile } : {}),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['machine', 'pairing'] }),
  });
}

export function useRevokePairing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (u: PairedUser) =>
      api.post('/api/pairing/revoke', {
        platform: u.platform,
        user_id: u.userId,
        ...(u.profile ? { profile: u.profile } : {}),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['machine', 'pairing'] }),
  });
}

/** Clear every pending request in one profile's store — the only decline there is. */
export function useClearPendingPairing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (profile: string | null) =>
      api.post<{ ok: boolean; cleared?: number }>(withProfile('/api/pairing/clear-pending', profile)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['machine', 'pairing'] }),
  });
}

// --- curator ----------------------------------------------------------------

export interface CuratorStatus {
  enabled?: boolean;
  paused?: boolean;
  interval_hours?: number | null;
  /** ISO, null before its first run. */
  last_run_at?: string | null;
}

export function useCurator(profile: string | null) {
  return useQuery({
    queryKey: machineKeys.curator(profile),
    queryFn: () => api.get<CuratorStatus>(withProfile('/api/curator', profile)),
    staleTime: 30_000,
  });
}

export function useSetCuratorPaused() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ profile, paused }: { profile: string | null; paused: boolean }) =>
      api.put(withProfile('/api/curator/paused', profile), { paused }),
    onSettled: (_d, _e, v) => qc.invalidateQueries({ queryKey: machineKeys.curator(v.profile) }),
  });
}

// --- maintenance reads ------------------------------------------------------

/** `/api/ops/checkpoints`: `/rollback` shadow stores, so a prune can say what it frees. */
export function useCheckpointUsage(profile: string | null) {
  return useQuery({
    queryKey: machineKeys.checkpoints(profile),
    queryFn: () =>
      api.get<{ sessions?: { session: string; files: number; bytes: number }[]; total_bytes?: number }>(
        withProfile('/api/ops/checkpoints', profile),
      ),
    staleTime: 60_000,
  });
}

export function useEmptySessionCount(profile: string | null) {
  return useQuery({
    queryKey: machineKeys.emptySessions(profile),
    queryFn: () => api.get<{ count?: number }>(withProfile('/api/sessions/empty/count', profile)),
    staleTime: 30_000,
  });
}

/**
 * Delete every empty, ended, non-archived session — `DELETE
 * /api/sessions/empty` (`hermes_cli/web_routers/sessions.py`). Active and
 * archived sessions are skipped server-side. Invalidates the session lists too,
 * since rows just left them.
 */
export function useDeleteEmptySessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (profile: string | null) =>
      api.del<{ ok: boolean; deleted?: number }>(withProfile('/api/sessions/empty', profile)),
    onSettled: (_d, _e, profile) => {
      void qc.invalidateQueries({ queryKey: machineKeys.emptySessions(profile) });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

// --- spawned actions --------------------------------------------------------

/** The background operations, by the action name each one reports under. */
export const OPS = {
  doctor: { path: '/api/ops/doctor', action: 'doctor', label: 'Doctor' },
  audit: { path: '/api/ops/security-audit', action: 'security-audit', label: 'Security audit' },
  backup: { path: '/api/ops/backup', action: 'backup', label: 'Backup' },
  prune: { path: '/api/ops/checkpoints/prune', action: 'checkpoints-prune', label: 'Prune checkpoints' },
  curator: { path: '/api/curator/run', action: 'curator-run', label: 'Curator run' },
} as const;
export type OpId = keyof typeof OPS;

const TAIL_MS = 1200;
/** About five minutes, the desktop's own limit, before the tail stops polling. */
const TAIL_LIMIT_MS = 5 * 60_000;

interface Tail {
  op: OpId;
  profile: string | null;
  /** Distinguishes two runs of the same op, so the second is a fresh query. */
  run: number;
  startedAt: number;
  /** A backup's archive path, from the start response. */
  archive: string | null;
}

/**
 * Start one background operation and follow its log until it ends.
 *
 * One at a time, as on the desktop: the action names are fixed per op, and
 * the log of the last one is the only result any of them has.
 */
export function useActionTail() {
  const qc = useQueryClient();
  const [tail, setTail] = useState<Tail | null>(null);

  const start = useMutation({
    mutationFn: ({ op, profile }: { op: OpId; profile: string | null }) =>
      api.post<{ ok?: boolean; name?: string; archive?: string }>(
        withProfile(OPS[op].path, profile),
        // `BackupRequest` takes an optional `output`; an empty body lets Hermes
        // pick `<profile home>/backups/…zip`, which is what download can read.
        op === 'backup' ? {} : undefined,
      ),
    onSuccess: (res, { op, profile }) =>
      setTail({ op, profile, run: Date.now(), startedAt: Date.now(), archive: res.archive ?? null }),
  });

  const name = tail ? OPS[tail.op].action : '';
  const status = useQuery({
    queryKey: machineKeys.action(name, tail?.run ?? 0),
    queryFn: () =>
      api.get<ActionStatus>(`/api/actions/${encodeURIComponent(name)}/status?lines=200`),
    enabled: Boolean(tail),
    refetchInterval: (q) => {
      if (!tail || Date.now() - tail.startedAt > TAIL_LIMIT_MS) return false;
      return q.state.data?.running === false ? false : TAIL_MS;
    },
  });

  const running = start.isPending || (Boolean(tail) && status.data?.running !== false && !status.isError);

  /* What an op changed, re-read once it has finished: a prune frees the
     checkpoint store, a curator run moves its last-run stamp. */
  const finished = Boolean(tail) && status.data?.running === false;
  useEffect(() => {
    if (!finished || !tail) return;
    if (tail.op === 'prune') void qc.invalidateQueries({ queryKey: machineKeys.checkpoints(tail.profile) });
    if (tail.op === 'curator') void qc.invalidateQueries({ queryKey: machineKeys.curator(tail.profile) });
  }, [finished, tail, qc]);

  return { tail, status, start, running, clear: () => setTail(null) };
}

/** Same-origin download of a dashboard backup; the proxy adds the token. */
export function backupDownloadUrl(archive: string, profile: string | null): string {
  return withProfile(`/api/ops/backup/download?archive=${encodeURIComponent(archive)}`, profile);
}

// --- host -------------------------------------------------------------------

export interface SystemStats {
  hostname?: string;
  /** `_display_system_platform`: `Linux`, `6.8.0-…`, and the full platform string. */
  os?: string;
  os_release?: string;
  platform?: string;
  arch?: string;
  cpu_count?: number | null;
  cpu_percent?: number;
  load_avg?: number[];
  memory?: { total: number; used: number; available: number; percent: number };
  disk?: { total: number; used: number; free: number; percent: number };
  uptime_seconds?: number;
  process?: { pid: number; rss: number; create_time: number; num_threads: number };
  hermes_version?: string;
  psutil?: boolean;
}

/**
 * `/api/system/stats`, polled only while `active` — the section is on screen
 * and the tab is visible (TanStack never refetches a hidden tab's interval).
 * Each call samples CPU for 100ms server-side, so it is not free.
 */
export function useSystemStats(active: boolean) {
  return useQuery({
    queryKey: machineKeys.stats,
    queryFn: () => api.get<SystemStats>('/api/system/stats'),
    enabled: active,
    refetchInterval: active ? 5_000 : false,
    staleTime: 4_000,
  });
}
