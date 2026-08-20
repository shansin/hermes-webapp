/**
 * Push subscription storage.
 *
 * `config.js` is mocked so the store writes into a temp directory instead of
 * the repo root — importing it for real would have the test suite overwrite
 * the developer's actual `.hermes-push.json`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hermes-store-'));

vi.mock('../src/config.js', () => ({
  stateDir: dir,
  config: { PUSH_ENABLED: true, VAPID_SUBJECT: 'mailto:test@localhost' },
}));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Store = typeof import('../src/push/store.js');
let store: Store;

const sub = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
});

beforeEach(async () => {
  rmSync(join(dir, '.hermes-push.json'), { force: true });
  vi.resetModules();
  store = await import('../src/push/store.js');
});

afterEach(() => {
  rmSync(join(dir, '.hermes-push.json'), { force: true });
});

const onDisk = () => JSON.parse(readFileSync(join(dir, '.hermes-push.json'), 'utf8'));

describe('subscriptions', () => {
  it('starts empty when there is no file', () => {
    expect(store.listSubscriptions()).toEqual([]);
  });

  it('saves and persists a subscription', () => {
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    expect(store.listSubscriptions()).toHaveLength(1);
    expect(onDisk().subscriptions[0].label).toBe('iPhone');
  });

  /**
   * The client re-registers on every launch to survive a
   * `pushsubscriptionchange` it slept through. Accumulating a row per launch
   * would deliver the same banner N times to one phone.
   */
  it('upserts rather than duplicating an existing endpoint', () => {
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    expect(store.listSubscriptions()).toHaveLength(1);
  });

  it('keeps the existing label when a re-registration sends none', () => {
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    store.saveSubscription(sub('https://push.example/a'), '');
    expect(store.listSubscriptions()[0]!.label).toBe('iPhone');
  });

  it('refreshes the stored keys on re-registration', () => {
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    store.saveSubscription(
      { endpoint: 'https://push.example/a', keys: { p256dh: 'new-p', auth: 'new-a' } },
      '',
    );
    expect(store.listSubscriptions()[0]!.subscription.keys.p256dh).toBe('new-p');
  });

  it('keeps distinct endpoints apart', () => {
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    store.saveSubscription(sub('https://push.example/b'), 'Android');
    expect(store.listSubscriptions()).toHaveLength(2);
  });

  it('reports whether a removal actually happened', () => {
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    expect(store.removeSubscription('https://push.example/a')).toBe(true);
    expect(store.removeSubscription('https://push.example/a')).toBe(false);
    expect(store.listSubscriptions()).toEqual([]);
  });

  it('stamps lastSentAt only on the endpoints that were delivered to', () => {
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    store.saveSubscription(sub('https://push.example/b'), 'Android');
    store.markSent(['https://push.example/a']);

    const rows = store.listSubscriptions();
    expect(rows.find((r) => r.subscription.endpoint.endsWith('/a'))!.lastSentAt).toBeTypeOf('number');
    expect(rows.find((r) => r.subscription.endpoint.endsWith('/b'))!.lastSentAt).toBeNull();
  });

  it('does not rewrite the file for an empty delivery list', () => {
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    const before = statSync(join(dir, '.hermes-push.json')).mtimeMs;
    store.markSent([]);
    expect(statSync(join(dir, '.hermes-push.json')).mtimeMs).toBe(before);
  });
});

describe('persistence', () => {
  it('reloads what an earlier process wrote', async () => {
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    vi.resetModules();
    const reopened = (await import('../src/push/store.js')) as Store;
    expect(reopened.listSubscriptions()).toHaveLength(1);
  });

  /**
   * The subscriptions file holds an endpoint URL that is a bearer capability
   * for sending to that device — it must not be world-readable.
   */
  it('writes with owner-only permissions', () => {
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    expect(statSync(join(dir, '.hermes-push.json')).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind', () => {
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    expect(existsSync(join(dir, '.hermes-push.json.tmp'))).toBe(false);
  });

  it('starts clean rather than throwing on a corrupt file', async () => {
    writeFileSync(join(dir, '.hermes-push.json'), '{ this is not json');
    vi.resetModules();
    const reopened = (await import('../src/push/store.js')) as Store;
    expect(reopened.listSubscriptions()).toEqual([]);
  });

  it('starts clean rather than throwing on a schema mismatch', async () => {
    writeFileSync(join(dir, '.hermes-push.json'), JSON.stringify({ subscriptions: 'nope' }));
    vi.resetModules();
    const reopened = (await import('../src/push/store.js')) as Store;
    expect(reopened.listSubscriptions()).toEqual([]);
  });

  it('drops a row whose endpoint is not a URL rather than the whole file', async () => {
    writeFileSync(
      join(dir, '.hermes-push.json'),
      JSON.stringify({
        vapid: null,
        subscriptions: [{ subscription: { endpoint: 'not-a-url', keys: {} }, createdAt: 1 }],
      }),
    );
    vi.resetModules();
    const reopened = (await import('../src/push/store.js')) as Store;
    expect(reopened.listSubscriptions()).toEqual([]);
  });
});

describe('vapid keypair', () => {
  it('has none until one is stored', () => {
    expect(store.storedVapid()).toBeNull();
  });

  /**
   * Rotating the public key invalidates every existing subscription, so the
   * generated pair must survive a restart.
   */
  it('persists a generated keypair across a reload', async () => {
    store.storeVapid({ publicKey: 'pub', privateKey: 'priv' });
    vi.resetModules();
    const reopened = (await import('../src/push/store.js')) as Store;
    expect(reopened.storedVapid()).toEqual({ publicKey: 'pub', privateKey: 'priv' });
  });

  it('keeps subscriptions when the keypair is written', () => {
    store.saveSubscription(sub('https://push.example/a'), 'iPhone');
    store.storeVapid({ publicKey: 'pub', privateKey: 'priv' });
    expect(onDisk().subscriptions).toHaveLength(1);
  });
});
