/**
 * Turning `cron.changed` into something worth reading.
 *
 * The event itself carries nothing. Observed on the wire, every one of them
 * looks exactly like this:
 *
 *   {"type":"cron.changed","session_id":"","payload":{}}
 *
 * — no job, no status, no session, and four of them fire for a single run
 * (create, trigger, start, finish). It is a "something about cron moved, go
 * and look" signal and nothing more, which is why the notification it used to
 * produce could only ever say "A scheduled job ran".
 *
 * So this module goes and looks. On a signal it reconciles the gateway's run
 * history against the runs already in the feed, and any finished run it has
 * not seen becomes one notification, built from the run record rather than
 * from the event:
 *
 *   - the run's `id` is a session id, so the notification can link to the
 *     actual conversation;
 *   - the run's `title` is "<job name> · <when>";
 *   - `end_reason` says how it ended;
 *   - and the session's last assistant message is the agent's actual reply,
 *     which is the thing a person wants on the lock screen.
 *
 * Dedupe is by run id, which is what makes the four-events-per-run storm
 * harmless: the first signal to arrive after a run finishes creates the entry
 * and the rest find nothing new.
 *
 * Two passes, not one. A job that fails *before* running produces no session
 * and therefore no run record at all, so the run history cannot see it — see
 * `reportFailedExecution`, which reads the job record instead.
 *
 * ## Jobs in another profile, which is most of the ways this goes quiet
 *
 * `cron.changed` is not emitted by whatever ran the job. It is a one-second
 * file watcher inside the gateway's socket server (`tui_gateway/server.py`)
 * stat-ing `<active profile home>/cron/jobs.json` — process-wide, one home. So
 * a job living in `profiles/fitness/cron/jobs.json` moves a file nothing is
 * watching: it runs on time, writes its output, and this module is never told.
 * No amount of gateway wiring fixes that from the outside, which is why the
 * signal cannot be the only trigger — `startCronSweep` re-runs the pass on a
 * timer, and the timer is what makes a non-active profile's runs arrive at
 * all. It also closes a second hole the signal always had: runs that finished
 * while the proxy was down are picked up on the next sweep instead of waiting
 * for the next unrelated `cron.changed`.
 *
 * Two of the three reads then have to carry the profile, and the merged job
 * list is where it comes from (`/api/cron/jobs` defaults to `profile=all`, so
 * every profile's jobs are already here, each tagged):
 *
 *   - the runs endpoint, because Hermes otherwise resolves a job by scanning
 *     every store and matching id **or name** — two profiles holding a
 *     `morning-brief` would report each other's history;
 *   - the session's messages, because sessions are per-profile stores and an
 *     unqualified read 404s. That one fails quietly in the worst way: the
 *     notification still goes out, with the fallback "<job> finished" where
 *     the agent's actual reply should be.
 *
 * ## And the profile a run is filed under is not always the job's
 *
 * The scoped read is necessary but not sufficient. A session row is written by
 * whichever gateway *executed* the job, into that process's own `HERMES_HOME`,
 * and only tagged with the profile it ran as — so one gateway ticking every
 * profile's cron store runs a `fitness` job correctly against the fitness home
 * and files the session under `default`. That is the normal shape of a machine
 * whenever a profile's own gateway is not running, and it makes the scoped read
 * correctly find nothing, every sweep, indefinitely.
 *
 * `runsFor` falls back to an unscoped read when the profile reports none,
 * keeping only sessions whose id carries the job's own id — see the note there
 * for why an unscoped read cannot be trusted wholesale, and why the profile
 * that *answered* has to travel downstream instead of the job's.
 */
import { clearToken, getToken, resolveToken, upstreamHttp, upstreamHost } from '../config.js';
import { log } from '../log.js';
import { appendEntry, hasRun, hasSeeded, markSeeded, markRunSeen } from './feed.js';
import { flatten, fullText } from './preview.js';
import { sendPush } from './send.js';
import { listSubscriptions } from './store.js';

