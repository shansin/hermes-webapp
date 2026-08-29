/**
 * The updates feed — the transcript behind the "Updates" screen.
 *
 * This is the proxy's second piece of owned state, and it exists for the same
 * reason `events.ts` holds its own gateway socket: the things worth reporting
 * happen while nothing is connected. A feed assembled in the browser from live
 * WebSocket events would only ever contain what fired while the app happened
 * to be open, which is the opposite of what a scheduled job is for. The push
 * listener is already awake for all of them, so it writes them down here.
 *
 * Three sources write to it, all through this module: scheduled runs
 * (`cron.ts`), the agent's own announcements and the backend going up and down
 * (`updates.ts`). The file it persists to is still `.hermes-cron-feed.json`
 * because it started as a cron-only transcript, and renaming it would discard
 * everyone's history to no purpose.
 *
 * Deliberately *not* a Hermes session. The gateway owns sessions and offers no
 * way to append a message to one, so there is nothing upstream this could be
 * written into — and a screen with no composer is a stronger guarantee of
 * "you cannot reply to this" than a session that merely refuses to send.
 *
 * Storage mirrors `store.ts`: one JSON file next to `.env`, atomic writes,
 * because the same single-user home-LAN reasoning applies and the process can
 * be killed at any moment by start.sh.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { stateDir } from '../config.js';
import { log } from '../log.js';

/**
 * How many entries to keep.
 *
 * A daily job plus the occasional backend blip produces a few hundred a year,
 * so this is roughly "the last several months" for a normal setup and a hard
 * ceiling on the file for a pathological one. The screen renders the whole
 * feed in one list, and past a few hundred rows that stops being something
 * anyone reads.
 */
const MAX_ENTRIES = 300;

const EntrySchema = z.object({
  /** Stable per entry so React keys and read-tracking survive a refetch. */
  id: z.string(),
  /** When the run *ended*, not when we noticed — epoch milliseconds. */
  at: z.number(),
  /** The gateway event type, or a synthetic one for the proxy's own lines. */
  kind: z.string().default('cron.changed'),
  /**
   * Who is speaking. Drives the chip on each row, and is the honest answer to
   * "why am I being told this" — a scheduled run, the agent announcing
   * something mid-turn, or the proxy reporting on the backend.
   *
   * Defaulted to `cron` because every entry written before this field existed
   * was one.
   */
  source: z.enum(['cron', 'agent', 'system']).default('cron'),
  /**
   * How the row reads. Kept separate from `failed`, which stays because it is
   * specifically "the scheduled run did not deliver" and `cron.ts` computes it
   * from `end_reason`; a `warn` from the backend going away is not a failure
   * of anything the agent was asked to do.
   */
  severity: z.enum(['ok', 'info', 'warn', 'error']).optional(),
  /** The job's name, shown as the entry's heading and as the banner title. */
  title: z.string().default('Scheduled job'),
  /** The agent's own reply where there was one — see `cron.ts`. */
  body: z.string(),
  /** Where tapping the entry goes: the run's conversation. */
  url: z.string().default('/cron'),
  /**
   * Collapse key for repeats — see `appendUpdate`. Distinct from `runId`,
   * which is a permanent "this run has been accounted for" memory; this one
   * only ever looks at the newest row.
   */
  dedupeKey: z.string().nullable().default(null),
  jobId: z.string().nullable().default(null),
  jobName: z.string().nullable().default(null),
  /**
   * The gateway's run id, which is also its session id. This is the dedupe
   * key: `cron.changed` fires several times per run, and the reconcile pass
   * re-reads the same run history each time.
   */
  runId: z.string().nullable().default(null),
  /** The run's `end_reason`. Drives the failure styling. */
  status: z.string().nullable().default(null),
  failed: z.boolean().default(false),
  sessionId: z.string().nullable().default(null),
});
export type FeedEntry = z.infer<typeof EntrySchema>;

/**
 * What a writer has to supply.
 *
 * The three fields added when the feed widened past cron are optional here and
 * filled in by `appendEntry`, so the two long-standing call sites in `cron.ts`
 * read exactly as they did — a scheduled run is the default shape of an entry.
 */
