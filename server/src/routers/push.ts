/**
 * Web-push subscription endpoints.
 *
 * These live under `/push`, not `/api/push`, on purpose: everything under
 * `/api` is proxied verbatim to Hermes, which knows nothing about browser push
 * subscriptions and would answer 404.
 */
import { Hono } from 'hono';
import { z } from 'zod';

import { log } from '../log.js';
import { pushPublicKey, sendPush } from '../push/send.js';
import { listSubscriptions, removeSubscription, saveSubscription } from '../push/store.js';

export const pushRouter = new Hono();

const SubscribeBody = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
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
  });
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
    title: 'Hermes',
    body: 'Push notifications are working.',
    url: '/settings',
    tag: 'test',
    kind: 'push.test',
  });
  return c.json({ ok: true, delivered });
});
