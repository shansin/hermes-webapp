/**
 * Web push from the browser's side.
 *
 * Three separate pieces of state have to line up before a banner can arrive,
 * and the settings screen shows a different fix for each. Most of these tests
 * are about telling those apart — conflating "the proxy has push switched off"
 * with "this proxy predates push" pointed the user at a setting that was never
 * set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disablePush,
  enablePush,
  isIosSafari,
  isStandalone,
  pushStatus,
  pushSupported,
  sendTestPush,
} from '../src/lib/push';

const fetchMock = vi.fn();
const subscribe = vi.fn();
const getSubscription = vi.fn();
const requestPermission = vi.fn();
const unsubscribe = vi.fn(async () => true);

const subscription = {
  endpoint: 'https://push.example/device',
  unsubscribe,
  toJSON: () => ({ endpoint: 'https://push.example/device', keys: { p256dh: 'p', auth: 'a' } }),
};

/** Put the browser into a state where push is genuinely available. */
function grantSupport(): void {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { ready: Promise.resolve({ pushManager: { subscribe, getSubscription } }) },
    configurable: true,
  });
  (window as unknown as { PushManager: unknown }).PushManager = class {};
  (window as unknown as { Notification: unknown }).Notification = Object.assign(class {}, {
    permission: 'default',
    requestPermission,
  });
}

const setPermission = (value: string) => {
  (window as unknown as { Notification: { permission: string } }).Notification.permission = value;
};

const config = (body: unknown, ok = true) => ({ ok, json: async () => body });
const ENABLED = { enabled: true, publicKey: 'YWJjZA', devices: 1 };

beforeEach(() => {
  fetchMock.mockReset();
  subscribe.mockReset();
  getSubscription.mockReset();
  requestPermission.mockReset();
  unsubscribe.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  grantSupport();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('support detection', () => {
  it('reports available on a secure context with the APIs present', () => {
    expect(pushSupported()).toBe(true);
  });

  /**
   * Plain HTTP is the ordinary state of this app until TLS is configured, and
   * it is why the settings screen says "unsupported" rather than "denied".
   */
  it('reports unavailable outside a secure context', () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    expect(pushSupported()).toBe(false);
  });

  it('reports unavailable with no PushManager', () => {
    delete (window as unknown as { PushManager?: unknown }).PushManager;
    expect(pushSupported()).toBe(false);
  });
});

describe('platform hints', () => {
  const withUa = (ua: string, fn: () => void) => {
    const original = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(navigator, 'userAgent', { value: original, configurable: true });
    }
  };

  /**
   * iOS only exposes the Push API to an app installed to the home screen, so
   * "notifications don't work" on iPhone is usually this and not permissions.
   */
  it('recognises Safari on iOS', () => {
    withUa('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Safari', () =>
      expect(isIosSafari()).toBe(true),
    );
  });

  it('does not mistake Chrome on iOS for Safari', () => {
    withUa('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) CriOS/120.0 Mobile Safari', () =>
      expect(isIosSafari()).toBe(false),
    );
  });

  it('does not mistake a Mac for an iPhone', () => {
    withUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', () =>
      expect(isIosSafari()).toBe(false),
    );
  });

  it('reads Safari’s non-standard standalone flag', () => {
    (navigator as unknown as { standalone?: boolean }).standalone = true;
    expect(isStandalone()).toBe(true);
    delete (navigator as unknown as { standalone?: boolean }).standalone;
  });
});

describe('status', () => {
  it('reports unsupported before it asks the server anything', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    await expect(pushStatus()).resolves.toEqual({ state: 'unsupported', endpoint: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports server-off when the proxy has push switched off', async () => {
    fetchMock.mockResolvedValue(config({ enabled: false, publicKey: null, devices: 0 }));
    await expect(pushStatus()).resolves.toMatchObject({ state: 'server-off' });
  });

  /**
   * A proxy that predates push answers `/push/config` through the SPA
   * fallback: index.html, with a 200. Neither the status code nor a thrown
   * `res.json()` distinguishes that from a real answer — only the shape does.
   */
  it('reports server-unsupported when the config route is really the SPA shell', async () => {
    fetchMock.mockResolvedValue(config({ some: 'html-ish object' }));
    await expect(pushStatus()).resolves.toMatchObject({ state: 'server-unsupported' });
  });

  it('reports server-unsupported when the body will not parse at all', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('<!doctype html>');
      },
    });
    await expect(pushStatus()).resolves.toMatchObject({ state: 'server-unsupported' });
  });

  it('reports server-unsupported when offline', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(pushStatus()).resolves.toMatchObject({ state: 'server-unsupported' });
  });

  it('reports denied, which only the user can undo', async () => {
    fetchMock.mockResolvedValue(config(ENABLED));
    setPermission('denied');
    await expect(pushStatus()).resolves.toMatchObject({ state: 'denied' });
  });

  it('reports off when available but not yet subscribed', async () => {
    fetchMock.mockResolvedValue(config(ENABLED));
    setPermission('granted');
    getSubscription.mockResolvedValue(null);
    await expect(pushStatus()).resolves.toEqual({ state: 'off', endpoint: null });
  });

  it('reports on, with the endpoint the server stores this device under', async () => {
    fetchMock.mockResolvedValue(config(ENABLED));
    setPermission('granted');
    getSubscription.mockResolvedValue(subscription);
    await expect(pushStatus()).resolves.toEqual({
      state: 'on',
      endpoint: 'https://push.example/device',
    });
  });
});

