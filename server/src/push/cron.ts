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
 */
import { clearToken, getToken, resolveToken, upstreamHttp, upstreamHost } from '../config.js';
import { log } from '../log.js';
import { appendEntry, hasRun, knowsAnyRun, markRunSeen } from './feed.js';
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

/** Enough of a reply to recognise it on a lock screen. */
const PREVIEW_CHARS = 140;

let timer: ReturnType<typeof setTimeout> | null = null;
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
 * The agent's own words, flattened for a lock screen.
 *
 * Same treatment as `previewOf` in `events.ts`: markdown renders as nothing in
 * a notification, so headings and bullet markers are stripped and newlines
 * collapse. This is the whole point of the feature — "Nightly digest finished"
 * says a job ran, "3 PRs need review, none urgent" says what it found.
 */
function flatten(text: string): string | null {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/^\s{0,3}[#>*-]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return null;
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : flat;
}

/** The last thing the agent said in a run, if it said anything. */
async function replyOf(runId: string): Promise<string | null> {
  const body = await gatewayGet<{ messages?: unknown[] } | unknown[]>(
    `/api/sessions/${encodeURIComponent(runId)}/messages`,
  );
  const messages = Array.isArray(body) ? body : (body?.messages ?? []);

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m?.role !== 'assistant') continue;
    const content = str(m.content);
    if (content) return flatten(content);
  }
  return null;
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
  const detail = error ? flatten(error.replace(/^[A-Za-z]*(Error|Exception):\s*/, '')) : null;

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
      body: entry.body,
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

async function reconcile(): Promise<void> {
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
     */
    const seeding = !knowsAnyRun();

    for (const raw of jobs) {
      const job = raw as GatewayJob;
      const jobId = str(job.id);
      if (!jobId) continue;

      await reportFailedExecution(job, jobId, seeding);

      const runsBody = await gatewayGet<{ runs?: unknown[] } | unknown[]>(
        `/api/cron/jobs/${encodeURIComponent(jobId)}/runs`,
      );
      if (!runsBody) continue;
      const runs = Array.isArray(runsBody) ? runsBody : (runsBody.runs ?? []);

      for (const rawRun of runs) {
        const run = rawRun as GatewayRun;
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
        const reply = failed ? null : await replyOf(runId);

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
          url: `/chat?session=${encodeURIComponent(runId)}`,
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
            body: entry.body,
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
