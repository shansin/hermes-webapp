/**
 * Web-push fan-out: how a refused or stalled send is classified.
 *
 * Getting this wrong is invisible in both directions. Treat a transient
 * failure as permanent and a phone is unsubscribed because a push service had
 * a bad minute; wait on a send with no deadline and one stalled endpoint holds
 * the session sweep's `running` flag for ever, so nothing is pushed again
 * until the proxy restarts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hermes-send-'));

vi.mock('../src/config.js', () => ({
  stateDir: dir,
  config: {
    PUSH_ENABLED: true,
    VAPID_SUBJECT: 'mailto:test@example.com',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
  },
}));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    generateVAPIDKeys: vi.fn(),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

type Send = typeof import('../src/push/send.js');
type Store = typeof import('../src/push/store.js');
let send: Send;
let store: Store;

const message = { title: 'Hem', body: 'done', url: '/chat', tag: 't', kind: 'test' };
const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

beforeEach(async () => {
  rmSync(join(dir, '.hermes-push.json'), { force: true });
  sendNotification.mockReset();
  vi.resetModules();
  store = await import('../src/push/store.js');
  send = await import('../src/push/send.js');
  store.saveSubscription(sub('https://push.example/a'), 'phone');
});

describe('sendPush', () => {
  it('bounds every send with a timeout', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    expect(await send.sendPush(message)).toBe(1);
    const options = sendNotification.mock.calls[0]![2] as { timeout?: number };
    expect(options.timeout).toBe(send.PUSH_SEND_TIMEOUT_MS);
    expect(send.PUSH_SEND_TIMEOUT_MS).toBeGreaterThan(0);
  });

  /** What web-push rejects with when the socket goes idle past the timeout. */
  it('treats a timed-out send as transient, keeping the subscription', async () => {
    sendNotification.mockRejectedValue(new Error('Socket timeout'));

    expect(await send.sendPush(message)).toBe(0);

    const [row] = store.listSubscriptions();
    expect(row).toBeDefined();
    expect(row!.failures).toBe(1);
    expect(row!.lastError).toBe('Socket timeout');
  });

  it('still drops a subscription the push service says is gone', async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error('Gone'), { statusCode: 410 }));
    await send.sendPush(message);
    expect(store.listSubscriptions()).toEqual([]);
  });

  it('does not let one failing device stop delivery to the others', async () => {
    store.saveSubscription(sub('https://push.example/b'), 'tablet');
    sendNotification.mockImplementation(async (s: { endpoint: string }) => {
      if (s.endpoint.endsWith('/a')) throw new Error('Socket timeout');
      return { statusCode: 201 };
    });

    expect(await send.sendPush(message)).toBe(1);
    const b = store.listSubscriptions().find((r) => r.subscription.endpoint.endsWith('/b'));
    expect(b!.lastSentAt).not.toBeNull();
  });
});
