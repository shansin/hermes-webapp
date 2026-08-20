/**
 * The cron notification feed — the transcript behind the "Cron Notifications"
 * screen.
 *
 * This is the proxy's second piece of owned state, and it exists for the same
 * reason `events.ts` holds its own gateway socket: cron runs happen while
 * nothing is connected. A feed assembled in the browser from live WebSocket
 * events would only ever contain the runs that fired while the app happened to
 * be open, which is the opposite of what a scheduled job is for. The push
 * listener is already awake for all of them, so it writes them down here.
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
 * A daily job produces a few hundred a year, so this is roughly "the last
 * several months" for a normal setup and a hard ceiling on the file for a
 * pathological one. The screen renders the whole feed in one list, and past a
 * few hundred rows that stops being something anyone reads.
 */
const MAX_ENTRIES = 300;

const EntrySchema = z.object({
  /** Stable per entry so React keys and read-tracking survive a refetch. */
  id: z.string(),
  /** When the run *ended*, not when we noticed — epoch milliseconds. */
  at: z.number(),
  /** The gateway event type, so the feed can widen past cron later. */
  kind: z.string().default('cron.changed'),
  /** The job's name, shown as the entry's heading and as the banner title. */
  title: z.string().default('Scheduled job'),
  /** The agent's own reply where there was one — see `cron.ts`. */
  body: z.string(),
  /** Where tapping the entry goes: the run's conversation. */
  url: z.string().default('/cron'),
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

const FileSchema = z.object({
  entries: z.array(EntrySchema).default([]),
  /**
   * Run ids already accounted for, including those adopted silently on the
   * first pass and those whose entries have since aged out of `entries` or
   * been cleared. Kept separately so clearing the feed does not cause every
   * run in the gateway's history to be re-announced.
   */
  seenRuns: z.array(z.string()).default([]),
});
type FileShape = z.infer<typeof FileSchema>;

const FILE = resolve(stateDir, '.hermes-cron-feed.json');

let state: FileShape = { entries: [], seenRuns: [] };
let loaded = false;

function load(): FileShape {
  if (loaded) return state;
  loaded = true;
  if (!existsSync(FILE)) return state;
  try {
    const parsed = FileSchema.safeParse(JSON.parse(readFileSync(FILE, 'utf8')));
    if (parsed.success) {
      state = parsed.data;
    } else {
      log.warn(`Ignoring unreadable ${FILE} — the cron notification feed starts empty.`);
    }
  } catch (err) {
    log.warn({ err }, `Could not read ${FILE}`);
  }
  return state;
}

function persist(): void {
  const tmp = `${FILE}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, FILE);
  } catch (err) {
    log.warn({ err }, `Could not write ${FILE} — the cron feed is memory-only`);
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Nothing further to do; the rename already failed.
    }
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
export function appendEntry(entry: Omit<FeedEntry, 'id'>): FeedEntry {
  const rows = load().entries;
  // Time plus a counter: two runs completing in the same millisecond are
  // unlikely but a duplicate key would silently drop one from the list.
  const row: FeedEntry = { ...entry, id: `${Date.now().toString(36)}-${seq++}` };
  rows.push(row);
  if (rows.length > MAX_ENTRIES) rows.splice(0, rows.length - MAX_ENTRIES);
  if (row.runId) markRunSeen(row.runId, false);
  persist();
  return row;
}

/** Whether this run has already produced an entry (or was adopted silently). */
export function hasRun(runId: string): boolean {
  return load().seenRuns.includes(runId);
}

/**
 * Whether anything has ever been recorded.
 *
 * Distinguishes a fresh install — which adopts the gateway's existing history
 * without announcing it — from a feed the user has simply cleared.
 */
export function knowsAnyRun(): boolean {
  return load().seenRuns.length > 0;
}

export function markRunSeen(runId: string, write = true): void {
  const seen = load().seenRuns;
  if (seen.includes(runId)) return;
  seen.push(runId);
  // Bounded well above MAX_ENTRIES: this is the memory that stops a cleared
  // feed from re-announcing everything, so it must outlive the entries.
  if (seen.length > MAX_ENTRIES * 4) seen.splice(0, seen.length - MAX_ENTRIES * 4);
  if (write) persist();
}

/** Newest first, which is the order the screen wants to render. */
export function listEntries(): FeedEntry[] {
  return [...load().entries].reverse();
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
