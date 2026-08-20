/**
 * `public/push-sw.js`, evaluated in a fake worker global.
 *
 * This file gets no type checking and no bundling — it is imported verbatim
 * into the Workbox-generated worker — and it runs in a context nobody can open
 * a devtools console on when it misbehaves. It is also the last hop of the
 * whole push feature: if it throws, the banner simply never appears.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../public/push-sw.js'), 'utf8');

interface FakeClient {
  focused: boolean;
  visibilityState: string;
  postMessage: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  navigate?: ReturnType<typeof vi.fn>;
}

interface Worker {
  listeners: Map<string, (event: unknown) => void>;
  showNotification: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
  windows: FakeClient[];
  fetch: ReturnType<typeof vi.fn>;
  /** Dispatch an event and await whatever it passed to `waitUntil`. */
  dispatch(type: string, event: Record<string, unknown>): Promise<void>;
}

const client = (over: Partial<FakeClient> = {}): FakeClient => ({
  focused: false,
  visibilityState: 'hidden',
  postMessage: vi.fn(),
  focus: vi.fn(),
  ...over,
});

/** Evaluate the worker source against a fresh, controllable global. */
function loadWorker(): Worker {
  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn(async () => {});
  const subscribe = vi.fn(async () => ({ endpoint: 'https://push.example/new' }));
  const openWindow = vi.fn(async () => null);
  const fetchMock = vi.fn();
  const windows: FakeClient[] = [];

  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    registration: { showNotification, pushManager: { subscribe } },
  };
  const clients = {
    matchAll: async () => windows,
    openWindow,
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'clients', 'Uint8Array', 'fetch', 'JSON', source)(
    self,
    clients,
    Uint8Array,
    fetchMock,
    JSON,
  );

  const waited: unknown[] = [];
  return {
    listeners,
    showNotification,
    subscribe,
    openWindow,
    windows,
    fetch: fetchMock,
    async dispatch(type, event) {
      const fn = listeners.get(type);
      if (!fn) throw new Error(`no ${type} listener registered`);
      fn({ waitUntil: (p: unknown) => waited.push(p), ...event });
      await Promise.all(waited.splice(0));
    },
  };
}

let worker: Worker;

beforeEach(() => {
  worker = loadWorker();
});

describe('registration', () => {
  it('registers the three listeners the feature needs', () => {
    expect([...worker.listeners.keys()].sort()).toEqual([
      'notificationclick',
      'push',
      'pushsubscriptionchange',
    ]);
  });
});

describe('push', () => {
  const pushEvent = (data: unknown) => ({ data: { json: () => data } });

  it('shows the banner the server composed', async () => {
    await worker.dispatch('push', pushEvent({ title: 'Hermes', body: 'Done.', url: '/chat' }));

    expect(worker.showNotification).toHaveBeenCalledWith(
      'Hermes',
      expect.objectContaining({ body: 'Done.', data: { url: '/chat' } }),
    );
  });

  it('collapses repeats under the server-chosen tag', async () => {
    await worker.dispatch('push', pushEvent({ body: 'x', tag: 'session:s1' }));
    expect(worker.showNotification.mock.calls[0]![1]).toMatchObject({
      tag: 'session:s1',
      renotify: true,
    });
  });

  it('falls back to defaults for a payload with nothing in it', async () => {
    await worker.dispatch('push', pushEvent({}));
    expect(worker.showNotification).toHaveBeenCalledWith(
      'Hermes',
      expect.objectContaining({ body: 'Something happened.', tag: 'hermes' }),
    );
  });

  /**
   * A payload that will not parse still means something happened. Staying
   * silent would spend the `userVisibleOnly` budget on nothing at all.
   */
  it('still shows a banner when the payload is malformed', async () => {
    await worker.dispatch('push', {
      data: {
        json: () => {
          throw new Error('not json');
        },
      },
    });
    expect(worker.showNotification).toHaveBeenCalled();
  });

  it('shows a banner when there is no payload', async () => {
    await worker.dispatch('push', { data: null });
    expect(worker.showNotification).toHaveBeenCalled();
  });

  /**
   * A visible app already gets an in-app toast over the WebSocket, so a
   * system banner too would double every event.
   */
  it('hands off to a focused window instead of stacking a banner on it', async () => {
    const front = client({ focused: true, visibilityState: 'visible' });
    worker.windows.push(front);

    await worker.dispatch(
      'push',
      pushEvent({ body: 'Done.', url: '/chat', kind: 'message.complete' }),
    );

    expect(worker.showNotification).not.toHaveBeenCalled();
    expect(front.postMessage).toHaveBeenCalledWith({
      source: 'hermes-push',
      kind: 'message.complete',
      text: 'Done.',
      url: '/chat',
    });
  });

  /**
   * A backgrounded PWA can still be returned by `matchAll` reporting itself
   * visible — the OS moved on without the page running a visibilitychange
   * handler. Suppressing on that alone means no banner and no toast: silent,
   * total failure. `focused` is the one signal such a window cannot claim.
   */
  it('shows a banner for a window that claims visible but is not focused', async () => {
    const stale = client({ focused: false, visibilityState: 'visible' });
    worker.windows.push(stale);

    await worker.dispatch('push', pushEvent({ body: 'Done.' }));

    expect(worker.showNotification).toHaveBeenCalled();
    expect(stale.postMessage).not.toHaveBeenCalled();
  });

  it('shows a banner when the only window is hidden', async () => {
    worker.windows.push(client({ focused: true, visibilityState: 'hidden' }));
    await worker.dispatch('push', pushEvent({ body: 'Done.' }));
    expect(worker.showNotification).toHaveBeenCalled();
  });
});

