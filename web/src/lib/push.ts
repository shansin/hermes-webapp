/**
 * Web push, from the browser's side.
 *
 * Three separate pieces of state have to line up before a banner can arrive,
 * and any one of them can be off without the others knowing:
 *
 *   1. a secure context with a registered service worker (HTTPS — see README)
 *   2. `Notification.permission === 'granted'`
 *   3. a `PushSubscription` the proxy has actually been told about
 *
 * The settings screen needs to distinguish these, because the fix is different
 * for each — so `pushStatus()` reports which one is missing rather than a
 * single on/off.
 */

export type PushState =
  /** No service worker or no Push API — almost always plain HTTP. */
  | 'unsupported'
  /** The proxy has push switched off, or no VAPID identity. */
  | 'server-off'
  /** Available, not yet asked for. */
  | 'off'
  /** The user said no. Only they can undo this, in browser settings. */
  | 'denied'
  | 'on';

export interface PushStatus {
  state: PushState;
  /** Present when subscribed; the key the server stores this device under. */
  endpoint: string | null;
}

interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
  devices: number;
}

/**
 * iOS only exposes the Push API to an app installed to the home screen, never
 * to a Safari tab — so "notifications don't work" on iPhone is usually this,
 * not permissions. Worth saying explicitly in the UI.
 */
export function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) && !/CriOS|FxiOS/.test(ua);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // Safari's own, non-standard flag — the only signal on older iOS.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function fetchConfig(): Promise<PushConfig | null> {
  try {
    const res = await fetch('/push/config');
    if (!res.ok) return null;
    return (await res.json()) as PushConfig;
  } catch {
    return null;
  }
}

/**
 * `applicationServerKey` accepts base64url text per spec, but Safari has been
 * unreliable about it — and Safari is the browser this feature exists for on
 * iOS. Convert to bytes, which every implementation has always accepted.
 */
function vapidKeyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  // Backed by an explicit ArrayBuffer: `BufferSource` excludes the
  // SharedArrayBuffer-backed view that `new Uint8Array(n)` widens to.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** A name for this device in the proxy's device list. Best-effort. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Browser';
}

export async function pushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return { state: 'unsupported', endpoint: null };

  const config = await fetchConfig();
  if (!config?.enabled || !config.publicKey) return { state: 'server-off', endpoint: null };

  if (Notification.permission === 'denied') return { state: 'denied', endpoint: null };

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return { state: 'off', endpoint: null };

  return { state: 'on', endpoint: subscription.endpoint };
}

/**
 * Ask for permission, subscribe, and register with the proxy.
 *
 * Must be called from a user gesture: iOS rejects `requestPermission()` outside
 * one, silently enough that it looks like the toggle simply did nothing.
 *
 * Re-registers an existing subscription rather than short-circuiting on it —
 * the proxy's store is a file that can be deleted, and a device that thinks it
 * is subscribed while the server has never heard of it is the one failure mode
 * with no visible symptom.
 */
export async function enablePush(): Promise<PushStatus> {
  if (!pushSupported()) return { state: 'unsupported', endpoint: null };

  const config = await fetchConfig();
  if (!config?.enabled || !config.publicKey) return { state: 'server-off', endpoint: null };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { state: permission === 'denied' ? 'denied' : 'off', endpoint: null };
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      // Required by Chrome, and honest: every push we send shows a banner
      // unless the app is already visible on screen.
      userVisibleOnly: true,
      applicationServerKey: vapidKeyToBytes(config.publicKey),
    }));

  const res = await fetch('/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON(), label: deviceLabel() }),
  });
  if (!res.ok) throw new Error('The server rejected this subscription.');

  return { state: 'on', endpoint: subscription.endpoint };
}

/**
 * Unsubscribe locally *and* on the proxy.
 *
 * Order matters: tell the server first, while the endpoint is still readable.
 * If the browser-side unsubscribe then fails, the worst case is a subscription
 * the browser holds and nothing sends to — harmless. The reverse order can
 * leave the server sending to an endpoint it can no longer be told to forget.
 */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  try {
    await fetch('/push/unsubscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
  } catch {
    // Offline: drop the local subscription anyway, so the toggle reflects what
    // the user asked for. The server prunes it on the next 410.
  }

  await subscription.unsubscribe();
}

/** Ask the proxy to send a banner to every registered device. */
export async function sendTestPush(): Promise<number> {
  const res = await fetch('/push/test', { method: 'POST' });
  if (!res.ok) throw new Error('Could not send a test notification.');
  const body = (await res.json()) as { delivered?: number };
  return body.delivered ?? 0;
}
