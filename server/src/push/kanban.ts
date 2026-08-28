/**
 * Telling you a card stopped.
 *
 * The board is the one place in Hermes where the agent asks a question and
 * then *waits indefinitely* — a card with `block_kind: needs_input` sits there
 * until a human answers it. Nothing announced that. The card in this install
 * that prompted the work had been blocked for a day, with the answer typed
 * into a comment that no run ever read, and the only way to find either was to
 * open the board and look.
 *
 * ## Why this is a sweep and not a subscription
 *
 * There are two event streams and neither reaches here. The gateway's
 * JSON-RPC socket — the one `events.ts` already holds — carries nothing
 * kanban-shaped: `gateway/kanban_watchers.py` delivers to chat adapters
 * (Telegram, Discord) and never to the dashboard socket. The plugin has a
 * `WS /api/plugins/kanban/events?since=<id>` of its own, which would work and
 * would be faster, but it is a stream: everything that happens while the proxy
 * is down is lost, and the proxy is restarted by `start.sh` on every deploy.
 * A card that blocked during a restart is *exactly* the card you need to hear
 * about, and it is the one a stream cannot tell you about.
 *
 * So this reads state, on the same reasoning `startCronSweep` is built on: the
 * board says what is true now, not what happened, so a pass that missed an
 * hour catches up rather than losing it. The cost is latency — up to one sweep
 * interval — which for "a card has been waiting for a human since Tuesday" is
 * not a cost at all.
 *
 * ## Transitions, not states
 *
 * Reporting is driven by a **watermark per card** (`feed.ts`), because a card's
 * status is not news on its own — a card blocked yesterday is still blocked
 * today, and a seen-set would go quiet on a card that blocked, was answered,
 * ran and blocked again. The first sight of a card records its status and says
 * nothing, which is what makes installing the app on a board with months of
 * history silent, and what makes a proxy restart silent too.
 *
 * `block_recurrences` is part of the watermark deliberately. A card re-blocked
 * for the same reason is a *different* piece of news from the first block —
 * it means the last answer did not work — and Hermes routes it to Triage at
 * the limit rather than back to Blocked, so without the counter in the key the
 * second block would be reported as a status change to `triage` with no
 * explanation of why.
 *
 * Every board is swept, not just the server's current one: `POST
 * /boards/<slug>/switch` moves a process-wide pointer that any other client
 * can move, and a notifier that followed it would fall silent on the board you
 * were actually using.
 */
import { clearToken, getToken, resolveToken, upstreamHttp, upstreamHost } from '../config.js';
import { log } from '../log.js';
import { appendEntry, getWatermark, pruneWatermarks, setWatermark } from './feed.js';
import { flatten, fullText } from './preview.js';
import { sendPush } from './send.js';
import { listSubscriptions } from './store.js';

/**
 * How often to look.
 *
 * Faster than the cron sweep's three minutes because the thing being watched
 * is a person being waited on, and slower than a poll because each pass is one
 * board fetch per board and nothing else — no per-card requests, since
 * everything reported here is already on the board row.
 */
const SWEEP_MS = 90_000;

/** Prefix for this module's watermarks, so the prune cannot touch another's. */
const MARK = 'kanban:task:';

let sweep: ReturnType<typeof setInterval> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let dirty = false;

interface BoardTask {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  assignee?: unknown;
  latest_summary?: unknown;
  block_kind?: unknown;
  block_recurrences?: unknown;
  consecutive_failures?: unknown;
  last_failure_error?: unknown;
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
    // A 404 is the ordinary answer on a Hermes with the kanban plugin
    // disabled. Silent, and the sweep keeps ticking harmlessly.
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The statuses worth interrupting someone for, and how each one reads.
 *
 * Everything else a card does — triage to todo, todo to ready, ready to
 * running — is the board working, and a feed that reported it would be a
 * second copy of the board with no way to tell the four rows that matter from
 * the forty that do not. `review` is in because it is the other lane that
 * waits on a human; `triage` is in only because a *block loop* lands there,
 * which is Hermes saying it has given up asking.
 */
const REPORTED = new Set(['blocked', 'done', 'review', 'triage']);

/**
 * How a transition reads, given where the card came from.
 *
 * `triage` is the awkward one: a card *created* into triage is not news, and a
 * card routed there by `block_task` hitting `BLOCK_RECURRENCE_LIMIT` is the
 * most important row the feed can carry. The discriminator is where it came
 * from — only a blocked card can be rerouted — so a transition into triage
 * from anything else is dropped rather than guessed at.
 */
function describe(
  task: BoardTask,
  status: string,
  previousStatus: string | null,
  repeats: number,
): { title: string; body: string; severity: 'ok' | 'info' | 'warn' | 'error'; push: boolean } | null {
  const name = str(task.title) ?? str(task.id) ?? 'A task';
  const summary = str(task.latest_summary);

  if (status === 'blocked') {
    const kind = str(task.block_kind);
    const failures = int(task.consecutive_failures);
    /* A card that ran out of retries lands in `blocked` like any other, but it
       is not a question — nobody is being asked anything, the work failed. The
       failure counter is the only thing that tells them apart. */
    if (failures > 0) {
      return {
        title: name,
        body: str(task.last_failure_error) ?? summary ?? `${name} gave up after ${failures} failures`,
        severity: 'error',
        push: true,
      };
    }
    return {
      title: name,
      body:
        summary ??
        (kind === 'needs_input'
          ? `${name} is waiting for your answer`
          : `${name} is blocked${kind ? ` (${kind})` : ''}`),
      severity: 'warn',
      push: true,
    };
  }

  if (status === 'done') {
    return { title: name, body: summary ?? `${name} finished`, severity: 'ok', push: true };
  }

  if (status === 'review') {
    return { title: name, body: summary ?? `${name} is ready for review`, severity: 'info', push: true };
  }

  // `triage`, which is only news when a blocked card was rerouted into it.
  if (previousStatus !== 'blocked') return null;
  return {
    title: name,
    body:
      `${name} has been sent to Triage — it blocked for the same reason ${repeats + 1} times, ` +
      `so Hermes stopped re-queueing it.`,
    severity: 'error',
    push: true,
  };
}

/** Ask for a pass. Cheap to call, and safe to call repeatedly. */
export function scheduleKanbanSweep(): void {
  if (running) {
    dirty = true;
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void reconcileKanban();
  }, 1500);
  // A pending look at the board is never a reason to keep the process up.
  timer.unref?.();
}