export type FeedEntryInput = Omit<FeedEntry, 'id' | 'source' | 'severity' | 'dedupeKey'> &
  Partial<Pick<FeedEntry, 'source' | 'severity' | 'dedupeKey'>>;

const FileSchema = z.object({
  entries: z.array(EntrySchema).default([]),
  /**
   * Whether a reconcile pass has ever completed against this gateway.
   *
   * This, not `seenRuns`, is what decides whether history gets adopted
   * silently. Inferring it from "have we ever recorded a run" was wrong in the
   * one case that matters most: a fresh install whose jobs have no runs yet
   * has nothing to adopt, so it stayed in seeding mode — and swallowed the
   * first run that actually happened. Which is to say, you would create your
   * first scheduled job and never hear about it running.
   */
  seeded: z.boolean().default(false),
  /**
   * Run ids already accounted for, including those adopted silently on the
   * first pass and those whose entries have since aged out of `entries` or
   * been cleared. Kept separately so clearing the feed does not cause every
   * run in the gateway's history to be re-announced.
   */
  seenRuns: z.array(z.string()).default([]),
  /**
   * The `at` of the newest entry the reader has seen, epoch milliseconds.
   *
   * Stored here rather than in the browser because the feed is the proxy's
   * state and the badge has to be right on a phone that has just been picked
   * up — a localStorage count would say zero on a device that had never
   * opened the screen. Zero means "everything is unread", which is correct for
   * a feed that has just been created.
   */
  lastReadAt: z.number().default(0),
  /**
   * Last-seen values for things whose *transitions* are the news, rather than
   * whose existence is.
   *
   * `seenRuns` answers "have I already reported this?", which works for a run:
   * a run happens once and is then permanently accounted for. A kanban card is
   * the other shape — it goes blocked, is answered, runs, and blocks again, and
   * every one of those is worth reporting. A seen-set says "already told you"
   * the second time; only a remembered previous value can tell a transition
   * from a card that has simply been sitting there since the last sweep.
   *
   * Kept here rather than in memory because the sweep restarts with the proxy,
   * and a forgotten watermark makes every card on the board look like it just
   * changed — a restart would fire a notification per card.
   */
  watermarks: z.record(z.string(), z.string()).default({}),
});
type FileShape = z.infer<typeof FileSchema>;

const FILE = resolve(stateDir, '.hermes-cron-feed.json');

let state: FileShape = { entries: [], seenRuns: [], seeded: false, lastReadAt: 0, watermarks: {} };
let loaded = false;

/**
 * `seenRuns` as a set, built on demand and kept in step with the array.
 *
 * The array is the stored form — order is what makes the bound below drop the
 * *oldest* ids — but it is the wrong shape for the question actually asked of
 * it. `hasRun` is called once per run in the gateway's history on every
 * reconcile pass, and the list is bounded at four figures, so a scan per
 * lookup makes a pass quadratic in the size of the history it is walking.
 * `markRunSeen` had the same scan on its own membership check, which made a
 * catch-up over a long history quadratic a second time.
 *
 * Null means "not built yet", which is also how it is invalidated: `load()`
 * replaces the array wholesale, and the bound below rewrites it.
 */
let seenIndex: Set<string> | null = null;

function seenSet(): Set<string> {
  if (!seenIndex) seenIndex = new Set(load().seenRuns);
  return seenIndex;
}

function load(): FileShape {
  if (loaded) return state;
  loaded = true;
  if (!existsSync(FILE)) return state;
  try {
    const parsed = FileSchema.safeParse(JSON.parse(readFileSync(FILE, 'utf8')));
    if (parsed.success) {
      state = parsed.data;
      seenIndex = null;
    } else {
      log.warn(`Ignoring unreadable ${FILE} — the updates feed starts empty.`);
    }
  } catch (err) {
    log.warn({ err }, `Could not read ${FILE}`);
  }
  return state;
}

