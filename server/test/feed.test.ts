/**
 * The updates feed.
 *
 * The properties worth pinning down are the ones that decide whether a person
 * gets told about a scheduled run exactly once: dedupe by run id, the
 * newest-first read order, and the rule that clearing the feed forgets the
 * *entries* but never the runs.
 *
 * Since the feed widened past cron there are two more: a file written by the
 * older shape still has to load (that file is somebody's history), and
 * `appendUpdate` has to collapse a repeat rather than let a flapping backend
 * bury everything else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hermes-feed-'));

vi.mock('../src/config.js', () => ({ stateDir: dir }));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Feed = typeof import('../src/push/feed.js');
let feed: Feed;

const FILE = join(dir, '.hermes-cron-feed.json');

const entry = (over: Partial<Parameters<Feed['appendEntry']>[0]> = {}) => ({
  at: Date.now(),
  kind: 'cron.changed',
  title: 'Nightly digest',
  body: '3 PRs need review',
  url: '/chat?session=r1',
  jobId: 'job-1',
  jobName: 'Nightly digest',
  runId: 'run-1',
  status: 'cron_complete',
  failed: false,
  sessionId: 'run-1',
  ...over,
});

beforeEach(async () => {
  /**
   * Settle the previous test's module before discarding it.
   *
   * Writes are debounced now (see `persist`), so a module instance can be
   * holding a `setTimeout` that still points at its own state. `resetModules`
   * does not cancel it: it would fire a quarter of a second later, write the
   * old test's feed back over the file this one just deleted, and hand the
   * *next* test whatever the last one happened to leave behind. Exactly the
   * shutdown case `flushFeed` exists for, which is why the export is reused
   * here rather than a test-only hatch being added.
   */
  feed?.flushFeed();
  rmSync(FILE, { force: true });
  vi.resetModules();
  feed = await import('../src/push/feed.js');
});

describe('appending', () => {
  it('gives every entry a distinct id', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(feed.appendEntry(entry({ runId: `run-${i}` })).id);
    expect(ids.size).toBe(50);
  });

  it('reads newest first', () => {
    feed.appendEntry(entry({ runId: 'run-1', title: 'first' }));
    feed.appendEntry(entry({ runId: 'run-2', title: 'second' }));
    expect(feed.listEntries().map((e) => e.title)).toEqual(['second', 'first']);
  });

  it('records the run as seen, so the next reconcile skips it', () => {
    expect(feed.hasRun('run-1')).toBe(false);
    feed.appendEntry(entry({ runId: 'run-1' }));
    expect(feed.hasRun('run-1')).toBe(true);
  });

  it('keeps the caller-supplied end time rather than stamping "now"', () => {
    const at = Date.parse('2026-01-02T03:04:05Z');
    expect(feed.appendEntry(entry({ at })).at).toBe(at);
  });

  it('caps the feed and drops the oldest', () => {
    for (let i = 0; i < 320; i++) feed.appendEntry(entry({ runId: `run-${i}`, title: `t${i}` }));
    const rows = feed.listEntries();
    expect(rows).toHaveLength(300);
    expect(rows[0]!.title).toBe('t319');
    expect(rows.at(-1)!.title).toBe('t20');
  });

  /**
   * The memory of which runs were announced has to outlive the entries
   * themselves, or a run that aged out of the list would be announced again
   * the next time the reconcile pass read the gateway's history.
   */
  it('still remembers a run whose entry has aged out', () => {
    feed.appendEntry(entry({ runId: 'ancient' }));
    for (let i = 0; i < 320; i++) feed.appendEntry(entry({ runId: `run-${i}` }));
    expect(feed.listEntries().some((e) => e.runId === 'ancient')).toBe(false);
    expect(feed.hasRun('ancient')).toBe(true);
  });
});