/**
 * Start sweeping.
 *
 * The first pass is deliberately immediate rather than one interval away: on a
 * fresh install it is the seeding pass, and getting it out of the way at boot
 * means the first *real* transition is reported at the first interval instead
 * of the second.
 */
export function startKanbanSweep(): void {
  if (sweep) return;
  sweep = setInterval(() => scheduleKanbanSweep(), SWEEP_MS);
  sweep.unref?.();
  scheduleKanbanSweep();
}

export function stopKanbanSweep(): void {
  if (sweep) clearInterval(sweep);
  sweep = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Which boards to sweep. Falls back to the current one if `/boards` is absent. */
async function boardSlugs(): Promise<(string | null)[]> {
  const body = await gatewayGet<{ boards?: { slug?: unknown; archived?: unknown }[] }>(
    '/api/plugins/kanban/boards',
  );
  const boards = body?.boards ?? [];
  const slugs = boards
    .filter((b) => b.archived !== true)
    .map((b) => str(b.slug))
    .filter((s): s is string => s !== null);
  // `null` addresses the server's current board, which is the right request on
  // an older plugin with no `/boards` route at all.
  return slugs.length ? slugs : [null];
}

/**
 * One pass. Exported so a test can drive it without faking the settle timer.
 */
export async function reconcileKanban(): Promise<void> {
  running = true;
  try {
    const seen = new Set<string>();

    for (const slug of await boardSlugs()) {
      const path = slug
        ? `/api/plugins/kanban/board?board=${encodeURIComponent(slug)}`
        : '/api/plugins/kanban/board';
      const board = await gatewayGet<{ columns?: { name?: unknown; tasks?: unknown[] }[] }>(path);
      if (!board?.columns) continue;

      for (const column of board.columns) {
        for (const raw of column.tasks ?? []) {
          const task = raw as BoardTask;
          const id = str(task.id);
          if (!id) continue;

          const status = str(task.status) ?? str(column.name);
          if (!status) continue;

          const repeats = int(task.block_recurrences);
          /* The counter is part of the identity of the state, not a detail of
             it: a second block for the same reason is different news from the
             first, and without it here the re-block is silent. */
          const value = `${status}:${repeats}`;
          const key = `${MARK}${slug ?? ''}:${id}`;
          seen.add(key);

          const previous = getWatermark(key);
          if (previous === value) continue;

          setWatermark(key, value);

          // First sight: adopt the card's current state without announcing it.
          // This is what makes a fresh install, and every proxy restart with a
          // pruned watermark, silent rather than a notification per card.
          if (previous === null) continue;

          if (!REPORTED.has(status)) continue;

          const previousStatus = previous.split(':')[0] ?? null;
          const news = describe(task, status, previousStatus, repeats);
          if (!news) continue;

          const entry = appendEntry({
            kind: `kanban.${status}`,
            source: 'agent',
            severity: news.severity,
            title: news.title,
            body: fullText(news.body) ?? news.body,
            /* Onto the card, not the board: the sheet is where the answer is
               given, and `/kanban?task=` opens it directly. */
            url: `/kanban?task=${encodeURIComponent(id)}`,
            jobId: id,
            jobName: news.title,
            runId: null,
            status,
            failed: news.severity === 'error',
            sessionId: null,
            at: Date.now(),
            dedupeKey: null,
          });

          log.info(`Kanban ${status}: ${news.title} (${id})`);

          if (news.push && listSubscriptions().length) {
            void sendPush({
              title: news.title,
              // The row keeps the whole summary; a banner gets one line of it.
              body: flatten(entry.body) ?? entry.body,
              url: '/notifications',
              /* Per card, so a card that flaps replaces its own banner rather
                 than stacking one per transition on the lock screen. */
              tag: `kanban:${id}`,
              kind: entry.kind,
            }).catch((err) => log.warn({ err }, 'Kanban push fan-out failed'));
          }
        }
      }
    }

    /* Only prune against a pass that actually saw cards. A pass that reached
       nothing — Hermes down, plugin disabled, a 401 — would otherwise forget
       every watermark and re-announce the whole board on recovery. */
    if (seen.size) pruneWatermarks(MARK, seen);
  } catch (err) {
    log.warn({ err }, 'Kanban sweep failed');
  } finally {
    running = false;
    if (dirty) {
      dirty = false;
      scheduleKanbanSweep();
    }
  }
}