describe('enabling', () => {
  it('asks, subscribes, and registers with the proxy', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/push/config' ? config(ENABLED) : { ok: true, json: async () => ({ ok: true }) },
    );
    requestPermission.mockResolvedValue('granted');
    getSubscription.mockResolvedValue(null);
    subscribe.mockResolvedValue(subscription);

    await expect(enablePush()).resolves.toMatchObject({ state: 'on' });

    const register = fetchMock.mock.calls.find(([u]: [string]) => u === '/push/subscribe');
    expect(register).toBeDefined();
    const body = JSON.parse(register![1].body);
    expect(body.subscription.endpoint).toBe('https://push.example/device');
    expect(body.label).toBeTypeOf('string');
  });

  /** `applicationServerKey` takes bytes; Safari has refused the string form. */
  it('passes the VAPID key as bytes', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/push/config' ? config(ENABLED) : { ok: true, json: async () => ({}) },
    );
    requestPermission.mockResolvedValue('granted');
    getSubscription.mockResolvedValue(null);
    subscribe.mockResolvedValue(subscription);

    await enablePush();
    const key = subscribe.mock.calls[0]![0].applicationServerKey;
    expect(key).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(key).toString()).toBe('abcd');
  });

  /**
   * The proxy's store is a file that can be deleted. A device that believes it
   * is subscribed while the server has never heard of it is the one failure
   * mode with no visible symptom, so an existing subscription is re-registered
   * rather than short-circuited.
   */
  it('re-registers an existing subscription rather than assuming the server knows', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/push/config' ? config(ENABLED) : { ok: true, json: async () => ({}) },
    );
    requestPermission.mockResolvedValue('granted');
    getSubscription.mockResolvedValue(subscription);

    await enablePush();

    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([u]: [string]) => u === '/push/subscribe')).toBe(true);
  });

  it('reports denied when the user says no', async () => {
    fetchMock.mockResolvedValue(config(ENABLED));
    requestPermission.mockResolvedValue('denied');
    await expect(enablePush()).resolves.toMatchObject({ state: 'denied' });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('reports off when the prompt is dismissed', async () => {
    fetchMock.mockResolvedValue(config(ENABLED));
    requestPermission.mockResolvedValue('default');
    await expect(enablePush()).resolves.toMatchObject({ state: 'off' });
  });

  it('does not prompt when the server cannot sign a push', async () => {
    fetchMock.mockResolvedValue(config({ enabled: false, publicKey: null, devices: 0 }));
    await expect(enablePush()).resolves.toMatchObject({ state: 'server-off' });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('throws when the proxy rejects the registration', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/push/config' ? config(ENABLED) : { ok: false, json: async () => ({}) },
    );
    requestPermission.mockResolvedValue('granted');
    getSubscription.mockResolvedValue(null);
    subscribe.mockResolvedValue(subscription);

    await expect(enablePush()).rejects.toThrow(/rejected/i);
  });
});

describe('disabling', () => {
  /**
   * Order matters: tell the server first, while the endpoint is still
   * readable. The reverse can leave the server sending to an endpoint it can
   * no longer be told to forget.
   */
  it('tells the server before dropping the local subscription', async () => {
    const order: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      order.push(url);
      return { ok: true, json: async () => ({}) };
    });
    unsubscribe.mockImplementation(async () => {
      order.push('local-unsubscribe');
      return true;
    });
    getSubscription.mockResolvedValue(subscription);

    await disablePush();

    expect(order).toEqual(['/push/unsubscribe', 'local-unsubscribe']);
  });

  it('drops the local subscription even when the server is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    getSubscription.mockResolvedValue(subscription);

    await expect(disablePush()).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('does nothing when there is no subscription', async () => {
    getSubscription.mockResolvedValue(null);
    await disablePush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the test banner', () => {
  it('reports how many devices it reached', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, delivered: 2 }) });
    await expect(sendTestPush()).resolves.toBe(2);
  });

  it('reports zero rather than undefined', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    await expect(sendTestPush()).resolves.toBe(0);
  });

  it('throws when the proxy refuses', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(sendTestPush()).rejects.toThrow();
  });
});
