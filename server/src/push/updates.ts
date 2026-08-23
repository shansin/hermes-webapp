/**
 * Everything in the Updates feed that is not a scheduled run.
 *
 * `cron.ts` writes the feed's original source and has to work hard for it —
 * `cron.changed` carries nothing, so it goes and fetches the run. The two
 * sources here are the opposite: the frames already say what happened, and the
 * only question is which of them are worth writing down.
 *
 *  - **The agent's own announcements.** `notification.show`,
 *    `background.complete` and `subagent.complete` were already being pushed by
 *    `events.ts` and then forgotten. A push you did not see while the phone was
 *    face-down is gone; the whole point of the feed is that it is not.
 *
 *  - **The backend going away and coming back.** Nothing recorded this before.
 *    A Hermes that died at 3am and came back at 3:05 was invisible unless you
 *    happened to be looking at Settings at the time, which is precisely when
 *    nobody is. This is the proxy reporting on itself, so it is the one kind of
 *    entry with no session behind it at all.
 *
 * What stays out is as deliberate as what goes in. `message.complete` is the
 * agent replying in a conversation you are already having — putting it here
 * would make the feed a second copy of every transcript. `approval.request`
 * and `clarify.request` block the agent until answered and already have
 * always-mounted sheets that can be answered from any screen; a feed row is a
 * worse version of that, arriving after the fact. All three keep pushing
 * exactly as they did.
 */
import { appendUpdate } from './feed.js';
import { log } from '../log.js';
import { fullText } from './preview.js';
import { sendPush } from './send.js';
import { listSubscriptions } from './store.js';

/**
 * The gateway events that earn a row.
 *
 * Exported because `events.ts` scans raw frame text against this set before
 * parsing anything — see the note on the early-out there. Keeping the list in
 * one place is what stops the scan and the switch below from disagreeing,
 * which would fail in the quiet direction: the event never reaching the feed
 * at all.
 */
export const FEED_EVENT_TYPES = [
  'notification.show',
  'background.complete',
  'subagent.complete',
] as const;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Record a gateway event in the feed, if it is one of ours.
 *
 * Returns quietly for everything else, so the caller can hand it the whole
 * firehose. Push is *not* sent from here: `events.ts` already fans these three
 * out on its own path, and sending from both would double every banner.
 */
export function recordGatewayEvent(
  type: string,
  payload: Record<string, unknown>,
  sessionId: string | null,
): void {
  const url = sessionId ? `/chat?session=${encodeURIComponent(sessionId)}` : '/chat';

  let title: string;
  let body: string | null;

  switch (type) {
    case 'notification.show': {
      /**
       * The agent chose these words to be read by a person, so they are the
       * row — all of them. `events.ts` flattens its own copy for the banner;
       * what is kept here is what the card shows.
       */
      title = 'Hermes';
      body = fullText(str(payload.text) ?? str(payload.message));
      break;
    }

    case 'background.complete': {
      title = str(payload.title) ?? 'Background task';
      body = `${title} finished`;
      break;
    }

    case 'subagent.complete': {
      title = str(payload.name) ?? 'Subagent';
      body = `${title} finished`;
      break;
    }

    default:
      return;
  }

  // An event with nothing to say is not worth a row. `notification.show` with
  // no text is the case seen on the wire.
  if (!body) return;

  appendUpdate({
    at: Date.now(),
    kind: type,
    source: 'agent',
    severity: 'info',
    title,
    body,
    url,
    /**
     * One session's chatter collapses into its newest line, matching the
     * `session:` collapse key push already uses. A background task that ends
     * with a subagent finishing is one thing happening, not two rows.
     */
    dedupeKey: `${type}:${sessionId ?? 'default'}`,
    jobId: null,
    jobName: null,
    runId: null,
    status: null,
    failed: false,
    sessionId,
  });
}

/**
 * How long the backend has to stay away before it is worth telling anyone.
 *
 * Hermes restarting takes a couple of seconds and the push listener reconnects
 * on its own, so reporting every close would mean a pair of rows for every
 * `start.sh` — noise that trains you to ignore the one that matters. Past this
 * the outage has lasted longer than any restart and is something you would
 * want to know about.
 */
const OUTAGE_GRACE_MS = 20_000;

let outageTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether an outage was actually announced, so recovery only speaks if so. */
let outageReported = false;
/** When the link dropped, so the recovery line can say how long it was gone. */
let downSince: number | null = null;

function humanDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'less than a minute';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * The push listener's link to the gateway went down.
 *
 * Nothing is written yet — the grace timer decides. Called on every close,
 * including the ones that reconnect a second later, so it must be cheap and
 * idempotent.
 */
export function backendWentDown(): void {
  if (outageTimer || outageReported) return;
  downSince = Date.now();
  outageTimer = setTimeout(() => {
    outageTimer = null;
    outageReported = true;

    const entry = appendUpdate({
      at: Date.now(),
      kind: 'backend.down',
      source: 'system',
      severity: 'warn',
      title: 'Hermes backend',
      body: 'The agent backend went offline. Nothing can run until it is back.',
      // Not a conversation — the status this row is about lives in Settings.
      url: '/settings',
      dedupeKey: 'backend-state',
      jobId: null,
      jobName: null,
      runId: null,
      status: 'down',
      failed: false,
      sessionId: null,
    });

    log.warn('Backend offline past the grace window — recorded in the updates feed.');

    if (listSubscriptions().length) {
      void sendPush({
        title: 'Hermes backend offline',
        body: entry.body,
        url: '/notifications',
        tag: 'backend-state',
        kind: 'backend.down',
      }).catch((err) => log.warn({ err }, 'Backend-down push failed'));
    }
  }, OUTAGE_GRACE_MS);
  // A pending outage report is never a reason to keep the process alive.
  outageTimer.unref?.();
}

/**
 * The link is back.
 *
 * Silent unless an outage was announced: the first connect after start-up, and
 * every blip that healed inside the grace window, have nothing to recover
 * from and saying so would be two rows about nothing.
 */
export function backendCameBack(): void {
  if (outageTimer) {
    clearTimeout(outageTimer);
    outageTimer = null;
  }
  const since = downSince;
  downSince = null;
  if (!outageReported) return;
  outageReported = false;

  const away = since ? humanDuration(Date.now() - since) : null;

  const entry = appendUpdate({
    at: Date.now(),
    kind: 'backend.up',
    source: 'system',
    severity: 'ok',
    title: 'Hermes backend',
    body: away ? `Back online after ${away} offline.` : 'Back online.',
    url: '/settings',
    dedupeKey: 'backend-state',
    jobId: null,
    jobName: null,
    runId: null,
    status: 'up',
    failed: false,
    sessionId: null,
  });

  log.info('Backend reconnected — recorded in the updates feed.');

  if (listSubscriptions().length) {
    void sendPush({
      title: 'Hermes backend',
      body: entry.body,
      url: '/notifications',
      tag: 'backend-state',
      kind: 'backend.up',
    }).catch((err) => log.warn({ err }, 'Backend-up push failed'));
  }
}

/**
 * Drop any pending outage report.
 *
 * A clean shutdown closes the listener socket, which would otherwise arm the
 * grace timer and announce an outage on the way out — a notification saying
 * the backend is offline, sent by a proxy that is itself exiting.
 */
export function resetBackendWatch(): void {
  if (outageTimer) clearTimeout(outageTimer);
  outageTimer = null;
  outageReported = false;
  downSince = null;
}
