/**
 * The Machine screen's readings, as pure functions over what Hermes answers.
 *
 * Every payload here comes from an endpoint whose shape is owned by a
 * different part of Hermes and has moved before, and every one of them is
 * read on a screen whose job is to say what is *wrong*. That is the worst
 * place for `data?.x.length` to throw (see the note in CLAUDE.md) and the
 * worst place for an unknown value to read as healthy — so each reader below
 * unpacks defensively, and an unrecognised state is shown as itself, never
 * folded into "connected".
 */

export type Tone = 'ok' | 'warn' | 'error' | 'off';

// --- messaging platforms ----------------------------------------------------

/**
 * One messaging platform as `/api/status` reports it in `gateway_platforms`.
 *
 * Written by the messaging gateway into `gateway_state.json`
 * (`gateway/status.py`, the platform half of `write_runtime_status`): `state`
 * plus `error_code` / `error_message`, `needs_attention`, `retrying_since` and
 * `updated_at`. Keys are platform ids; on a machine running one gateway per
 * profile the backend folds the others in as `<profile>:<platform>`.
 */
export interface PlatformRow {
  key: string;
  platform: string;
  /** Set only for a platform folded in from another profile's gateway. */
  profile: string | null;
  label: string;
  state: string;
  tone: Tone;
  /** Why it is not healthy, in Hermes' own words, when it says. */
  detail: string | null;
  /** ISO, or null. */
  updatedAt: string | null;
}

