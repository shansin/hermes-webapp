/**
 * The cron reconcile pass.
 *
 * `cron.changed` carries nothing, so everything a person is eventually told
 * comes out of this module going back to the gateway and reading the run and
 * job records. The tests drive `reconcile()` directly against a stubbed
 * gateway; the settle delay in front of it is the scheduler's business, not
 * this pass's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hermes-cron-'));

const clearToken = vi.fn();
vi.mock('../src/config.js', () => ({
  stateDir: dir,
  getToken: () => 'tok',
  resolveToken: async () => 'tok',
  clearToken,
  upstreamHttp: 'http://127.0.0.1:9119',
  upstreamHost: '127.0.0.1:9119',
}));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendPush = vi.fn(async () => 1);
vi.mock('../src/push/send.js', () => ({ sendPush: (m: unknown) => sendPush(m as never) }));

let devices = 1;
vi.mock('../src/push/store.js', () => ({
  listSubscriptions: () => (devices ? [{ subscription: { endpoint: 'e' } }] : []),
}));

type Cron = typeof import('../src/push/cron.js');
type Feed = typeof import('../src/push/feed.js');
let cron: Cron;
let feed: Feed;

/** Gateway responses, keyed by the path the pass will ask for. */
let routes: Record<string, unknown>;
/**
 * Responses keyed by path *and* query string, for the cases where the two
 * profiles of the same endpoint have to answer differently. `routes` ignores
 * the query, which is what almost every test wants.
 */
let routesUrl: Record<string, unknown>;
/** Paths that should answer with a status instead of a body. */
let statuses: Record<string, number>;
let requested: string[];
/** Same calls, with the query string — where the profile travels. */
let requestedUrls: string[];

beforeEach(async () => {
  // Feed writes are debounced, so the previous module instance may be holding
  // a timer pointed at its own state — see the same note in `feed.test.ts`.
  feed?.flushFeed();
  rmSync(join(dir, '.hermes-cron-feed.json'), { force: true });
  routes = {};
  routesUrl = {};
  statuses = {};
  requested = [];
  requestedUrls = [];
  devices = 1;
  sendPush.mockClear();
  clearToken.mockClear();
  vi.resetModules();

  vi.stubGlobal('fetch', async (url: string) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    requested.push(path);
    requestedUrls.push(path + parsed.search);
    const status = statuses[path];
    if (status) return new Response(null, { status });
    const key = path + parsed.search;
    const body = key in routesUrl ? routesUrl[key] : path in routes ? routes[path] : undefined;
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });
  });

  cron = await import('../src/push/cron.js');
  feed = await import('../src/push/feed.js');
});

const jobs = (...list: unknown[]) => {
  routes['/api/cron/jobs'] = { jobs: list };
};
const runs = (jobId: string, ...list: unknown[]) => {
  routes[`/api/cron/jobs/${jobId}/runs`] = { runs: list };
};
const messages = (runId: string, ...list: unknown[]) => {
  routes[`/api/sessions/${runId}/messages`] = { messages: list };
};

const job = (over: Record<string, unknown> = {}) => ({ id: 'job-1', name: 'Nightly digest', ...over });
const run = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  title: 'Nightly digest · Aug 19 22:24',
  ended_at: 1_755_000_000,
  end_reason: 'cron_complete',
  ...over,
});

/** Adopt whatever the gateway already has, so the next pass sees only news. */
async function seed(): Promise<void> {
  await cron.reconcile();
}