describe('seeding', () => {
  it('knows nothing on a fresh install', () => {
    expect(feed.hasSeeded()).toBe(false);
  });

  it('adopts a run without putting it in the feed', () => {
    feed.markRunSeen('run-1');
    expect(feed.hasRun('run-1')).toBe(true);
    expect(feed.listEntries()).toEqual([]);
  });

  /**
   * The seeding flag is what stops a fresh install announcing months of
   * history — and, just as importantly, it has to become true even when there
   * was no history to adopt. A job that has never run leaves `seenRuns` empty,
   * and inferring "seeded" from that emptiness swallowed the job's first real
   * run.
   */
  it('counts a completed pass as seeded even with nothing to adopt', () => {
    expect(feed.hasSeeded()).toBe(false);
    feed.markSeeded();
    expect(feed.hasSeeded()).toBe(true);
  });

  it('survives a restart as seeded', async () => {
    feed.markSeeded();
    vi.resetModules();
    const reopened = (await import('../src/push/feed.js')) as Feed;
    expect(reopened.hasSeeded()).toBe(true);
  });

  /**
   * A feed file written before the flag existed has already adopted its
   * history. Treating it as unseeded would re-adopt — and swallow — the next
   * run it saw.
   */
  it('treats a pre-existing seenRuns list as already seeded', async () => {
    writeFileSync(FILE, JSON.stringify({ entries: [], seenRuns: ['run-old'] }));
    vi.resetModules();
    const reopened = (await import('../src/push/feed.js')) as Feed;
    expect(reopened.hasSeeded()).toBe(true);
  });

  it('is idempotent', () => {
    feed.markRunSeen('run-1');
    feed.markRunSeen('run-1');
    expect(JSON.parse(readFileSync(FILE, 'utf8')).seenRuns).toEqual(['run-1']);
  });
});

describe('clearing', () => {
  it('reports how many entries went', () => {
    feed.appendEntry(entry({ runId: 'run-1' }));
    feed.appendEntry(entry({ runId: 'run-2' }));
    expect(feed.clearEntries()).toBe(2);
    expect(feed.listEntries()).toEqual([]);
  });

  it('is a no-op on an empty feed', () => {
    expect(feed.clearEntries()).toBe(0);
  });

  /**
   * "I have read these", not "show them to me again". The reconcile pass reads
   * the same gateway history every time, so forgetting the run ids here would
   * re-announce every run the moment the user tidied up.
   */
  it('never re-announces a cleared run', () => {
    feed.appendEntry(entry({ runId: 'run-1' }));
    feed.clearEntries();
    expect(feed.hasRun('run-1')).toBe(true);
    expect(feed.hasSeeded()).toBe(true);
  });
});

describe('persistence', () => {
  it('survives a restart', async () => {
    feed.appendEntry(entry({ runId: 'run-1', title: 'kept' }));
    vi.resetModules();
    const reopened = (await import('../src/push/feed.js')) as Feed;
    expect(reopened.listEntries()[0]!.title).toBe('kept');
    expect(reopened.hasRun('run-1')).toBe(true);
  });

  it('writes with owner-only permissions', () => {
    feed.appendEntry(entry());
    expect(statSync(FILE).mode & 0o777).toBe(0o600);
  });

  it('starts empty rather than throwing on a corrupt file', async () => {
    writeFileSync(FILE, 'not json at all');
    vi.resetModules();
    const reopened = (await import('../src/push/feed.js')) as Feed;
    expect(reopened.listEntries()).toEqual([]);
    expect(reopened.hasSeeded()).toBe(false);
  });

  it('fills in defaults for a partially written entry', async () => {
    writeFileSync(
      FILE,
      JSON.stringify({ entries: [{ id: 'x', at: 1, body: 'terse' }], seenRuns: [] }),
    );
    vi.resetModules();
    const reopened = (await import('../src/push/feed.js')) as Feed;
    const row = reopened.listEntries()[0]!;
    expect(row.title).toBe('Scheduled job');
    expect(row.kind).toBe('cron.changed');
    expect(row.failed).toBe(false);
  });
});

