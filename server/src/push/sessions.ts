/**
 * Telling you the agent replied, or is waiting on you.
 *
 * ## Why this exists at all
 *
 * `events.ts` maps six gateway events to notifications — `message.complete`,
 * `approval.request`, `clarify.request`, `notification.show`,
 * `background.complete`, `subagent.complete`. Not one of them has ever fired
 * on a deployed proxy, and nothing said so.
 *
 * The gateway routes an event frame to the transport that **owns the session**
 * and nowhere else (`tui_gateway/server.py`, `write_json`): a frame carrying a
 * `session_id` is written to `_sessions[sid]["transport"]`, full stop. Only
 * `_broadcast_global_event` fans out to every connected peer, and it is used
 * for the handful of session-less "go and look" signals in `_CHANGE_WATCHES`
 * — `cron.changed`, `sessions.changed`, `skin.changed`. The push listener owns
 * no sessions, so those signals are the *only* frames it has ever received.
 *
 * Worse in the exact window push exists for: when a phone disconnects, the
 * session's transport is set to `_detached_ws_transport`, a drop sentinel. The
 * events of a turn running with nobody watching are not merely delivered
 * elsewhere — they are written to the floor. There is no socket the proxy
 * could hold that would receive them.
 *
 * Four days of this install's journal showed it exactly: every push that fired
 * came from `cron.ts` or `kanban.ts`, both of which are sweeps over REST, and
 * the feed held thirty-two rows without one of the three types `updates.ts`
 * handles. Reads as "push is unreliable" from the phone, because the half that
 * works is the scheduled half.
 *
 * ## Why a sweep, and what it costs
 *
 * The same reasoning `startKanbanSweep` is built on, arrived at from the
 * opposite direction: there, a stream existed and was refused because it loses
 * everything that happened during a deploy. Here no stream exists to refuse.
 * State is the only thing on offer, so this reads state and reports the
 * differences.
 *
 * The trade is honest and worth naming. Latency goes from "instant" to "up to
 * one sweep" — but the thing being replaced is *never*, and for an approval
 * that blocks the turn until answered, a minute late beats silent. Fidelity is
 * the real loss: `message.complete` carries a `status`, so `toMessage` can
 * refuse to announce an interrupted turn as a reply. A transition cannot see
 * that, which is why a turn is only announced once its reply has actually been
 * read back out of the transcript.
 *
 * ## Two reads, deliberately on different transports
 *
 *  - **When** comes from `session.active_list` over the listener's own socket
 *    (`rpc.ts`). There is no REST equivalent — it enumerates the gateway's
 *    in-process session registry — and that gives the lane the same property
 *    the delegation lane has: with the socket down its rows are *absent*
 *    rather than stale, which is why a pass that got nothing prunes nothing.
 *    Note what is deliberately **not** called: `session.resume` and
 *    `session.activate` both carry richer state, and both bind the session's
 *    transport to the caller. The proxy asking would take the session away
 *    from the phone holding it.
 *
 *  - **What** comes from REST, the same read `cron.ts` makes: the last
 *    assistant message in the transcript. `session.active_list` does carry a
 *    `preview`, and it is the wrong string — it is the last message with any
 *    text in it, so a turn that ran tools and said nothing previews as *the
 *    user's own message*, which would push someone's words back at them as
 *    though the agent had said them.
 *
 * ## What is reported, and what cannot be
 *
 * `status` collapses approval, clarify and plain input into one value,
 * `waiting` (`_session_pending_kind` strips the suffix before
 * `_session_live_status` looks at it). So the banner says the agent is waiting
 * and does not guess which of the three — the sheet that answers it is mounted
 * on every screen anyway.
 *
 * `notification.show` is not recoverable this way and stays broken. It is a
 * pure event with nothing persisted behind it; there is no state to read back.
 * `background.complete` and `subagent.complete` are reachable in principle
 * through `delegation.status`, but that registry is process memory too, so a
 * child finishing while the proxy is restarting is gone either way. Both are
 * left to the socket path, which will start working unchanged if Hermes ever
 * fans these out — which is why `toMessage` keeps all six cases.
 *
 * ## Nothing here writes to the feed
 *
 * On purpose, and it is the one thing about this module that looks like an
 * omission. `updates.ts` sets out why: `message.complete` would make the feed
 * a second copy of every transcript, and approvals and clarifies block the
 * agent and already have always-mounted sheets, so a row arriving after the
 * fact is a worse version of what is already on screen. All three push and
 * none of them are recorded. The only thing this module keeps in `feed.ts` is
 * its watermarks, which is just where the proxy's durable key/value lives.
 */
