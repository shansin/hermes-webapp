/**
 * The proxy's own HTTP surface: push subscription management and the cron
 * feed. Everything here is state the proxy owns, which is why it sits outside
 * `/api` — that prefix is forwarded verbatim to Hermes, which would 404.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hermes-routers-'));

vi.mock('../src/config.js', () => ({
  stateDir: dir,
  config: { PUSH_ENABLED: true, VAPID_SUBJECT: 'mailto:test@localhost' },
}));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let publicKey = 'BPublicKeyLooksLikeThis';
const sendPush = vi.fn(async () => 2);
vi.mock('../src/push/send.js', () => ({
  pushPublicKey: () => publicKey,
  pushEnabled: () => Boolean(publicKey),
  sendPush: (m: unknown) => sendPush(m as never),
}));

let pushRouter: typeof import('../src/routers/push.js')['pushRouter'];
let notificationsRouter: typeof import('../src/routers/notifications.js')['notificationsRouter'];
let feed: typeof import('../src/push/feed.js');

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  expirationTime: null,
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
};

const post = (path: string, body?: unknown) =>
  pushRouter.request(
    new Request(`http://proxy.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

beforeEach(async () => {
  rmSync(join(dir, '.hermes-push.json'), { force: true });
  rmSync(join(dir, '.hermes-cron-feed.json'), { force: true });
  publicKey = 'BPublicKeyLooksLikeThis';
  sendPush.mockClear();
  vi.resetModules();
  pushRouter = (await import('../src/routers/push.js')).pushRouter;
  notificationsRouter = (await import('../src/routers/notifications.js')).notificationsRouter;
  feed = await import('../src/push/feed.js');
});

describe('GET /push/config', () => {
  it('hands the client the key it needs to subscribe', async () => {
    const res = await pushRouter.request('http://proxy.test/push/config');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      publicKey: 'BPublicKeyLooksLikeThis',
      devices: 0,
    });
  });

  /**
   * The settings screen distinguishes "switched off" from "not there", so the
   * honest answer here is a payload with `enabled: false` — not an error, and
   * not a key that signs nothing.
   */
  it('reports honestly when push is switched off', async () => {
    publicKey = '';
    vi.resetModules();
    pushRouter = (await import('../src/routers/push.js')).pushRouter;
    const body = await (await pushRouter.request('http://proxy.test/push/config')).json();
    expect(body).toEqual({ enabled: false, publicKey: null, devices: 0 });
  });

  it('counts registered devices', async () => {
    await post('/push/subscribe', { subscription });
    const body = (await (await pushRouter.request('http://proxy.test/push/config')).json()) as {
      devices: number;
    };
    expect(body.devices).toBe(1);
  });
});

describe('POST /push/subscribe', () => {
  it('accepts a well-formed subscription', async () => {
    const res = await post('/push/subscribe', { subscription, label: 'iPhone' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, devices: 1 });
  });

  it('is idempotent for the same endpoint', async () => {
    await post('/push/subscribe', { subscription });
    const res = await post('/push/subscribe', { subscription });
    expect(await res.json()).toEqual({ ok: true, devices: 1 });
  });

  it.each([
    ['no body at all', undefined],
    ['an empty object', {}],
    ['a subscription with no keys', { subscription: { endpoint: 'https://a.example/x' } }],
    [
      'an endpoint that is not a URL',
      { subscription: { endpoint: 'not-a-url', keys: { p256dh: 'a', auth: 'b' } } },
    ],
    [
      'empty key material',
      { subscription: { endpoint: 'https://a.example/x', keys: { p256dh: '', auth: '' } } },
    ],
    ['a label past the cap', { subscription, label: 'x'.repeat(200) }],
  ])('rejects %s', async (_label, body) => {
    const res = await post('/push/subscribe', body);
    expect(res.status).toBe(400);
  });

  it('rejects a body that is not JSON', async () => {
    const res = await pushRouter.request(
      new Request('http://proxy.test/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('refuses when push has no identity to sign with', async () => {
    publicKey = '';
    vi.resetModules();
    pushRouter = (await import('../src/routers/push.js')).pushRouter;
    const res = await post('/push/subscribe', { subscription });
    expect(res.status).toBe(503);
  });
});

describe('POST /push/unsubscribe', () => {
  it('removes a registered device', async () => {
    await post('/push/subscribe', { subscription });
    const res = await post('/push/unsubscribe', { endpoint: subscription.endpoint });
    expect(await res.json()).toEqual({ ok: true, removed: true, devices: 0 });
  });

  it('reports an endpoint it never had', async () => {
    const res = await post('/push/unsubscribe', { endpoint: 'https://unknown.example/x' });
    expect(await res.json()).toEqual({ ok: true, removed: false, devices: 0 });
  });

  it.each([undefined, {}, { endpoint: '' }, { endpoint: 42 }])(
    'rejects a malformed request (%j)',
    async (body) => {
      expect((await post('/push/unsubscribe', body)).status).toBe(400);
    },
  );
});

describe('POST /push/test', () => {
  it('fans out to every device and reports the count', async () => {
    const res = await post('/push/test');
    expect(await res.json()).toEqual({ ok: true, delivered: 2 });
    expect(sendPush).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'push.test', url: '/settings' }),
    );
  });

  it('refuses when push is switched off', async () => {
    publicKey = '';
    vi.resetModules();
    pushRouter = (await import('../src/routers/push.js')).pushRouter;
    expect((await post('/push/test')).status).toBe(503);
  });
});

