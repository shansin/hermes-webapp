/**
 * Web-push subscription endpoints.
 *
 * These live under `/push`, not `/api/push`, on purpose: everything under
 * `/api` is proxied verbatim to Hermes, which knows nothing about browser push
 * subscriptions and would answer 404.
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Hono } from 'hono';
import { z } from 'zod';

import { log } from '../log.js';
import { pushPublicKey, sendPush } from '../push/send.js';
import { listSubscriptions, removeSubscription, saveSubscription } from '../push/store.js';
import { answerApproval } from '../push/approval.js';
import { forgetWaiting, scheduleSessionSweep } from '../push/sessions.js';

export const pushRouter = new Hono();

/**
 * A stable handle for a device that is not its endpoint.
 *
 * The endpoint is a capability URL — anyone holding it can push to that
 * device with our keys — so it is not sent back to the page just so a row can
 * name itself. A short digest is enough to address one for removal.
 */
const deviceId = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex').slice(0, 12);

/**
 * Whether an endpoint is somewhere this process may be told to POST.
 *
 * web-push sends to whatever URL the subscription names, from this machine, on
 * every notification — so an unchecked endpoint lets anyone who can reach the
 * subscribe route aim the proxy at `http://127.0.0.1:9119` or a router's admin
 * page. Real push services (FCM, Apple, Mozilla autopush, WNS) are always
 * `https:` on a public DNS name; their hosts vary too much to allowlist, so
 * this refuses the shapes none of them ever has instead: any other scheme,
 * credentials in the URL, any IP literal (WHATWG parsing has already folded
 * `2130706433` and `0x7f.1` into dotted form), single-label names, and the
 * names reserved for local networks.
 *
 * A public name that *resolves* to a private address is not caught here;
 * that needs checking at connect time, not at subscribe time.
 */
export function isPushServiceUrl(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || isIP(host)) return false;
  if (!host.includes('.')) return false;
  return !/\.(localhost|local|localdomain|internal|lan|home\.arpa)$/.test(host);
}

const SubscribeBody = z.object({
  subscription: z.object({
    endpoint: z.string().max(2048).refine(isPushServiceUrl),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
  label: z.string().max(120).optional(),
});

/**
 * What the client needs before it can subscribe.
 *
 * `enabled: false` with no key is the honest answer on a machine where push
 * was switched off — the settings screen shows the reason rather than a toggle
 * that fails when tapped.
 */
pushRouter.get('/push/config', (c) => {
  const key = pushPublicKey();
  return c.json({
    enabled: Boolean(key),
    publicKey: key || null,
    devices: listSubscriptions().length,
    /**
     * Per-device health, so "this phone has never received anything" is on
     * the screen instead of in the proxy log. `host` names the push service
     * (Apple, Google, Mozilla), which is usually the quickest way to tell
     * the rows apart.
     */
    deviceList: listSubscriptions().map((r) => ({
      id: deviceId(r.subscription.endpoint),
      label: r.label,
      host: safeHost(r.subscription.endpoint),
      createdAt: r.createdAt,
      lastSentAt: r.lastSentAt,
      lastError: r.lastError,
      lastFailedAt: r.lastFailedAt,
      failures: r.failures,
    })),
  });
});

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Remove a device by its `deviceId`, for one that is not the browser asking. */
pushRouter.post('/push/remove', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !id) return c.json({ error: 'invalid_id' }, 400);

  const row = listSubscriptions().find((r) => deviceId(r.subscription.endpoint) === id);
  const removed = row ? removeSubscription(row.subscription.endpoint) : false;
  return c.json({ ok: true, removed, devices: listSubscriptions().length });
});

pushRouter.post('/push/subscribe', async (c) => {
  if (!pushPublicKey()) return c.json({ error: 'push_disabled' }, 503);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const parsed = SubscribeBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_subscription' }, 400);

  saveSubscription(parsed.data.subscription, parsed.data.label ?? '');
  log.info(`Registered a push subscription (${listSubscriptions().length} device(s)).`);
  return c.json({ ok: true, devices: listSubscriptions().length });
});

pushRouter.post('/push/unsubscribe', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) return c.json({ error: 'invalid_endpoint' }, 400);

  const removed = removeSubscription(endpoint);
  return c.json({ ok: true, removed, devices: listSubscriptions().length });
});

/**
 * Send a banner to every registered device.
 *
 * The only way to tell a working setup from a broken one without waiting for
 * the agent to finish something — and on iOS, the fastest way to find out that
 * notifications are muted at the OS level.
 */
pushRouter.post('/push/test', async (c) => {
  if (!pushPublicKey()) return c.json({ error: 'push_disabled' }, 503);

  const delivered = await sendPush({
    title: 'Hem',
    body: 'Push notifications are working.',
    url: '/settings',
    tag: 'test',
    kind: 'push.test',
  });
  return c.json({ ok: true, delivered });
});

const ApprovalBody = z.object({
  /** Only the two answers a banner offers — see `push/approval.ts` for why. */
  choice: z.enum(['once', 'deny']),
  requestId: z.string().max(200).nullable().optional(),
});

/**
 * Answer a pending approval from a notification's Approve once / Deny button.
 *
 * Posted by the service worker (`public/push-sw.js`), never by the page. It
 * comes through the same doors as everything else — the Access gate on the
 * cookie the worker's same-origin fetch carries, and the same-origin check on
 * its `Origin` — and is answered over the push listener's own gateway socket,
 * because the phone that owns the session may have no socket at all.
 *
 * The status says which way it went so the worker can tell the user when the
 * button did nothing: 409 when there was nothing left to answer, 503 when the
 * backend could not be asked.
 */
pushRouter.post('/push/approval/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const parsed = ApprovalBody.safeParse(body);
  if (!parsed.success || !sessionId) return c.json({ error: 'invalid_choice' }, 400);

  const answer = await answerApproval(sessionId, parsed.data.choice, parsed.data.requestId ?? null);
  if (answer.status === 'unreachable') return c.json({ error: 'gateway_unreachable' }, 503);
  if (answer.status === 'expired') return c.json({ error: 'not_pending' }, 409);

  /* The banner this came from is already closed; stop the sweep from putting
     up a "No longer waiting" one to report what was just decided, and let it
     look now rather than on its next tick. */
  forgetWaiting(sessionId);
  scheduleSessionSweep();
  return c.json({ ok: true, resolved: answer.resolved });
});