import { clearToken, getToken, resolveToken, upstreamHttp, upstreamHost } from '../config.js';
import { log } from '../log.js';
import { getWatermark, pruneWatermarks, setWatermark } from './feed.js';
import { flatten } from './preview.js';
import { callGateway } from './rpc.js';
import { sendPush } from './send.js';
import { listSubscriptions } from './store.js';

/**
 * How often to look without being asked.
 *
 * Faster than the cron sweep because a person is being waited on, and slower
 * than a poll because the steady-state cost is one socket call — the REST
 * reads happen only on a transition, which on a quiet machine is never.
 */
const SWEEP_MS = 45_000;

/**
 * How long to wait after a `sessions.changed` before looking.
 *
 * The gateway floors that signal at two seconds and its signature moves on
 * every message append during a streaming turn, so the burst is already
 * coalesced upstream; this only has to outlast the gap between the last append
 * and the turn actually ending, or the pass reads a session still marked
 * `working` and reports nothing.
 */
const SETTLE_MS = 2500;

/** Prefix for this module's watermarks, so the prune cannot touch another's. */
const MARK = 'session:';

/**
 * How many profiles to try when locating a session's store.
 *
 * `session.active_list` reports the gateway's whole live registry regardless
 * of profile, but the REST routes that read a transcript are per-profile and
 * the live row does not say which one it came from. So an unresolved session
 * is searched for, and the search is bounded for the same reason
 * `ACTIVITY_PROFILE_CAP` is.
 */
const PROFILE_CAP = 8;

let sweep: ReturnType<typeof setInterval> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let dirty = false;

interface SessionDetail {
  /** `null` means the active profile, which needs no `?profile=` at all. */
  profile: string | null;
  /** `cron`, `kanban`, or null for a conversation someone actually had. */
  source: string | null;
}

/**
 * Resolved detail per session key, so the profile search below runs once per
 * session rather than once per transition.
 */
const detailOf = new Map<string, SessionDetail>();

