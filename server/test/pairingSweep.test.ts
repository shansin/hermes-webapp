/**
 * The pairing sweep.
 *
 * A sender waiting to pair with a messaging bot is filed as a pending request
 * that expires in an hour, and nothing announced it — so the hour always ran
 * out. Every case below is a way that could be reported wrongly, silently:
 *
 * - **Announcing the backlog.** First sight of a *store* is not news: a fresh
 *   install, or a profile this proxy has never read, adopts what is pending.
 * - **Missing the news.** First sight of a *request* in a store already read
 *   is exactly the news — the rule every other sweep follows (first sight is
 *   silent) would swallow it.
 * - **Repeating it.** A request still pending a minute later is the same one.
 * - **Forgetting on a failed read**, which re-announces everything on recovery.
 * - **Reading one store.** The gateway keeps one per served profile.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hermes-pairing-'));

vi.mock('../src/config.js', () => ({
  stateDir: dir,
  getToken: () => 'tok',
  resolveToken: async () => 'tok',
  clearToken: vi.fn(),
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

type Pairing = typeof import('../src/push/pairing.js');
type Feed = typeof import('../src/push/feed.js');
let pairing: Pairing;
let feed: Feed;

/** Gateway responses keyed by `pathname + search`, so `?profile=` is addressable. */
let routes: Record<string, unknown>;
let requested: string[];

beforeEach(async () => {
  feed?.flushFeed();
  rmSync(join(dir, '.hermes-cron-feed.json'), { force: true });
  routes = {};
  requested = [];
  devices = 1;
  sendPush.mockClear();
  vi.resetModules();

  vi.stubGlobal('fetch', async (url: string) => {
    const parsed = new URL(url);
    const key = parsed.pathname + parsed.search;
    requested.push(key);
    if (!(key in routes)) return new Response(null, { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      headers: { 'content-type': 'application/json' },
    });
  });

  pairing = await import('../src/push/pairing.js');
  feed = await import('../src/push/feed.js');
});

function profiles(...names: string[]) {
  routes['/api/profiles'] = { profiles: names.map((name) => ({ name })) };
}

const request = (over: Record<string, unknown> = {}) => ({
  platform: 'telegram',
  request_id: '0123456789abcdef',
  user_id: '42',
  user_name: 'Alice',
  age_minutes: 0,
  ...over,
});

function pending(profile: string, ...rows: Record<string, unknown>[]) {
  routes[`/api/pairing?profile=${profile}`] = { pending: rows, approved: [] };
}

const pushes = () => sendPush.mock.calls.map((c) => c[0] as unknown as Record<string, unknown>);

async function pass(): Promise<void> {
  await pairing.reconcilePairing();
  feed.flushFeed();
}

describe('seeding', () => {
  it('adopts what is already pending without announcing it', async () => {
    profiles('default');
    pending('default', request());

    await pass();

    expect(sendPush).not.toHaveBeenCalled();
    expect(feed.listEntries()).toHaveLength(0);
  });

  it('stays quiet across a restart, because the watermarks are persisted', async () => {
    profiles('default');
    pending('default', request());
    await pass();

    vi.resetModules();
    pairing = await import('../src/push/pairing.js');
    feed = await import('../src/push/feed.js');
    await pass();

    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe('a new request', () => {
  it('is announced once the store has been read before', async () => {
    profiles('default');
    pending('default');
    await pass();

    pending('default', request());
    await pass();

    expect(pushes()).toEqual([
      expect.objectContaining({
        body: 'New sender wants to pair: Telegram Alice',
        url: '/machine#pairing',
        kind: 'pairing.request',
      }),
    ]);
    const [entry] = feed.listEntries();
    expect(entry).toMatchObject({ kind: 'pairing.request', source: 'system', url: '/machine#pairing' });
  });

  it('is not repeated while it stays pending', async () => {
    profiles('default');
    pending('default');
    await pass();
    pending('default', request());
    await pass();
    await pass();

    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it('is announced again when the same sender asks again after it lapsed', async () => {
    profiles('default');
    pending('default');
    await pass();
    pending('default', request());
    await pass();
    pending('default');
    await pass();
    pending('default', request({ request_id: 'fedcba9876543210' }));
    await pass();

    expect(sendPush).toHaveBeenCalledTimes(2);
  });

  it('falls back to the sender id when a legacy entry has no request id', async () => {
    profiles('default');
    pending('default');
    await pass();
    pending('default', request({ request_id: '', user_name: '' }));
    await pass();

    expect(pushes()[0]).toMatchObject({ body: 'New sender wants to pair: Telegram 42' });
  });

  it('is still written to the feed with no device subscribed', async () => {
    devices = 0;
    profiles('default');
    pending('default');
    await pass();
    pending('default', request());
    await pass();

    expect(sendPush).not.toHaveBeenCalled();
    expect(feed.listEntries()).toHaveLength(1);
  });
});

describe('profiles', () => {
  it('reads every profile’s store and names the profile when there are several', async () => {
    profiles('default', 'research');
    pending('default');
    pending('research');
    await pass();

    pending('research', request({ platform: 'discord', user_name: 'bob' }));
    await pass();

    expect(requested).toContain('/api/pairing?profile=research');
    expect(pushes()[0]).toMatchObject({ body: 'New sender wants to pair: Discord bob (research)' });
  });

  it('seeds a profile it has never read silently, even after others were seeded', async () => {
    profiles('default');
    pending('default');
    await pass();

    profiles('default', 'fitness');
    pending('fitness', request());
    await pass();

    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe('a pass that reached nothing', () => {
  it('keeps its watermarks when the store cannot be read', async () => {
    profiles('default');
    pending('default', request());
    await pass();

    delete routes['/api/pairing?profile=default'];
    await pass();

    pending('default', request());
    await pass();

    expect(sendPush).not.toHaveBeenCalled();
  });

  it('skips the pass when the profile list cannot be read', async () => {
    await pass();
    expect(requested).toEqual(['/api/profiles']);
  });
});