describe('seeding', () => {
  it('adopts existing history silently on a fresh install', async () => {
    jobs(job());
    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'All quiet.' });

    await cron.reconcile();

    expect(feed.listEntries()).toEqual([]);
    expect(sendPush).not.toHaveBeenCalled();
    expect(feed.hasRun('run-1')).toBe(true);
  });

  it('announces only what happened after the first pass', async () => {
    jobs(job());
    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'All quiet.' });
    await seed();

    runs('job-1', run(), run({ id: 'run-2', ended_at: 1_755_000_100 }));
    messages('run-2', { role: 'assistant', content: '3 PRs need review.' });
    await cron.reconcile();

    const entries = feed.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: 'run-2', body: '3 PRs need review.' });
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  /**
   * The install this feature is most likely to meet: a job created a moment
   * ago, which has never run. There is no history to adopt, so the seeding
   * pass has nothing to do — and the run that follows is the first thing the
   * user actually wants to be told about.
   */
  it('announces the first run of a job that had no history', async () => {
    jobs(job());
    runs('job-1');
    await seed();

    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'Digest ready.' });
    await cron.reconcile();

    expect(feed.listEntries()).toHaveLength(1);
    expect(feed.listEntries()[0]!.body).toBe('Digest ready.');
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it('announces the first run on an install with no jobs at seeding time', async () => {
    routes['/api/cron/jobs'] = { jobs: [] };
    await seed();

    jobs(job());
    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'Brand new job replied.' });
    await cron.reconcile();

    expect(feed.listEntries()).toHaveLength(1);
  });

  it('does not re-seed after the feed is cleared', async () => {
    jobs(job());
    runs('job-1', run());
    await seed();
    feed.clearEntries();

    await cron.reconcile();
    expect(feed.listEntries()).toEqual([]);
  });
});

describe('dedupe', () => {
  /**
   * Four `cron.changed` fire for a single run. Every one of them can trigger a
   * pass, and every pass re-reads the same run history — so the run id, not
   * the signal, is what decides whether a person is told.
   */
  it('announces a run once however many passes run', async () => {
    jobs(job());
    runs('job-1');
    await seed();

    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'Done.' });
    await cron.reconcile();
    await cron.reconcile();
    await cron.reconcile();

    expect(feed.listEntries()).toHaveLength(1);
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it('ignores a run that has not ended yet', async () => {
    jobs(job());
    runs('job-1');
    await seed();

    runs('job-1', run({ ended_at: null }));
    await cron.reconcile();
    expect(feed.listEntries()).toEqual([]);

    // …and picks it up once it has.
    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'Done.' });
    await cron.reconcile();
    expect(feed.listEntries()).toHaveLength(1);
  });
});