interface LiveSession {
  id?: unknown;
  session_key?: unknown;
  title?: unknown;
  status?: unknown;
  message_count?: unknown;
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

/**
 * Address a profile-scoped endpoint. An absent profile means "the active one",
 * which is the right request on a single-profile install.
 */
function withProfile(path: string, profile: string | null): string {
  if (!profile) return path;
  return `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Which store holds this session, and what opened it.
 *
 * Both come off one row, which is why they are fetched together: the profile
 * is needed to read the transcript and to build a link that does not 404, and
 * `source` is what keeps this module from re-announcing work another sweep
 * already owns.
 *
 * The detail route 404s for a session in another profile — which reads as
 * "deleted" rather than as "ask somewhere else" — so the profile is found by
 * asking. The active profile is tried first, because on the overwhelmingly
 * common single-profile install it is the only one there is.
 *
 * `null` for a failed search, never a cached miss: that far more often means
 * Hermes was briefly unreachable than that the session is gone, and caching it
 * would make one bad moment permanent for that session.
 */
async function resolveDetail(key: string): Promise<SessionDetail | null> {
  const cached = detailOf.get(key);
  if (cached) return cached;

  const path = `/api/sessions/${encodeURIComponent(key)}`;
  const detail = (row: { profile?: unknown; source?: unknown }, fallback: string | null) => {
    const resolved: SessionDetail = {
      profile: str(row.profile) ?? fallback,
      source: str(row.source),
    };
    detailOf.set(key, resolved);
    return resolved;
  };

  const active = await gatewayGet<{ profile?: unknown; source?: unknown }>(path);
  if (active) return detail(active, null);

  const body = await gatewayGet<{ profiles?: { name?: unknown }[] }>('/api/profiles');
  const names = (body?.profiles ?? [])
    .map((p) => str(p.name))
    .filter((n): n is string => n !== null)
    .slice(0, PROFILE_CAP);

  for (const name of names) {
    const row = await gatewayGet<{ profile?: unknown; source?: unknown }>(withProfile(path, name));
    if (row) return detail(row, name);
  }

  return null;
}

/**
 * Sessions another sweep already speaks for.
 *
 * The gateway's live registry is not a list of conversations — a scheduled run
 * and a kanban worker are sessions too, and they were the majority of the rows
 * on the machine this was written against. `cron.ts` announces a run from the
 * run record, which carries the job name and the outcome; `kanban.ts`
 * announces the card, which is where the work is actually looked at. Reporting
 * the same turn again from here would put two banners on the lock screen for
 * one thing happening, and the *worse* of the two would be this one.
 *
 * Only the reply is suppressed. A scheduled run that stops to ask for an
 * approval is announced by nobody else, and it is the one holding a turn open.
 */
const OWNED_ELSEWHERE = new Set(['cron', 'kanban']);

function ownedElsewhere(key: string, detail: SessionDetail | null): boolean {
  /* Checked before the row, and deliberately not only as a fallback: a
     transcript this module cannot read still falls through to a banner, and
     without the prefix that banner would be a duplicate of the cron one. The
     naming (`cron_<job id>_<timestamp>`) is Hermes' own and is what
     `push/cron.ts` matches runs on. */
  if (key.startsWith('cron_')) return true;
  return detail?.source ? OWNED_ELSEWHERE.has(detail.source) : false;
}

/**
 * The last thing the agent said, or `null` when the transcript could not be
 * read at all.
 *
 * The two are different answers and the caller acts on both: an empty
 * transcript read means the turn produced no prose and is not worth a banner,
 * while a failed read means the turn certainly happened and this pass simply
 * cannot quote it. Collapsing them would either invent replies or swallow real
 * ones — and the watermark has already moved by then, so a swallowed one is
 * never retried.
 *
 * One ordering assumption, worth knowing because it is the only way this can
 * quote the *wrong* turn: Hermes flushes a turn to SQLite when it ends, so a
 * transcript read mid-turn stops at the turn before. What makes that safe here
 * is that the read only happens once `session.active_list` has already reported
 * the session back to `idle` — the turn is over by then — and the settle delay
 * ahead of every pass adds a couple of seconds on top. Reading on `working`
 * instead would reliably announce the previous reply as the new one.
 */
async function replyOf(
  key: string,
  profile: string | null,
): Promise<{ ok: true; text: string | null } | null> {
  const body = await gatewayGet<{ messages?: unknown[] } | unknown[]>(
    withProfile(`/api/sessions/${encodeURIComponent(key)}/messages`, profile),
  );
  if (!body) return null;

  const messages = Array.isArray(body) ? body : (body.messages ?? []);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message?.role !== 'assistant') continue;
    const content = str(message.content);
    if (content) return { ok: true, text: content };
  }
  return { ok: true, text: null };
}

/** Ask for a pass. Cheap to call, and safe to call repeatedly. */
export function scheduleSessionSweep(): void {
  if (running) {
    dirty = true;
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void reconcileSessions();
  }, SETTLE_MS);
  // A pending look at the session list is never a reason to keep the process up.
  timer.unref?.();
}

/**
 * Start sweeping.
 *
 * The first pass is left to the signal or the first interval, the way
 * `startCronSweep` does it: a pass fired at boot would race the push
 * listener's own connect, and with no socket bound `session.active_list`
 * answers `null` — which is a wasted seeding pass, not a harmless one.
 */
export function startSessionSweep(): void {
  if (sweep) return;
  sweep = setInterval(() => scheduleSessionSweep(), SWEEP_MS);
  // A periodic look at the session list is never a reason to keep the process up.
  sweep.unref?.();
}

export function stopSessionSweep(): void {
  if (sweep) clearInterval(sweep);
  sweep = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** A session waiting on a human. */
async function reportWaiting(key: string, title: string | null): Promise<void> {
  if (!listSubscriptions().length) return;

  const detail = await resolveDetail(key);
  const url = detail
    ? withProfile(`/chat?session=${encodeURIComponent(key)}`, detail.profile)
    : /* Without a profile the link 404s into "session not found", which reads
         as deleted. The empty chat is a worse landing but an honest one. */
      '/chat';

  log.info(`Session waiting on an answer: ${title ?? key}`);

  await sendPush({
    title: 'Hem is waiting for you',
    body: title ? `${title} — the agent is waiting for an answer.` : 'The agent is waiting for an answer.',
    /**
     * Straight to the conversation, not the feed: nothing was written to the
     * feed (see the header), and the sheet that releases the turn is mounted
     * on every screen, so landing in the chat puts the answer one tap away.
     */
    url,
    /**
     * Off the per-session tag on purpose, and for the reason `toMessage`
     * documents: a later "the agent replied" banner replacing this one would
     * bury the thing still holding the turn.
     */
    tag: `attention:${key}`,
    kind: 'session.waiting',
  }).catch((err) => log.warn({ err }, 'Session waiting push failed'));
}

/** A turn that finished while nobody was watching. */
async function reportReply(key: string, title: string | null): Promise<void> {
  // Cheap enough to check before the device list: a cron run makes up most of
  // the live registry on a machine with scheduled jobs.
  if (key.startsWith('cron_')) return;
  if (!listSubscriptions().length) return;

  const detail = await resolveDetail(key);
  if (ownedElsewhere(key, detail)) return;

  const reply = detail ? await replyOf(key, detail.profile) : null;

  /**
   * A turn that only ran tools has nothing to say, and saying it anyway is
   * how a lock screen fills with rows carrying no information — the same
   * refusal `toMessage` makes on an empty `message.complete`. Only skip on a
   * transcript actually read: a failed read falls through to the generic body
   * below, because the turn did complete and a vague banner beats none.
   */
  if (reply?.ok && !reply.text) return;

  const body = reply?.text ?? 'The agent replied.';
  const url = detail
    ? withProfile(`/chat?session=${encodeURIComponent(key)}`, detail.profile)
    : '/chat';

  log.info(`Session turn completed: ${title ?? key}`);

  await sendPush({
    title: title ?? 'Hem',
    // One line of it on the lock screen, the way every other sender here does.
    body: flatten(body) ?? body,
    url,
    /**
     * The same collapse key `toMessage` uses for a session's chatter. If
     * Hermes ever does deliver `message.complete` here, the two paths replace
     * each other's banner rather than stacking two of the same news.
     */
    tag: `session:${key}`,
    kind: 'message.complete',
  }).catch((err) => log.warn({ err }, 'Session reply push failed'));
}

/**
 * One pass. Exported so a test can drive it without faking the settle timer.
 */
export async function reconcileSessions(): Promise<void> {
  running = true;
  try {
    const body = await callGateway<{ sessions?: unknown[] }>('session.active_list', {});
    /**
     * `null` is the socket being down or the method being absent, never an
     * empty registry — `rpc.ts` keeps those apart so this one can. Returning
     * here rather than falling through to the prune is what stops a restart
     * forgetting every watermark and re-announcing whatever it finds next.
     */
    if (!body) return;

    const rows = body.sessions ?? [];
    const seen = new Set<string>();

    for (const raw of rows) {
      const row = raw as LiveSession;
      /**
       * The stored id, not the gateway handle. `id` is the 8-hex live handle
       * and means nothing to REST or to `/chat?session=`; `session_key` is
       * what both take. Falling back to `id` only covers a session so new it
       * has no agent yet, which has no transcript to link to anyway.
       */
      const key = str(row.session_key) ?? str(row.id);
      if (!key) continue;

      const status = str(row.status) ?? 'idle';
      const count = int(row.message_count);
      const mark = `${MARK}${key}`;
      seen.add(mark);

      /**
       * Both halves are the state, not just the status. A turn that starts
       * and finishes inside one sweep interval never shows as `working` to
       * anybody here — the message count is the only trace it leaves.
       */
      const value = `${status}:${count}`;
      const previous = getWatermark(mark);
      if (previous === value) continue;

      setWatermark(mark, value);

      /* First sight: adopt the session's state without announcing it. This is
         what makes installing the app on a machine with live sessions silent,
         and every proxy restart silent too. */
      if (previous === null) continue;

      const [previousStatus = 'idle', previousCountRaw = '0'] = previous.split(':');
      const previousCount = Number(previousCountRaw) || 0;

      if (status === 'waiting' && previousStatus !== 'waiting') {
        await reportWaiting(key, str(row.title));
        continue;
      }

      /**
       * A completed turn, and only from `idle`. `working` means the count
       * moved because the prompt was appended, which is the turn *starting*;
       * `starting` and `waiting` are not finished either. The rule that a
       * completion never implies a turn started applies just as much read from
       * state as it does read from events.
       */
      if (status === 'idle' && count > previousCount) {
        await reportReply(key, str(row.title));
      }
    }

    /**
     * Safe here in a way it is not in `kanban.ts`: an empty list is a real
     * answer (no live sessions) rather than an unreachable backend, because
     * that case returned above. A session that ends legitimately loses its
     * watermark, and if it is resumed later its first sight is silent again.
     */
    pruneWatermarks(MARK, seen);

    /* Keep the lookup cache from growing with every session the gateway has
       ever held. It is a shortcut, not state — a dropped entry costs one extra
       request the next time that session says something. */
    if (detailOf.size > 256) detailOf.clear();
  } catch (err) {
    log.warn({ err }, 'Session sweep failed');
  } finally {
    running = false;
    if (dirty) {
      dirty = false;
      scheduleSessionSweep();
    }
  }
}