describe('the cron feed endpoint', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    at: 1,
    kind: 'cron.changed',
    title: 'Nightly',
    body: 'done',
    url: '/cron',
    jobId: 'j',
    jobName: 'Nightly',
    runId: 'r1',
    status: 'cron_complete',
    failed: false,
    sessionId: 'r1',
    ...over,
  });

  it('starts empty', async () => {
    const res = await notificationsRouter.request('http://proxy.test/push/feed');
    expect(await res.json()).toEqual({ entries: [], total: 0, unread: 0, lastReadAt: 0 });
  });

  it('counts unread until the screen says it has been read', async () => {
    feed.appendEntry(entry({ runId: 'r1', at: 1_000 }));
    feed.appendEntry(entry({ runId: 'r2', at: 2_000 }));

    const before = (await (
      await notificationsRouter.request('http://proxy.test/push/feed')
    ).json()) as { unread: number };
    expect(before.unread).toBe(2);

    const read = await notificationsRouter.request(
      new Request('http://proxy.test/push/feed/read', { method: 'POST' }),
    );
    expect(await read.json()).toEqual({ ok: true, unread: 0 });

    // And a run that lands afterwards is unread again — the watermark is a
    // timestamp, not a "seen everything" flag.
    feed.appendEntry(entry({ runId: 'r3', at: 3_000 }));
    const after = (await (
      await notificationsRouter.request('http://proxy.test/push/feed')
    ).json()) as { unread: number };
    expect(after.unread).toBe(1);
  });

  it('returns entries newest first with a total', async () => {
    feed.appendEntry(entry({ runId: 'r1', title: 'first' }));
    feed.appendEntry(entry({ runId: 'r2', title: 'second' }));
    const body = (await (
      await notificationsRouter.request('http://proxy.test/push/feed')
    ).json()) as { entries: { title: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.entries.map((e) => e.title)).toEqual(['second', 'first']);
  });

  it('clears the feed and reports how many went', async () => {
    feed.appendEntry(entry({ runId: 'r1' }));
    feed.appendEntry(entry({ runId: 'r2' }));
    const res = await notificationsRouter.request(
      new Request('http://proxy.test/push/feed', { method: 'DELETE' }),
    );
    expect(await res.json()).toEqual({ ok: true, removed: 2 });
    expect(feed.listEntries()).toEqual([]);
  });

  /**
   * `/notifications` is the SPA route this data is rendered on, and a push tap
   * from a cold start navigates straight to it. Owning that path on the server
   * would hand the browser JSON where it expected the app.
   */
  it('does not own the SPA route the data is rendered on', async () => {
    const res = await notificationsRouter.request('http://proxy.test/notifications');
    expect(res.status).toBe(404);
  });
});