describe('what the entry says', () => {
  beforeEach(async () => {
    jobs(job());
    runs('job-1');
    await seed();
  });

  it("uses the agent's last reply as the body", async () => {
    runs('job-1', run());
    messages(
      'run-1',
      { role: 'user', content: 'run the digest' },
      { role: 'assistant', content: 'first pass' },
      { role: 'tool', content: 'ignored' },
      { role: 'assistant', content: '3 PRs need review, none urgent.' },
    );
    await cron.reconcile();
    expect(feed.listEntries()[0]!.body).toBe('3 PRs need review, none urgent.');
  });

  it('strips the timestamp the gateway stamps onto the title', async () => {
    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'ok' });
    await cron.reconcile();
    expect(feed.listEntries()[0]!.title).toBe('Nightly digest');
  });

  it('falls back to the job name when the run has no title', async () => {
    runs('job-1', run({ title: null }));
    messages('run-1', { role: 'assistant', content: 'ok' });
    await cron.reconcile();
    expect(feed.listEntries()[0]!.title).toBe('Nightly digest');
  });

  /**
   * The row keeps the reply as written — paragraph breaks and all — because
   * the card renders the whole thing. Storing the flattened banner text here
   * is what used to make a digest unreadable in the one place with room for
   * it.
   */
  it('keeps the reply whole, markdown and line breaks intact', async () => {
    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: '## Digest\n- one\n- two' });
    await cron.reconcile();
    expect(feed.listEntries()[0]!.body).toBe('## Digest\n- one\n- two');
  });

  /** The lock screen still gets one line, derived at send time. */
  it('flattens the same reply for the banner', async () => {
    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: '## Digest\n- one\n- two' });
    await cron.reconcile();
    expect(sendPush).toHaveBeenCalledWith(expect.objectContaining({ body: 'Digest one two' }));
  });

  /**
   * The cap is a bound on the file, not on the card. It sits well above the
   * real nightly digests (4300–4600 characters) precisely so it does not cut
   * the content the feed exists to keep.
   */
  it('caps a runaway reply so the feed file stays bounded', async () => {
    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'x'.repeat(20_000) });
    await cron.reconcile();
    const body = feed.listEntries()[0]!.body;
    expect(body.length).toBe(8000);
    expect(body.endsWith('…')).toBe(true);
  });

  it('leaves a real digest untouched', async () => {
    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'y'.repeat(4600) });
    await cron.reconcile();
    expect(feed.listEntries()[0]!.body).toBe('y'.repeat(4600));
  });

  it('names the job when the run produced no prose', async () => {
    runs('job-1', run());
    messages('run-1', { role: 'tool', content: 'only tools ran' });
    await cron.reconcile();
    expect(feed.listEntries()[0]!.body).toBe('Nightly digest finished');
  });

  it('links the entry at the run’s own conversation', async () => {
    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'ok' });
    await cron.reconcile();
    expect(feed.listEntries()[0]!.url).toBe('/chat?session=run-1');
  });

  it('records when the run ended, not when the pass noticed', async () => {
    runs('job-1', run({ ended_at: 1_700_000_000 }));
    messages('run-1', { role: 'assistant', content: 'ok' });
    await cron.reconcile();
    expect(feed.listEntries()[0]!.at).toBe(1_700_000_000_000);
  });

  /**
   * The banner opens the feed rather than the single run: by the time a phone
   * is picked up there may be several waiting, and opening the newest buries
   * the rest.
   */
  it('points the banner at the feed', async () => {
    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'ok' });
    await cron.reconcile();
    expect(sendPush).toHaveBeenCalledWith(expect.objectContaining({ url: '/notifications' }));
  });

  it('accepts a bare array of messages as well as a wrapped one', async () => {
    runs('job-1', run());
    routes['/api/sessions/run-1/messages'] = [{ role: 'assistant', content: 'bare array' }];
    await cron.reconcile();
    expect(feed.listEntries()[0]!.body).toBe('bare array');
  });

  it('accepts a bare array of runs', async () => {
    routes['/api/cron/jobs/job-1/runs'] = [run()];
    messages('run-1', { role: 'assistant', content: 'ok' });
    await cron.reconcile();
    expect(feed.listEntries()).toHaveLength(1);
  });
});

describe('failed runs', () => {
  beforeEach(async () => {
    jobs(job());
    runs('job-1');
    await seed();
  });

  it.each(['error', 'agent_error', 'timeout', 'cancelled', 'interrupted', 'aborted'])(
    'marks end_reason %s as a failure',
    async (reason) => {
      runs('job-1', run({ end_reason: reason }));
      await cron.reconcile();
      expect(feed.listEntries()[0]).toMatchObject({ failed: true, body: 'Nightly digest failed' });
    },
  );

  it('treats an unrecognised end_reason as success', async () => {
    runs('job-1', run({ end_reason: 'something_new' }));
    messages('run-1', { role: 'assistant', content: 'ok' });
    await cron.reconcile();
    expect(feed.listEntries()[0]!.failed).toBe(false);
  });

  /**
   * A failed run's transcript is not a reply, so it is not fetched — one less
   * round trip on the path that matters least.
   */
  it('does not fetch the transcript of a failed run', async () => {
    runs('job-1', run({ end_reason: 'error' }));
    requested.length = 0;
    await cron.reconcile();
    expect(requested.some((p) => p.includes('/messages'))).toBe(false);
  });
});