/** `_HEALTHY_PLATFORM_STATES` in `hermes_cli/web_routers/status.py`. */
const HEALTHY = new Set(['connected', 'running', 'ok']);
/** Moving, not failed: worth a look, not yet a restart. */
const TRANSIENT = new Set(['connecting', 'starting', 'retrying', 'reconnecting', 'draining']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** `telegram` → `Telegram`, `google_chat` → `Google Chat`. */
export function titleCase(id: string): string {
  return id
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

export function platformTone(state: string, needsAttention: boolean): Tone {
  const s = state.toLowerCase();
  if (s === 'disabled') return 'off';
  if (needsAttention) return 'error';
  if (HEALTHY.has(s)) return 'ok';
  if (TRANSIENT.has(s)) return 'warn';
  // Including an empty or unknown state: never assume healthy.
  return 'error';
}

export function platformRows(status: unknown): PlatformRow[] {
  const map = (status as { gateway_platforms?: unknown } | null)?.gateway_platforms;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];

  const rows: PlatformRow[] = [];
  for (const [key, raw] of Object.entries(map as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const colon = key.indexOf(':');
    const profile = colon > 0 ? key.slice(0, colon) : null;
    const platform = colon > 0 ? key.slice(colon + 1) : key;
    const state = str(entry.state) ?? str(entry.status) ?? 'unknown';
    const tone = platformTone(state, entry.needs_attention === true);
    const message = str(entry.error_message);
    const code = str(entry.error_code);
    const retrying = str(entry.retrying_since);
    rows.push({
      key,
      platform,
      profile,
      label: titleCase(platform),
      state,
      tone,
      detail: tone === 'ok' ? null : (message ?? (code ? `Error: ${code}` : retrying ? 'Retrying' : null)),
      updatedAt: str(entry.updated_at),
    });
  }
  // The broken ones first: they are what the section is opened for.
  const rank: Record<Tone, number> = { error: 0, warn: 1, ok: 2, off: 3 };
  return rows.sort((a, b) => rank[a.tone] - rank[b.tone] || a.key.localeCompare(b.key));
}

/** The messaging gateway itself, off the same payload. */
export function gatewaySummary(status: unknown): { running: boolean; state: string; tone: Tone; detail: string | null } {
  const s = (status ?? {}) as Record<string, unknown>;
  const running = s.gateway_running === true;
  const state = str(s.gateway_state) ?? (running ? 'running' : 'stopped');
  const stale = typeof s.gateway_heartbeat_stale_s === 'number' ? s.gateway_heartbeat_stale_s : null;
  let tone: Tone = running && (state === 'running' || state === 'draining') ? 'ok' : running ? 'warn' : 'error';
  let detail = str(s.gateway_exit_reason);
  /* A live PID with a stale heartbeat is a wedged loop, not a healthy gateway:
     Hermes reports it separately precisely so it is not mistaken for either. */
  if (running && stale !== null) {
    tone = 'warn';
    detail = `No heartbeat for ${Math.round(stale)}s — it may be stuck.`;
  }
  return { running, state, tone, detail };
}

// --- pairing ----------------------------------------------------------------

/** One pending request (`PairingStore.list_pending`), tagged with its store. */
export interface PairingRequest {
  /** Which profile's pairing store it is in; null for the backend's own. */
  profile: string | null;
  platform: string;
  /** Empty on a legacy pre-hash entry, which can only be approved by its code. */
  requestId: string;
  userId: string;
  userName: string;
  ageMinutes: number;
}

export interface PairedUser {
  profile: string | null;
  platform: string;
  userId: string;
  userName: string;
  approvedAt: number | null;
}

export function pairingFrom(
  body: unknown,
  profile: string | null,
): { pending: PairingRequest[]; approved: PairedUser[] } {
  const b = (body ?? {}) as { pending?: unknown; approved?: unknown };
  const pending = (Array.isArray(b.pending) ? b.pending : [])
    .map((raw) => (raw ?? {}) as Record<string, unknown>)
    .filter((r) => str(r.platform))
    .map((r) => ({
      profile,
      platform: str(r.platform)!,
      requestId: str(r.request_id) ?? '',
      userId: str(r.user_id) ?? String(r.user_id ?? ''),
      userName: str(r.user_name) ?? '',
      ageMinutes: typeof r.age_minutes === 'number' ? r.age_minutes : 0,
    }));
  const approved = (Array.isArray(b.approved) ? b.approved : [])
    .map((raw) => (raw ?? {}) as Record<string, unknown>)
    .filter((r) => str(r.platform) && (str(r.user_id) || typeof r.user_id === 'number'))
    .map((r) => ({
      profile,
      platform: str(r.platform)!,
      userId: str(r.user_id) ?? String(r.user_id),
      userName: str(r.user_name) ?? '',
      approvedAt: typeof r.approved_at === 'number' ? r.approved_at : null,
    }));
  return { pending, approved };
}

/**
 * Minutes left before a request lapses. `CODE_TTL_SECONDS` in
 * `gateway/pairing.py` is an hour; past that the store drops it unannounced.
 */
export function pairingMinutesLeft(ageMinutes: number): number {
  return Math.max(0, 60 - ageMinutes);
}

// --- background actions -----------------------------------------------------

/**
 * `GET /api/actions/<name>/status`: `{name, running, exit_code, pid, lines}`
 * (`hermes_cli/web_routers/actions.py`). Doctor, the audit, backup, prune and
 * the curator are all spawned this way and report only through this tail.
 */
export interface ActionStatus {
  name?: string;
  running?: boolean;
  exit_code?: number | null;
  lines?: string[];
}

export function actionOutcome(s: ActionStatus | null | undefined): {
  state: 'running' | 'ok' | 'failed' | 'unknown';
  label: string;
} {
  if (!s) return { state: 'running', label: 'Starting…' };
  if (s.running) return { state: 'running', label: 'Running…' };
  if (s.exit_code === 0) return { state: 'ok', label: 'Finished' };
  if (typeof s.exit_code === 'number') return { state: 'failed', label: `Failed (exit ${s.exit_code})` };
  return { state: 'unknown', label: 'Stopped — no exit code reported' };
}

// --- numbers ----------------------------------------------------------------

export function formatBytes(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatUptime(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** A percentage as a meter tone: the thresholds a person would act on. */
export function loadTone(percent: unknown): Tone {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 'off';
  if (percent >= 90) return 'error';
  if (percent >= 75) return 'warn';
  return 'ok';
}
