/**
 * Telling you a stranger is knocking.
 *
 * A messaging platform under pairing (Telegram, Discord, …) does not answer a
 * sender it has never seen. It DMs them a one-time code, files a *pending
 * request* in that profile's pairing store, and waits for an operator to
 * approve it — for an hour (`CODE_TTL_SECONDS` in `gateway/pairing.py`), after
 * which the request silently expires and the person on the other end is left
 * talking to a bot that never replies. Nothing announced that a request had
 * arrived; the only way to find one was to go and look, which nobody does
 * unprompted, so in practice the hour always ran out.
 *
 * ## Why a sweep, plus a signal
 *
 * The store is files on disk written by the *messaging gateway*, a different
 * process from the backend this proxy talks to, so the only events are the
 * backend's change watcher noticing the files move: `pairing.changed`, one of
 * the session-less "go and look" broadcasts in `_CHANGE_WATCHES`
 * (`tui_gateway/change_watcher.py`), which reaches the push listener the way
 * `cron.changed` does. It carries no payload — so, exactly like that one, it
 * is a request to read `GET /api/pairing` rather than news in itself.
 *
 * The signal alone is not enough for the reason `startCronSweep` gives: it is
 * a stream, so a request filed while the proxy was restarting is never
 * signalled to it. A gentle timer (a minute — the request lives for sixty)
 * catches that up.
 *
 * ## New requests, not pending ones
 *
 * The news is a request *appearing*. A request still pending on the next pass
 * is the same request, and a pass that reported what it saw would re-announce
 * it every minute for an hour. So each request is remembered by a watermark in
 * `feed.ts`, keyed on its server-side `request_id` (a legacy pre-hash entry
 * has none; the sender's id stands in).
 *
 * That collides with the rule every other sweep here follows — "first sight is
 * silent" — because for a pairing request first sight is *exactly* the news.
 * The two are reconciled per profile instead of per row: the first pass that
 * reads a profile's store adopts whatever is pending there silently (that is
 * what makes installing the app, or a store this proxy has never read, quiet),
 * and is recorded as a `seeded` watermark; from then on an unseen request in
 * that profile is announced. A pass that could not read a profile neither
 * seeds nor prunes it, for the reason `kanban.ts` sets out — forgetting on a
 * failed read re-announces everything on recovery.
 *
 * ## Per profile
 *
 * The gateway keeps one pairing store per served profile
 * (`_pairing_store` in `hermes_cli/web_routers/ops.py`), and an unscoped read
 * answers for the backend's own profile only. A sender pairing with the
 * `research` bot is invisible from `default`, so every profile is read.
 *
 * The banner deep-links to `/machine#pairing`, where the request can be
 * approved; the row in the updates feed is the record that survives the
 * banner being swiped away.
 */
import { clearToken, getToken, resolveToken, upstreamHttp, upstreamHost } from '../config.js';
import { log } from '../log.js';
import { appendEntry, getWatermark, pruneWatermarks, setWatermark } from './feed.js';
import { sendPush } from './send.js';
import { listSubscriptions } from './store.js';

/**
 * How often to look without being asked.
 *
 * A request lives for an hour, so a minute's latency costs nothing — this is
 * the backstop for a `pairing.changed` the listener was not connected to hear.
 */
const SWEEP_MS = 60_000;

/** How long after a `pairing.changed` to look — the watcher ticks every 2s. */
const SETTLE_MS = 1500;

/** The same bound `push/sessions.ts` puts on a per-profile fan-out. */
const PROFILE_CAP = 8;

/** Watermark prefixes, so neither prune can touch another module's keys. */
const REQ = 'pairing:req:';
const SEEDED = 'pairing:seeded:';

let sweep: ReturnType<typeof setInterval> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let dirty = false;

interface PendingRow {
  platform?: unknown;
  request_id?: unknown;
  user_id?: unknown;
  user_name?: unknown;
}