describe('lookup cost', () => {
  /**
   * `hasRun` is called once per run in the gateway's history on every
   * reconcile pass, and the seen-run list is bounded at four figures. A linear
   * scan per lookup makes that quadratic in the size of the history.
   */
  it('answers a full seen-list quickly', () => {
    for (let i = 0; i < 1200; i++) feed.markRunSeen(`run-${i}`, false);
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) feed.hasRun(`run-${i % 1200}`);
    expect(performance.now() - started).toBeLessThan(150);
  });
});

describe('entries written before the feed widened past cron', () => {
  /**
   * The stored file predates `source`, `severity`, `dedupeKey` and
   * `lastReadAt`. It is the only copy of that history, so the schema has to
   * read it rather than warn and start empty.
   */
  it('loads and defaults the fields it has never heard of', async () => {
    writeFileSync(
      FILE,
      JSON.stringify({
        entries: [
          {
            id: 'old-1',
            at: 1_700_000_000_000,
            kind: 'cron.changed',
            title: 'Nightly digest',
            body: '3 PRs need review',
            url: '/chat?session=r1',
            jobId: 'j',
            jobName: 'Nightly digest',
            runId: 'r1',
            status: 'cron_complete',
            failed: false,
            sessionId: 'r1',
          },
        ],
        seeded: true,
        seenRuns: ['r1'],
      }),
    );
    vi.resetModules();
    feed = await import('../src/push/feed.js');

    const rows = feed.listEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Nightly digest', source: 'cron', severity: 'ok' });
    // Everything is unread on a file that never carried a watermark, which is
    // the honest answer: nobody has opened the screen since it gained one.
    expect(feed.unreadCount()).toBe(1);
  });

  it('reads a failed run as an error even though it stored no severity', async () => {
    writeFileSync(
      FILE,
      JSON.stringify({
        entries: [
          {
            id: 'old-2',
            at: 1_700_000_000_000,
            kind: 'cron.failed',
            title: 'Nightly digest',
            body: 'did not run',
            url: '/cron',
            failed: true,
          },
        ],
      }),
    );
    vi.resetModules();
    feed = await import('../src/push/feed.js');
    expect(feed.listEntries()[0]?.severity).toBe('error');
  });
});

describe('appendUpdate', () => {
  const update = (over: Record<string, unknown> = {}) =>
    entry({
      kind: 'backend.down',
      source: 'system' as const,
      severity: 'warn' as const,
      dedupeKey: 'backend-state',
      runId: null,
      jobId: null,
      jobName: null,
      sessionId: null,
      ...over,
    });

  it('collapses a repeat of the same thing into the row already there', () => {
    const now = Date.now();
    feed.appendUpdate(update({ at: now, body: 'went offline' }));
    feed.appendUpdate(update({ at: now + 5_000, body: 'still offline' }));

    const rows = feed.listEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe('still offline');
  });

  /**
   * Two outages an hour apart are two things that happened. Collapsing them
   * would mean the feed could never show that the backend went down twice.
   */
  it('keeps a repeat that arrives long enough afterwards', () => {
    const now = Date.now();
    feed.appendUpdate(update({ at: now, body: 'first outage' }));
    feed.appendUpdate(update({ at: now + 10 * 60_000, body: 'second outage' }));
    expect(feed.listEntries().map((e) => e.body)).toEqual(['second outage', 'first outage']);
  });

  it('never collapses onto a row that is not the newest', () => {
    const now = Date.now();
    feed.appendUpdate(update({ at: now, body: 'went offline' }));
    feed.appendEntry(entry({ at: now + 1_000, runId: 'run-x', title: 'Nightly' }));
    feed.appendUpdate(update({ at: now + 2_000, body: 'still offline' }));
    expect(feed.listEntries()).toHaveLength(3);
  });

  it('appends when there is no key to collapse on', () => {
    const now = Date.now();
    feed.appendUpdate(update({ at: now, dedupeKey: null, body: 'one' }));
    feed.appendUpdate(update({ at: now + 100, dedupeKey: null, body: 'two' }));
    expect(feed.listEntries()).toHaveLength(2);
  });
});