function writeNow(): void {
  pending = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const tmp = `${FILE}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, FILE);
  } catch (err) {
    log.warn({ err }, `Could not write ${FILE} — the updates feed is memory-only`);
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Nothing further to do; the rename already failed.
    }
  }
}

/**
 * How long writes are allowed to pile up before one goes out.
 *
 * Short enough that "wrote it down" is true by the time anything asks — the
 * feed is read over HTTP, which is milliseconds away at best — and long
 * enough to collapse the bursts this actually sees. `cron.changed` arrives
 * about four times per run and each arrival can touch the feed; a backend
 * flapping writes a row per attempt; a catch-up on restart appends a run at a
 * time. Each of those was a separate `writeFileSync` plus `renameSync` on the
 * event loop, which is where the proxy is also piping response bodies and
 * bridging a WebSocket.
 */
const PERSIST_DEBOUNCE_MS = 250;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: null | true = null;

/**
 * Write now if nothing was written recently; otherwise write once, shortly.
 *
 * Leading edge, not trailing, and that is the whole design. A feed that is
 * mutated once — the ordinary case, and every case a reader cares about — is
 * on disk before the call returns, exactly as it was before: "appended" and
 * "recorded" stay the same statement. What the debounce removes is the
 * *burst*, where the same second's worth of `cron.changed` nudges, or a
 * catch-up appending a run at a time, each paid for their own `writeFileSync`
 * plus `renameSync` on the event loop the proxy is also using to pipe response
 * bodies and bridge a WebSocket.
 *
 * The loss window is therefore one cooldown interval, and only for writes that
 * arrived while another was already going out — over a store capped at 300
 * entries, failing in the direction the feed already tolerates: an entry that
 * was pushed but not recorded, which is indistinguishable from one that
 * happened while the proxy was down. Shutdown calls `flushFeed`.
 */
function persist(): void {
  if (timer) {
    pending = true;
    return;
  }
  writeNow();
  timer = setTimeout(() => {
    timer = null;
    if (pending) writeNow();
  }, PERSIST_DEBOUNCE_MS);
  // The cooldown must never be the reason the process stays alive.
  timer.unref?.();
}

/**
 * Write anything outstanding right now.
 *
 * Called on shutdown. Without it the `unref` above means a proxy stopping
 * inside the debounce window drops whatever it was about to write — which is
 * most likely to be the row explaining why it stopped.
 */
export function flushFeed(): void {
  if (pending) writeNow();
  else if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

let seq = 0;

/**
 * Append one run to the feed, oldest first in storage.
 *
 * `at` is supplied by the caller because it is the moment the *run* ended, not
 * the moment the proxy noticed — those differ by the settle delay, and by
 * however long the proxy was down when it catches up on restart.
 */
export function appendEntry(entry: FeedEntryInput): FeedEntry {
  const rows = load().entries;
  // Time plus a counter: two runs completing in the same millisecond are
  // unlikely but a duplicate key would silently drop one from the list.
  const row: FeedEntry = {
    source: 'cron',
    dedupeKey: null,
    ...entry,
    // Cron does not compute a severity; it computes `failed`, which says the
    // same thing for the only two outcomes a run has.
    severity: entry.severity ?? (entry.failed ? 'error' : 'ok'),
    id: `${Date.now().toString(36)}-${seq++}`,
  };
  rows.push(row);
  if (rows.length > MAX_ENTRIES) rows.splice(0, rows.length - MAX_ENTRIES);
  if (row.runId) markRunSeen(row.runId, false);
  persist();
  return row;
}

/**
 * How long a repeat of the same thing collapses into the row already there.
 *
 * The case this exists for is a backend that flaps: without it, a Hermes that
 * restarts in a loop writes a row per attempt and the feed becomes unreadable
 * exactly when there is something worth reading in it.
 */
const COLLAPSE_MS = 60_000;

/**
 * Append an update, collapsing an immediate repeat of the same thing.
 *
 * Only the *newest* row is considered, deliberately: this is "don't say that
 * twice in a row", not a dedupe memory. Two backend outages an hour apart are
 * two things that happened and both belong in the feed; `runId`/`seenRuns` is
 * the mechanism for "never announce this again".
 */
export function appendUpdate(entry: FeedEntryInput): FeedEntry {
  const rows = load().entries;
  const newest = rows[rows.length - 1];
  if (
    entry.dedupeKey &&
    newest?.dedupeKey === entry.dedupeKey &&
    entry.at - newest.at < COLLAPSE_MS
  ) {
    const row: FeedEntry = { ...newest, ...entry, id: newest.id };
    rows[rows.length - 1] = row;
    persist();
    return row;
  }
  return appendEntry(entry);
}

/** Whether this run has already produced an entry (or was adopted silently). */
export function hasRun(runId: string): boolean {
  return seenSet().has(runId);
}

/**
 * Whether a reconcile pass has ever completed.
 *
 * A fresh install adopts the gateway's existing history without announcing it;
 * everything after that first pass is news. The `seenRuns` fallback is for
 * feeds written before `seeded` existed — those have already adopted their
 * history, and re-seeding them would swallow a run.
 */
export function hasSeeded(): boolean {
  const s = load();
  return s.seeded || s.seenRuns.length > 0;
}

/** Record that the first pass finished, so the next one announces. */
export function markSeeded(): void {
  const s = load();
  if (s.seeded) return;
  s.seeded = true;
  persist();
}

export function markRunSeen(runId: string, write = true): void {
  const index = seenSet();
  if (index.has(runId)) return;
  const seen = load().seenRuns;
  seen.push(runId);
  index.add(runId);
  // Bounded well above MAX_ENTRIES: this is the memory that stops a cleared
  // feed from re-announcing everything, so it must outlive the entries.
  if (seen.length > MAX_ENTRIES * 4) {
    seen.splice(0, seen.length - MAX_ENTRIES * 4);
    // The dropped ids are no longer answers, so the index cannot keep them.
    seenIndex = null;
  }
  if (write) persist();
}

/**
 * The value last seen for `key`, or null the first time it is asked about.
 *
 * Null is the seeding signal and callers must treat it as such: on a first
 * sight there is no transition to report, only a value to remember. Reporting
 * on it would announce the entire existing board the first time the sweep ran.
 */
export function getWatermark(key: string): string | null {
  return load().watermarks[key] ?? null;
}

/** Remember `value` for `key`. A null value forgets it — for a deleted row. */
export function setWatermark(key: string, value: string | null): void {
  const marks = load().watermarks;
  if (value === null) {
    if (!(key in marks)) return;
    delete marks[key];
  } else {
    if (marks[key] === value) return;
    marks[key] = value;
  }
  persist();
}

/**
 * Drop every watermark under `prefix` that is not in `keep`.
 *
 * Without this the map grows by one entry per card ever created and never
 * shrinks — a board that is used properly deletes and archives cards
 * constantly, and their watermarks would outlive them for the life of the
 * install.
 */
export function pruneWatermarks(prefix: string, keep: ReadonlySet<string>): void {
  const marks = load().watermarks;
  let changed = false;
  for (const key of Object.keys(marks)) {
    if (!key.startsWith(prefix) || keep.has(key)) continue;
    delete marks[key];
    changed = true;
  }
  if (changed) persist();
}

/**
 * How many entries have landed since the screen was last opened.
 *
 * Counted rather than stored so it cannot drift: entries aging out of the
 * window or the feed being cleared both take their unread rows with them,
 * which is what a person means by "nothing new".
 */
export function unreadCount(): number {
  const s = load();
  return s.entries.reduce((n, e) => (e.at > s.lastReadAt ? n + 1 : n), 0);
}

export function lastReadAt(): number {
  return load().lastReadAt;
}

/**
 * Mark everything currently in the feed as read.
 *
 * Watermarked on the newest entry rather than on `Date.now()`: a run that
 * finishes in the same second the screen opens is news, and stamping the
 * clock would swallow it.
 */
export function markRead(): void {
  const s = load();
  const newest = s.entries.reduce((max, e) => Math.max(max, e.at), 0);
  if (newest <= s.lastReadAt) return;
  s.lastReadAt = newest;
  persist();
}

/** Newest first, which is the order the screen wants to render. */
export function listEntries(): FeedEntry[] {
  return [...load().entries]
    .reverse()
    .map((e) => ({ ...e, severity: e.severity ?? (e.failed ? 'error' : 'ok') }));
}

/**
 * Empty the feed, but remember the runs.
 *
 * `seenRuns` deliberately survives: clearing means "I have read these", not
 * "show them to me again", and the next reconcile pass reads the same run
 * history the gateway has always had.
 */
export function clearEntries(): number {
  const removed = load().entries.length;
  if (!removed) return 0;
  state.entries = [];
  persist();
  return removed;
}

export const feedFile = FILE;