/**
 * How long to wait after a signal before looking.
 *
 * A single run emits several `cron.changed` in a row, and the one that matters
 * is the last — the run row is only complete once it has ended. Collapsing the
 * burst into one pass a couple of seconds later means one set of fetches per
 * run instead of four, and avoids reading a row that is still being written.
 */
const SETTLE_MS = 2500;

/**
 * How often to look without being asked.
 *
 * Slow on purpose: this is the backstop for what the signal cannot see, not
 * the primary path. Each pass is one job list plus a runs call per job, and a
 * run's reply is only fetched for a run this module has never seen — so the
 * steady state is a couple of cheap requests every few minutes.
 */
const SWEEP_MS = 3 * 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let sweep: ReturnType<typeof setInterval> | null = null;
let running = false;
/** Set again if a signal lands mid-pass, so the pass is not missed. */
let dirty = false;

interface GatewayRun {
  id?: unknown;
  title?: unknown;
  ended_at?: unknown;
  started_at?: unknown;
  end_reason?: unknown;
  message_count?: unknown;
}

interface GatewayJob {
  id?: unknown;
  name?: unknown;
  /** Which profile's store the job came out of; absent on a single-profile install. */
  profile?: unknown;
  last_status?: unknown;
  last_error?: unknown;
  last_run_at?: unknown;
  /** The most recent attempt, including ones that never became a run. */
  latest_execution?: unknown;
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
 * which is the request this module always made and the right one for a
 * single-profile install.
 */
function withProfile(path: string, profile: string | null): string {
  if (!profile) return path;
  return `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * "Feed smoke test · Aug 19 22:24" → "Feed smoke test".
 *
 * The gateway stamps the run's start onto the title. The feed already shows
 * when each entry landed next to it, so repeating the timestamp inside the
 * text is noise — and on a lock screen it costs characters the reply needs.
 */
function jobNameFromTitle(title: string | null, fallback: string | null): string {
  if (!title) return fallback ?? 'A scheduled job';
  const cut = title.lastIndexOf(' · ');
  return (cut > 0 ? title.slice(0, cut) : title).trim() || (fallback ?? 'A scheduled job');
}

/**
 * The last thing the agent said in a run, if it said anything.
 *
 * Kept whole. The feed card renders all of it and the push body is flattened
 * back down at send time — storing the 140-character version here is what used
 * to make a digest unreadable in the one place there was room to read it.
 */
async function replyOf(runId: string, profile: string | null): Promise<string | null> {
  const body = await gatewayGet<{ messages?: unknown[] } | unknown[]>(
    withProfile(`/api/sessions/${encodeURIComponent(runId)}/messages`, profile),
  );
  const messages = Array.isArray(body) ? body : (body?.messages ?? []);

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m?.role !== 'assistant') continue;
    const content = str(m.content);
    if (content) return fullText(content);
  }
  return null;
}

/**
 * A job's runs, and the profile whose store actually answered for them.
 *
 * The two are returned together because they have to stay together: the
 * messages read and the notification's `/chat` link are both profile-scoped,
 * and pointing either at a store that does not hold the session 404s. That
 * failure is silent in the worst way — the notification still goes out, with
 * "<job> finished" where the agent's reply should be.
 *
 * ## Why a fallback is needed at all
 *
 * A run's session row is written by whichever gateway *executed* the job, into
 * that process's own `HERMES_HOME`, and only tagged with the profile it ran
 * as. So a single gateway ticking every profile's cron store — which is what a
 * machine has whenever a profile's own gateway is not running — executes a
 * `fitness` job correctly against the fitness home and files the session under
 * `default`. The runs endpoint then cannot see it from either direction:
 *
 *   selected = profile or _find_cron_job_profile(job_id)
 *   db = _open_session_db_for_profile(selected, read_only=True)
 *
 * An **omitted** profile is not "the active store" here — Hermes looks the
 * job's own profile up and opens that one, so scoped and unscoped are the same
 * request. The runs endpoint is therefore a dead end for this case by
 * construction, and the fallback has to read the session store directly.
 *
 * Observed here: the fitness profile's gateway exited on 2026-08-25 and the
 * last run this module recorded for its daily job was seven minutes earlier.
 * Every run after that was invisible while the job itself kept working. The
 * asymmetry is what makes it hard to spot from the feed — `reportFailedExecution`
 * reads the job record rather than the runs endpoint, so *failures* still
 * arrived and successes never did.
 *
 * ## What is read instead
 *
 * `/api/sessions?source=cron`, whose omitted profile *is* the active one — the
 * store the executing gateway actually wrote to. Cron runs are ordinary
 * sessions (`cron_<jobId>_<timestamp>`, the gateway's own naming) and the rows
 * carry the same columns the runs endpoint returns, so nothing downstream
 * changes shape. The prefix is what binds a row to a job: the page holds every
 * profile's cron sessions.
 *
 * It is a **merge, not a fallback**, and that distinction is the whole fix. The
 * obvious shape — read the session list only when the job's own profile reports
 * nothing — does not work, because the profile is rarely *empty*: it holds
 * every run from before its gateway stopped. Here the fitness store still
 * answered with one session from 2026-08-25, so a length check saw a healthy
 * job and never looked further, which is exactly the bug it was meant to fix.
 * Union the two and dedupe by id instead; a run's own source decides which
 * profile addresses it.
 *
 * The session list is fetched **once per pass** rather than once per job, so
 * the whole mechanism costs one extra request every few minutes regardless of
 * how many jobs exist.
 */
function runsFor(
  jobId: string,
  profile: string | null,
  scoped: unknown[] | null,
  cronSessions: unknown[],
): { run: GatewayRun; profile: string | null }[] {
  const found = (scoped ?? []).map((raw) => ({ run: raw as GatewayRun, profile }));
  const seen = new Set(found.map((f) => str(f.run.id)).filter(Boolean));

  for (const raw of cronSessions) {
    const run = raw as GatewayRun;
    const id = str(run.id);
    if (!id || seen.has(id) || !id.startsWith(`cron_${jobId}_`)) continue;
    seen.add(id);
    // Found in the active store, so that is what addresses it — the job's own
    // profile 404s for a session it does not hold.
    found.push({ run, profile: null });
  }
  return found;
}

/**
 * `end_reason` values that mean the run did not deliver.
 *
 * `cron_complete` is the success case seen on the wire. Anything containing
 * one of these reads as a failure; an unrecognised reason is treated as
 * success, on the same principle as everywhere else here — a wrong "failed"
 * label is worse than a missing one.
 */
const FAILURE_MARKERS = ['error', 'fail', 'timeout', 'cancel', 'interrupt', 'abort'];

function looksFailed(endReason: string | null): boolean {
  if (!endReason) return false;
  const lower = endReason.toLowerCase();
  return FAILURE_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * An attempt that never became a run.
 *
 * A job can fail before any inference happens — the case that prompted this
 * was Hermes refusing to run an unpinned job after the global model changed
 * ("Skipped to prevent unintended spend"). No agent turn means no session,
 * which means `/api/cron/jobs/<id>/runs` returns *nothing at all*: the failure
 * is invisible to the run-history pass below. It shows up only on the job
 * record, as `latest_execution` / `last_status` / `last_error`.
 *
 * That made the single most important notification — "your job did not run" —
 * the one that stayed silent. Hence this pass, which reads the job record
 * directly and is deliberately ahead of the run pass.
 */
async function reportFailedExecution(
  job: GatewayJob,
  jobId: string,
  seeding: boolean,
): Promise<void> {
  const execution = (job.latest_execution ?? {}) as {
    id?: unknown;
    status?: unknown;
    error?: unknown;
    finished_at?: unknown;
  };

  const status = str(execution.status) ?? str(job.last_status);
  if (!status || !looksFailed(status)) return;

  const error = str(execution.error) ?? str(job.last_error);

  /**
   * Dedupe key. The execution id is the precise one; `last_run_at` stands in
   * when the gateway reports no execution record, so a job that fails the same
   * way every night still produces one notification per attempt rather than
   * one ever.
   */
  const key = str(execution.id) ?? `${jobId}:${str(job.last_run_at) ?? 'unknown'}`;
  if (hasRun(key)) return;

  if (seeding) {
    markRunSeen(key);
    return;
  }

  const jobName = str(job.name) ?? jobId;
  /**
   * The error text is the notification.
   *
   * These messages are long and end in remediation instructions, but they open
   * with the reason — "Skipped to prevent unintended spend: …" — which is
   * exactly what belongs on a lock screen. The `RuntimeError:` prefix is noise
   * to a person, so it goes.
   */
  const detail = error ? fullText(error.replace(/^[A-Za-z]*(Error|Exception):\s*/, '')) : null;

  const finishedAt = num(execution.finished_at);
  const at = finishedAt != null ? finishedAt * 1000 : Date.parse(str(job.last_run_at) ?? '') || Date.now();

  const entry = appendEntry({
    kind: 'cron.failed',
    title: jobName,
    body: detail ?? `${jobName} did not run`,
    // No session exists, so this is where the run history and the job's own
    // controls are — the deep link `CronTab` opens the sheet from.
    url: `/cron?job=${encodeURIComponent(jobId)}`,
    jobId,
    jobName,
    runId: key,
    status,
    failed: true,
    sessionId: null,
    at,
  });

  log.info(`Cron failure recorded: ${jobName} (${status})`);

  if (listSubscriptions().length) {
    void sendPush({
      title: `${jobName} failed`,
      // The row keeps the whole reply; a banner gets one line of it.
      body: flatten(entry.body) ?? entry.body,
      url: '/notifications',
      tag: `cron:${jobId}`,
      kind: 'cron.failed',
    }).catch((err) => log.warn({ err }, 'Cron failure push failed'));
  }
}

/** Ask for a reconcile pass. Cheap to call, and safe to call repeatedly. */
export function scheduleCronReconcile(): void {
  if (running) {
    dirty = true;
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void reconcile();
  }, SETTLE_MS);
  // A pending look at the cron log is never a reason to keep the process up.
  timer.unref?.();
}

/**
 * Start looking on a timer as well as on a signal.
 *
 * The first pass is left to the signal or the first interval: a sweep the
 * moment the proxy starts would race the push listener's own connect, and
 * nothing is lost by waiting one interval for news that is already on disk.
 */
export function startCronSweep(): void {
  if (sweep) return;
  sweep = setInterval(() => scheduleCronReconcile(), SWEEP_MS);
  // A periodic look at the cron log is never a reason to keep the process up.
  sweep.unref?.();
}

export function stopCronSweep(): void {
  if (sweep) clearInterval(sweep);
  sweep = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * One reconcile pass. Exported so it can be driven directly — the scheduler
 * above wraps it in a settle delay that a test would otherwise have to fake.
 */
export async function reconcile(): Promise<void> {
  running = true;
  try {
    const jobsBody = await gatewayGet<{ jobs?: unknown[] } | unknown[]>('/api/cron/jobs');
    if (!jobsBody) return;
    const jobs = Array.isArray(jobsBody) ? jobsBody : (jobsBody.jobs ?? []);

    /**
     * The first pass on a fresh install adopts history silently.
     *
     * Without this, installing the app on a machine with months of cron
     * history would fire a notification for every run ever recorded. The feed
     * is meant to start from the moment it exists.
     *
     * Keyed to "has a pass ever completed", not "have we ever seen a run".
     * The latter never became true on an install whose jobs had no history
     * yet, so every pass stayed a seeding pass and the first run to actually
     * happen was adopted in silence.
     */
    const seeding = !hasSeeded();

    /**
     * The active profile's cron sessions, read once for the whole pass — see
     * `runsFor` for why the runs endpoint alone cannot see a run filed under a
     * profile other than its job's.
     */
    const listed = await gatewayGet<{ sessions?: unknown[] } | unknown[]>(
      '/api/sessions?source=cron&limit=100',
    );
    const cronSessions = listed ? (Array.isArray(listed) ? listed : (listed.sessions ?? [])) : [];

    for (const raw of jobs) {
      const job = raw as GatewayJob;
      const jobId = str(job.id);
      if (!jobId) continue;
      const profile = str(job.profile);

      await reportFailedExecution(job, jobId, seeding);

      const body = await gatewayGet<{ runs?: unknown[] } | unknown[]>(
        withProfile(`/api/cron/jobs/${encodeURIComponent(jobId)}/runs`, profile),
      );
      const scoped = body ? (Array.isArray(body) ? body : (body.runs ?? [])) : null;
      const found = runsFor(jobId, profile, scoped, cronSessions);
      if (!found.length) continue;

      for (const candidate of found) {
        const run = candidate.run;
        /**
         * The store that answered for *this run*, which is not always the
         * job's own profile. Everything addressing the session — the reply
         * read and the `/chat` link — has to use it, not `job.profile`.
         */
        const runProfile = candidate.profile;
        const runId = str(run.id);
        // A run still in flight has no `ended_at`; it will be picked up by the
        // signal that fires when it finishes.
        if (!runId || num(run.ended_at) == null) continue;
        if (hasRun(runId)) continue;

        if (seeding) {
          markRunSeen(runId);
          continue;
        }

        const jobName = jobNameFromTitle(str(run.title), str(job.name) ?? jobId);
        const endReason = str(run.end_reason);
        const failed = looksFailed(endReason);
        const reply = failed ? null : await replyOf(runId, runProfile);

        /**
         * The reply is the headline when there is one. A run that produced no
         * prose — tools only, or a failure — falls back to naming the job,
         * which is all the old notification could ever say.
         */
        const body = reply ?? `${jobName} ${failed ? 'failed' : 'finished'}`;

        const entry = appendEntry({
          kind: 'cron.changed',
          title: jobName,
          body,
          /**
           * The profile travels with the session id, or the tap lands on
           * "session not found".
           *
           * A cron session is stored in the profile the job ran in, and
           * `ChatScreen`'s resume addresses the active profile when the link
           * does not say otherwise — so a fitness run's notification opened a
           * lookup in `default`, which 404s. The row is the one thing standing
           * between the notification and the transcript, so it has to carry it.
           */
          url: withProfile(`/chat?session=${encodeURIComponent(runId)}`, runProfile),
          jobId,
          jobName,
          runId,
          status: endReason,
          failed,
          sessionId: runId,
          at: (num(run.ended_at) ?? Date.now() / 1000) * 1000,
        });

        log.info(`Cron run recorded: ${jobName} (${runId})`);

        if (listSubscriptions().length) {
          void sendPush({
            title: jobName,
            // The row keeps the whole reply; a banner gets one line of it.
      body: flatten(entry.body) ?? entry.body,
            /**
             * Onto the feed rather than this one run: by the time a phone is
             * picked up there may be several waiting, and opening the newest
             * buries the rest. Each row carries `entry.url` onward.
             */
            url: '/notifications',
            tag: `cron:${jobId}`,
            kind: 'cron.changed',
          }).catch((err) => log.warn({ err }, 'Cron push fan-out failed'));
        }
      }
    }

    // Only after a pass that actually reached the gateway: recording it while
    // Hermes was down would burn the seeding pass on nothing, and the first
    // real run once it came back would be adopted silently.
    if (seeding) markSeeded();
  } catch (err) {
    log.warn({ err }, 'Cron reconcile failed');
  } finally {
    running = false;
    if (dirty) {
      dirty = false;
      scheduleCronReconcile();
    }
  }
}