describe('read tracking', () => {
  it('counts everything as unread until the screen is opened', () => {
    feed.appendEntry(entry({ runId: 'r1', at: 1_000 }));
    feed.appendEntry(entry({ runId: 'r2', at: 2_000 }));
    expect(feed.unreadCount()).toBe(2);
    feed.markRead();
    expect(feed.unreadCount()).toBe(0);
  });

  /**
   * The watermark is the newest entry's timestamp, not the clock. Stamping the
   * clock would swallow a run that finished in the same second the screen
   * opened — the one case where the badge matters most.
   */
  it('leaves an entry that lands afterwards unread', () => {
    feed.appendEntry(entry({ runId: 'r1', at: 1_000 }));
    feed.markRead();
    feed.appendEntry(entry({ runId: 'r2', at: 2_000 }));
    expect(feed.unreadCount()).toBe(1);
  });

  it('survives a reload, so a phone picked up later shows the same badge', async () => {
    feed.appendEntry(entry({ runId: 'r1', at: 1_000 }));
    feed.markRead();
    feed.appendEntry(entry({ runId: 'r2', at: 2_000 }));

    vi.resetModules();
    feed = await import('../src/push/feed.js');
    expect(feed.unreadCount()).toBe(1);
  });

  it('clearing the feed leaves nothing unread', () => {
    feed.appendEntry(entry({ runId: 'r1', at: 1_000 }));
    feed.clearEntries();
    expect(feed.unreadCount()).toBe(0);
  });
});

/**
 * Writing to disk, now that writes are debounced.
 *
 * The debounce exists to keep bursts off the event loop (`persist` in
 * `feed.ts`), and it is only safe because it fires on the leading edge — the
 * first write of a burst goes out synchronously, so "appended" and "on disk"
 * remain the same statement for every caller that is not already in a burst.
 * These pin that, because getting it wrong is the kind of bug that only shows
 * up as a feed missing the row explaining why the proxy stopped.
 */
describe('persistence', () => {
  it('writes the first append straight through', () => {
    feed.appendEntry(entry({ runId: 'r1' }));
    const onDisk = JSON.parse(readFileSync(FILE, 'utf8')) as { entries: unknown[] };
    expect(onDisk.entries).toHaveLength(1);
  });

  it('collapses a burst into fewer writes than appends', () => {
    // The case this exists for: `cron.changed` arrives about four times a run,
    // and a catch-up on restart appends a run at a time.
    feed.appendEntry(entry({ runId: 'r1' }));
    const first = statSync(FILE).mtimeMs;
    for (let i = 2; i <= 20; i++) feed.appendEntry(entry({ runId: `r${i}` }));

    // Still the first write's file: the other nineteen are waiting.
    const onDisk = JSON.parse(readFileSync(FILE, 'utf8')) as { entries: unknown[] };
    expect(onDisk.entries).toHaveLength(1);
    expect(statSync(FILE).mtimeMs).toBe(first);

    // …and in memory nothing was lost.
    expect(feed.listEntries()).toHaveLength(20);
  });

  it('flushes what a burst left pending', () => {
    // What shutdown calls. Without it a proxy stopping inside the cooldown
    // drops the rows it had queued — most likely including the one saying why.
    for (let i = 1; i <= 5; i++) feed.appendEntry(entry({ runId: `r${i}` }));
    feed.flushFeed();
    const onDisk = JSON.parse(readFileSync(FILE, 'utf8')) as { entries: unknown[] };
    expect(onDisk.entries).toHaveLength(5);
  });

  it('is a no-op to flush when nothing is pending', () => {
    feed.appendEntry(entry({ runId: 'r1' }));
    expect(() => {
      feed.flushFeed();
      feed.flushFeed();
    }).not.toThrow();
    expect((JSON.parse(readFileSync(FILE, 'utf8')) as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('survives a reload with everything flushed', async () => {
    for (let i = 1; i <= 5; i++) feed.appendEntry(entry({ runId: `r${i}` }));
    feed.flushFeed();

    vi.resetModules();
    feed = await import('../src/push/feed.js');
    expect(feed.listEntries()).toHaveLength(5);
  });
});
