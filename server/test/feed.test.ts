/**
 * The cron notification feed.
 *
 * The properties worth pinning down are the ones that decide whether a person
 * gets told about a scheduled run exactly once: dedupe by run id, the
 * newest-first read order, and the rule that clearing the feed forgets the
 * *entries* but never the runs.
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