async function gatewayGet<T>(path: string): Promise<T | null> {
  const token = getToken() || (await resolveToken());
  try {
    const res = await fetch(upstreamHttp + path, {
      headers: { host: upstreamHost, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) {
      // A scraped token goes stale across a Hermes restart; drop it so the
      // next call re-scrapes rather than failing forever.
      clearToken();
      return null;
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** `telegram` → `Telegram`, `google_chat` → `Google Chat`, as Hermes titles them. */
export function platformLabel(platform: string): string {
  return platform
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Which profiles to read. `null` only when the profile list itself could not
 * be read — the pass is skipped rather than guessed at, because a store read
 * under the wrong key would re-announce every request when the right key came
 * back. An empty list (an older Hermes) is the backend's own profile.
 */
async function profileNames(): Promise<(string | null)[] | null> {
  const body = await gatewayGet<{ profiles?: { name?: unknown }[] }>('/api/profiles');
  if (!body) return null;
  const names = (body.profiles ?? [])
    .map((p) => str(p.name))
    .filter((n): n is string => n !== null)
    .slice(0, PROFILE_CAP);
  return names.length ? names : [null];
}

/** Ask for a pass. Cheap to call, and safe to call repeatedly. */
export function schedulePairingSweep(delayMs = SETTLE_MS): void {
  if (running) {
    dirty = true;
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void reconcilePairing();
  }, delayMs);
  // A pending look at the pairing store is never a reason to keep the process up.
  timer.unref?.();
}

/**
 * Start sweeping. The first pass is immediate, as in `startKanbanSweep`: it is
 * the seeding pass, and getting it out of the way at boot means the first real
 * request is reported on the signal rather than one interval late.
 */
export function startPairingSweep(): void {
  if (sweep) return;
  sweep = setInterval(() => schedulePairingSweep(0), SWEEP_MS);
  sweep.unref?.();
  schedulePairingSweep();
}

export function stopPairingSweep(): void {
  if (sweep) clearInterval(sweep);
  sweep = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** One pass. Exported so a test can drive it without faking the settle timer. */
export async function reconcilePairing(): Promise<void> {
  running = true;
  try {
    const profiles = await profileNames();
    if (!profiles) return;
    const multi = profiles.length > 1;

    for (const profile of profiles) {
      const path = profile ? `/api/pairing?profile=${encodeURIComponent(profile)}` : '/api/pairing';
      const body = await gatewayGet<{ pending?: unknown }>(path);
      // Unreadable: keep this profile's watermarks and its seeding exactly as
      // they were, so recovery is silent.
      if (!body || !Array.isArray(body.pending)) continue;

      const scope = profile ?? '';
      const prefix = `${REQ}${scope}:`;
      const seeded = getWatermark(`${SEEDED}${scope}`) !== null;
      const seen = new Set<string>();

      for (const raw of body.pending as PendingRow[]) {
        const platform = str(raw.platform);
        const userId = str(raw.user_id);
        const id = str(raw.request_id) ?? (userId ? `u:${userId}` : null);
        if (!platform || !id) continue;

        const key = `${prefix}${platform}:${id}`;
        seen.add(key);
        if (getWatermark(key) !== null) continue;
        setWatermark(key, '1');

        // The store's first read adopts what is already waiting, silently.
        if (!seeded) continue;

        const who = str(raw.user_name) ?? userId ?? 'someone';
        const where = platformLabel(platform);
        const text = `New sender wants to pair: ${where} ${who}${multi && profile ? ` (${profile})` : ''}`;

        appendEntry({
          kind: 'pairing.request',
          source: 'system',
          severity: 'warn',
          title: 'Pairing request',
          body: `${text}. Approve it within the hour or the request expires.`,
          url: '/machine#pairing',
          jobId: null,
          jobName: null,
          runId: null,
          status: 'pending',
          failed: false,
          sessionId: null,
          at: Date.now(),
          dedupeKey: null,
        });

        log.info(`Pairing request: ${where} ${who}${profile ? ` (${profile})` : ''}`);

        if (listSubscriptions().length) {
          void sendPush({
            title: 'Pairing request',
            body: text,
            url: '/machine#pairing',
            // Per request, so a second sender stacks rather than replacing
            // the first — each is a separate decision.
            tag: `pairing:${scope}:${platform}:${id}`,
            kind: 'pairing.request',
          }).catch((err) => log.warn({ err }, 'Pairing push failed'));
        }
      }

      /* Approved, expired and cleared requests drop out of the store, and
         their marks with them — only for a store this pass actually read. */
      pruneWatermarks(prefix, seen);
      if (!seeded) setWatermark(`${SEEDED}${scope}`, '1');
    }
  } catch (err) {
    log.warn({ err }, 'Pairing sweep failed');
  } finally {
    running = false;
    if (dirty) {
      dirty = false;
      schedulePairingSweep();
    }
  }
}