describe('notificationclick', () => {
  const clickEvent = (url?: string) => ({
    notification: { close: vi.fn(), data: url ? { url } : undefined },
  });

  /**
   * `navigate()` reloads the SPA and drops the live socket, so an existing
   * window is told where to go and routes in place.
   */
  it('routes an existing window rather than reloading it', async () => {
    const open = client();
    worker.windows.push(open);

    await worker.dispatch('notificationclick', clickEvent('/notifications'));

    expect(open.postMessage).toHaveBeenCalledWith({
      source: 'hermes-push-click',
      url: '/notifications',
    });
    expect(open.focus).toHaveBeenCalled();
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  it('opens a window from a cold start', async () => {
    await worker.dispatch('notificationclick', clickEvent('/notifications'));
    expect(worker.openWindow).toHaveBeenCalledWith('/notifications');
  });

  it('dismisses the notification', async () => {
    const event = clickEvent('/chat');
    await worker.dispatch('notificationclick', event);
    expect(event.notification.close).toHaveBeenCalled();
  });

  it('falls back to the chat screen when the notification carries no url', async () => {
    await worker.dispatch('notificationclick', clickEvent());
    expect(worker.openWindow).toHaveBeenCalledWith('/chat');
  });

  /** A standalone PWA that spawns a duplicate window per tap is unusable. */
  it('focuses only one window', async () => {
    const a = client();
    const b = client();
    worker.windows.push(a, b);

    await worker.dispatch('notificationclick', clickEvent('/chat'));

    expect(a.focus).toHaveBeenCalled();
    expect(b.focus).not.toHaveBeenCalled();
  });
});

describe('pushsubscriptionchange', () => {
  const okJson = (body: unknown) => ({ ok: true, json: async () => body });

  it('re-subscribes with the server key and registers the new endpoint', async () => {
    worker.fetch.mockImplementation(async (url: string) =>
      url === '/push/config' ? okJson({ enabled: true, publicKey: 'YWJjZA' }) : okJson({ ok: true }),
    );

    await worker.dispatch('pushsubscriptionchange', { oldSubscription: null });

    expect(worker.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    const paths = worker.fetch.mock.calls.map(([u]: [string]) => u);
    expect(paths).toContain('/push/subscribe');
  });

  /**
   * `applicationServerKey` takes bytes. Safari has historically refused the
   * base64url string form, and Safari is the browser this feature exists for.
   */
  it('converts the VAPID key to bytes', async () => {
    worker.fetch.mockImplementation(async (url: string) =>
      url === '/push/config' ? okJson({ enabled: true, publicKey: 'YWJjZA' }) : okJson({ ok: true }),
    );

    await worker.dispatch('pushsubscriptionchange', { oldSubscription: null });

    const key = worker.subscribe.mock.calls[0]![0].applicationServerKey;
    expect(key).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(key).toString()).toBe('abcd');
  });

  it('retires the endpoint the browser rotated away from', async () => {
    worker.fetch.mockImplementation(async (url: string) =>
      url === '/push/config' ? okJson({ enabled: true, publicKey: 'YWJjZA' }) : okJson({ ok: true }),
    );

    await worker.dispatch('pushsubscriptionchange', {
      oldSubscription: { endpoint: 'https://push.example/old' },
    });

    const unsubscribe = worker.fetch.mock.calls.find(([u]: [string]) => u === '/push/unsubscribe');
    expect(unsubscribe).toBeDefined();
    expect(JSON.parse(unsubscribe![1].body)).toEqual({
      endpoint: 'https://push.example/old',
    });
  });

  it('does not retire an endpoint the browser handed back unchanged', async () => {
    worker.subscribe.mockResolvedValue({ endpoint: 'https://push.example/same' });
    worker.fetch.mockImplementation(async (url: string) =>
      url === '/push/config' ? okJson({ enabled: true, publicKey: 'YWJjZA' }) : okJson({ ok: true }),
    );

    await worker.dispatch('pushsubscriptionchange', {
      oldSubscription: { endpoint: 'https://push.example/same' },
    });

    const paths = worker.fetch.mock.calls.map(([u]: [string]) => u);
    expect(paths).not.toContain('/push/unsubscribe');
  });

  it('gives up quietly when the server has push switched off', async () => {
    worker.fetch.mockResolvedValue(okJson({ enabled: false, publicKey: null }));
    await worker.dispatch('pushsubscriptionchange', { oldSubscription: null });
    expect(worker.subscribe).not.toHaveBeenCalled();
  });

  /**
   * The browser fires this while the app is closed and the network is
   * whatever it is. An unhandled rejection inside `waitUntil` is a worker
   * error nobody will ever see, so it must not throw.
   */
  it('survives a server that cannot be reached', async () => {
    worker.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      worker.dispatch('pushsubscriptionchange', { oldSubscription: null }),
    ).resolves.toBeUndefined();
  });

  it('survives a config response that is not JSON', async () => {
    worker.fetch.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('not json');
      },
    });
    await expect(
      worker.dispatch('pushsubscriptionchange', { oldSubscription: null }),
    ).resolves.toBeUndefined();
  });

  it('survives the browser refusing to re-subscribe', async () => {
    worker.fetch.mockResolvedValue(okJson({ enabled: true, publicKey: 'YWJjZA' }));
    worker.subscribe.mockRejectedValue(new Error('permission revoked'));
    await expect(
      worker.dispatch('pushsubscriptionchange', { oldSubscription: null }),
    ).resolves.toBeUndefined();
  });
});