describe('a job that never ran at all', () => {
  /**
   * The case this pass exists for: Hermes refusing to run an unpinned job
   * after the global model changed. No agent turn means no session and no run
   * record, so the run-history pass below cannot see it — and "your job did
   * not run" is the single most important thing to be told.
   */
  it('reports a failure that produced no run record', async () => {
    jobs(job());
    runs('job-1');
    await seed();

    jobs(
      job({
        last_status: 'error',
        latest_execution: {
          id: 'exec-9',
          status: 'error',
          error: 'RuntimeError: Skipped to prevent unintended spend: model changed.',
          finished_at: 1_755_000_500,
        },
      }),
    );
    await cron.reconcile();

    const row = feed.listEntries()[0]!;
    expect(row.failed).toBe(true);
    expect(row.kind).toBe('cron.failed');
    expect(row.body).toBe('Skipped to prevent unintended spend: model changed.');
    expect(row.sessionId).toBeNull();
    expect(row.url).toBe('/cron?job=job-1');
    expect(row.at).toBe(1_755_000_500_000);
  });

  it('announces it once per attempt, not once per pass', async () => {
    jobs(job());
    runs('job-1');
    await seed();

    jobs(job({ latest_execution: { id: 'exec-9', status: 'error', error: 'boom' } }));
    await cron.reconcile();
    await cron.reconcile();
    expect(feed.listEntries()).toHaveLength(1);
  });

  /**
   * A job failing the same way every night must produce one notification per
   * night, not one ever — so when the gateway offers no execution id the
   * dedupe key falls back to the attempt time.
   */
  it('re-announces a repeat failure at a new time', async () => {
    jobs(job());
    runs('job-1');
    await seed();

    jobs(job({ last_status: 'error', last_error: 'boom', last_run_at: '2026-01-01T00:00:00Z' }));
    await cron.reconcile();
    jobs(job({ last_status: 'error', last_error: 'boom', last_run_at: '2026-01-02T00:00:00Z' }));
    await cron.reconcile();

    expect(feed.listEntries()).toHaveLength(2);
  });

  it('stays quiet for a job whose last attempt succeeded', async () => {
    jobs(job());
    runs('job-1');
    await seed();

    jobs(job({ last_status: 'ok', latest_execution: { id: 'exec-9', status: 'success' } }));
    await cron.reconcile();
    expect(feed.listEntries()).toEqual([]);
  });

  it('adopts an existing failure silently while seeding', async () => {
    jobs(job({ last_status: 'error', latest_execution: { id: 'exec-1', status: 'error' } }));
    runs('job-1');
    await cron.reconcile();
    expect(feed.listEntries()).toEqual([]);
    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe('when nobody is subscribed', () => {
  /**
   * The feed is the record of what happened while nothing was connected, so it
   * is written whether or not a phone is registered to be told about it.
   */
  it('still writes the feed with no push devices', async () => {
    devices = 0;
    jobs(job());
    runs('job-1');
    await seed();

    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'ok' });
    await cron.reconcile();

    expect(feed.listEntries()).toHaveLength(1);
    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe('a gateway that is not answering', () => {
  it('does nothing when the job list is unavailable', async () => {
    statuses['/api/cron/jobs'] = 500;
    await expect(cron.reconcile()).resolves.toBeUndefined();
    expect(feed.hasSeeded()).toBe(false);
  });

  /**
   * Critically, a failed fetch must not count as "seeded". Marking the install
   * as known while the gateway was down would silently swallow the first real
   * run once it came back.
   */
  it('does not consume the seeding pass when the gateway is down', async () => {
    statuses['/api/cron/jobs'] = 503;
    await cron.reconcile();

    delete statuses['/api/cron/jobs'];
    jobs(job());
    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'ok' });
    await cron.reconcile();

    expect(feed.listEntries()).toEqual([]);
    expect(feed.hasRun('run-1')).toBe(true);
  });

  it('drops a stale token on a 401 so the next call re-resolves', async () => {
    statuses['/api/cron/jobs'] = 401;
    await cron.reconcile();
    expect(clearToken).toHaveBeenCalled();
  });

  it('skips a job whose runs cannot be read, without abandoning the pass', async () => {
    jobs(job(), job({ id: 'job-2', name: 'Other' }));
    runs('job-1');
    runs('job-2');
    await seed();

    statuses['/api/cron/jobs/job-1/runs'] = 500;
    runs('job-2', run({ id: 'run-2' }));
    messages('run-2', { role: 'assistant', content: 'other job replied' });
    await cron.reconcile();

    expect(feed.listEntries()).toHaveLength(1);
    expect(feed.listEntries()[0]!.body).toBe('other job replied');
  });

  it('survives a network error outright', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(cron.reconcile()).resolves.toBeUndefined();
  });
});

describe('malformed gateway payloads', () => {
  it.each([
    ['a job with no id', { jobs: [{ name: 'nameless' }] }],
    ['a null job list', { jobs: null }],
    ['a job list of the wrong type', { jobs: 'nope' }],
    ['an object where an array belongs', {}],
  ])('survives %s', async (_label, body) => {
    routes['/api/cron/jobs'] = body;
    await expect(cron.reconcile()).resolves.toBeUndefined();
  });

  it('survives runs with no ids', async () => {
    jobs(job());
    routes['/api/cron/jobs/job-1/runs'] = { runs: [{ ended_at: 1 }, null, 'nonsense'] };
    await expect(cron.reconcile()).resolves.toBeUndefined();
  });

  it('survives messages of the wrong shape', async () => {
    jobs(job());
    runs('job-1');
    await seed();
    runs('job-1', run());
    routes['/api/sessions/run-1/messages'] = { messages: [null, 42, { role: 'assistant' }] };
    await cron.reconcile();
    expect(feed.listEntries()[0]!.body).toBe('Nightly digest finished');
  });
});

/**
 * A run filed under a different profile than the job.
 *
 * A session row is written by whichever gateway *executed* the job, into that
 * process's own home, and only tagged with the profile it ran as. One gateway
 * ticking every profile's cron store — the shape of any machine where a
 * profile's own gateway is not running — therefore runs a `fitness` job
 * correctly and files its session under `default`.
 *
 * The runs endpoint cannot see it from either direction: an omitted profile
 * makes Hermes look the job's own profile up (`profile or
 * _find_cron_job_profile(job_id)`) and open that store, so scoped and unscoped
 * are the same request. The fallback reads `/api/sessions?source=cron`, whose
 * omitted profile *is* the active store.
 *
 * This went unnoticed on a live install for five days because it is silent and
 * asymmetric: `reportFailedExecution` reads the job record rather than the runs
 * endpoint, so failures kept arriving while every successful run vanished.
 */
describe('a run filed outside its job\'s profile', () => {
  const scoped = '/api/cron/jobs/job-2/runs?profile=fitness';
  const sessions = '/api/sessions?source=cron&limit=100';
  const runId = 'cron_job-2_20260830_063037';

  beforeEach(() => {
    jobs(job({ id: 'job-2', name: 'Suggested training today', profile: 'fitness' }));
    routesUrl[scoped] = { runs: [] };
    routesUrl[sessions] = { sessions: [run({ id: runId })] };
    messages(runId, { role: 'assistant', content: '5 × 1,000 m at goal pace.' });
  });

  it('finds the run in the active session store when its profile reports none', async () => {
    await seed();
    routesUrl[sessions] = {
      sessions: [run({ id: runId }), run({ id: 'cron_job-2_20260831_063041', ended_at: 1_755_000_100 })],
    };
    messages('cron_job-2_20260831_063041', { role: 'assistant', content: 'Easy 4 miles.' });

    await cron.reconcile();

    const entries = feed.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.body).toBe('Easy 4 miles.');
  });

  /**
   * The reply and the link have to follow the store that answered, not the
   * job's profile. Sending either to `profile=fitness` 404s, and the reply's
   * 404 is silent — the row still goes out, saying "<job> finished" where the
   * agent's actual reply should be.
   */
  it('reads the reply from the store that answered', async () => {
    await seed();
    routesUrl[sessions] = {
      sessions: [run({ id: runId }), run({ id: 'cron_job-2_x', ended_at: 1_755_000_100 })],
    };
    messages('cron_job-2_x', { role: 'assistant', content: 'Threshold day.' });

    await cron.reconcile();

    expect(requestedUrls).toContain('/api/sessions/cron_job-2_x/messages');
    expect(requestedUrls).not.toContain('/api/sessions/cron_job-2_x/messages?profile=fitness');
    expect(feed.listEntries()[0]!.body).toBe('Threshold day.');
  });

  it('points the row at the store that holds the session', async () => {
    await seed();
    routesUrl[sessions] = {
      sessions: [run({ id: runId }), run({ id: 'cron_job-2_y', ended_at: 1_755_000_100 })],
    };
    await cron.reconcile();

    expect(feed.listEntries()[0]!.url).toBe('/chat?session=cron_job-2_y');
  });

  /**
   * The page holds every profile's cron sessions, so the prefix is the only
   * thing binding a row to this job. Another job's runs must not be adopted.
   */
  it('ignores cron sessions belonging to a different job', async () => {
    await seed();
    routesUrl[sessions] = {
      sessions: [run({ id: 'cron_other-job_20260830_070000', ended_at: 1_755_000_100 })],
    };
    messages('cron_other-job_20260830_070000', { role: 'assistant', content: 'Not yours.' });

    await cron.reconcile();

    expect(feed.listEntries()).toEqual([]);
    expect(sendPush).not.toHaveBeenCalled();
  });

  /**
   * The normal topology keeps its addressing: a run its own profile reported
   * is still read and linked through that profile, and appearing in the active
   * store's cron page as well must not duplicate it.
   */
  it('keeps a run its profile reported addressed to that profile', async () => {
    routesUrl[scoped] = { runs: [run({ id: 'run-9' })] };
    routesUrl[sessions] = { sessions: [] };
    messages('run-9', { role: 'assistant', content: 'Scoped.' });
    await seed();

    routesUrl[scoped] = { runs: [run({ id: 'run-9' }), run({ id: 'run-10', ended_at: 1_755_000_100 })] };
    // The same run also visible in the active store's page.
    routesUrl[sessions] = { sessions: [run({ id: 'run-10', ended_at: 1_755_000_100 })] };
    messages('run-10', { role: 'assistant', content: 'Still scoped.' });
    await cron.reconcile();

    const entries = feed.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.url).toBe('/chat?session=run-10&profile=fitness');
    expect(requestedUrls).toContain('/api/sessions/run-10/messages?profile=fitness');
  });

  /**
   * The merge costs one request per pass, not one per job — the reason it can
   * run unconditionally rather than only when a profile looks empty.
   */
  it('reads the cron session page once per pass', async () => {
    jobs(
      job({ id: 'job-2', name: 'Suggested training today', profile: 'fitness' }),
      job({ id: 'job-3', name: 'Another', profile: 'research' }),
    );
    await cron.reconcile();

    expect(requestedUrls.filter((u) => u === sessions)).toHaveLength(1);
  });
});

/**
 * A job in another profile.
 *
 * The list endpoint defaults to `profile=all`, so these arrive here mixed in
 * with the active profile's own — but every read *about* one of them is
 * profile-scoped, and both ways of getting it wrong are silent. An unqualified
 * runs call is resolved by Hermes against every store, matching on id or name;
 * an unqualified messages call 404s, which does not suppress the notification,
 * it just empties it of the one thing worth reading.
 */
describe('a job belonging to another profile', () => {
  beforeEach(async () => {
    jobs(job({ id: 'job-2', name: 'Suggested training today', profile: 'fitness' }));
    runs('job-2');
    await seed();
  });

  it('asks for that profile\'s run history, not whatever matches the name first', async () => {
    requestedUrls.length = 0;
    await cron.reconcile();
    expect(requestedUrls).toContain('/api/cron/jobs/job-2/runs?profile=fitness');
  });

  /**
   * The tap target. `ChatScreen` resumes against the active profile unless the
   * link names one, so a link without it reaches a store that has never heard
   * of this session and reports it as missing — the notification arrives and
   * then goes nowhere, which is worse than not arriving.
   */
  it('points the row at the session in its own profile', async () => {
    runs('job-2', run({ id: 'run-9' }));
    messages('run-9', { role: 'assistant', content: '6 miles easy.' });

    await cron.reconcile();

    expect(feed.listEntries()[0]!.url).toBe('/chat?session=run-9&profile=fitness');
  });

  it('reads the reply out of that profile\'s session store', async () => {
    runs('job-2', run({ id: 'run-9', title: 'Suggested training today · Aug 25 06:30' }));
    messages('run-9', { role: 'assistant', content: '6 miles easy.' });

    await cron.reconcile();

    expect(requestedUrls).toContain('/api/sessions/run-9/messages?profile=fitness');
    expect(feed.listEntries()[0]).toMatchObject({
      title: 'Suggested training today',
      body: '6 miles easy.',
    });
  });

  /**
   * The single-profile install, and the active profile on any other: an
   * omitted `profile` has always meant "the active one" and the endpoints are
   * addressed bare, exactly as before this existed.
   */
  it('leaves a job with no profile addressed bare', async () => {
    jobs(job());
    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'ok' });
    requestedUrls.length = 0;

    await cron.reconcile();

    expect(requestedUrls).toContain('/api/cron/jobs/job-1/runs');
    expect(requestedUrls.every((u) => !u.includes('profile='))).toBe(true);
    expect(feed.listEntries()[0]!.url).toBe('/chat?session=run-1');
  });
});

/**
 * The sweep.
 *
 * `cron.changed` is stat-ed off the *active* profile's `cron/jobs.json`, so a
 * run in any other profile moves no watched file and produces no signal at
 * all. The timer is the only thing that makes those runs arrive — and it is
 * wired to the same settle-delayed scheduler, so a sweep landing next to a
 * real signal collapses into one pass rather than two.
 */
describe('the sweep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cron.stopCronSweep();
    vi.useRealTimers();
  });

  it('reconciles without any signal', async () => {
    jobs(job({ id: 'job-2', profile: 'fitness' }));
    runs('job-2');
    await cron.reconcile();

    cron.startCronSweep();
    runs('job-2', run({ id: 'run-9' }));
    messages('run-9', { role: 'assistant', content: 'Tempo, 4 miles.' });

    await vi.advanceTimersByTimeAsync(3 * 60_000 + 2_500);
    await vi.waitFor(() => expect(feed.listEntries()).toHaveLength(1));
    expect(feed.listEntries()[0]).toMatchObject({ runId: 'run-9', body: 'Tempo, 4 miles.' });
  });

  it('stops when the proxy is shutting down', async () => {
    jobs(job());
    runs('job-1');
    await cron.reconcile();

    cron.startCronSweep();
    cron.stopCronSweep();

    runs('job-1', run());
    messages('run-1', { role: 'assistant', content: 'ok' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(feed.listEntries()).toEqual([]);
  });

  it('is idempotent — a second start does not double the passes', async () => {
    cron.startCronSweep();
    cron.startCronSweep();
    cron.stopCronSweep();
    // Nothing is scheduled once stopped, whatever the start count was.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(feed.listEntries()).toEqual([]);
  });
});
