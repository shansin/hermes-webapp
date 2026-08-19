/**
 * Web-push fan-out.
 *
 * VAPID keys come from `.env` when set, otherwise a pair is generated once and
 * persisted alongside the subscriptions. Generating is the default because the
 * keypair is not a secret to be provisioned — it is an identity this proxy
 * asserts to the push service, and the only rule is that it must not change
 * once phones have subscribed against it.
 */
import webpush from 'web-push';

import { config } from '../config.js';
import { log } from '../log.js';
import { listSubscriptions, markSent, removeSubscription, storeVapid, storedVapid } from './store.js';

export interface PushMessage {
  title: string;
  body: string;
  /** In-app path to open on tap. */
  url: string;
  /**
   * Collapse key. A second notification with the same tag replaces the first
   * rather than stacking, which is what keeps a chatty agent from burying the
   * lock screen under twenty identical "task finished" rows.
   */
  tag: string;
  /** Event type, so the service worker can suppress ones already on screen. */
  kind: string;
}

let publicKey = '';
let ready = false;

/**
 * Configure VAPID. Safe to call repeatedly; only the first call does work.
 *
 * Returns the public key, or '' when push cannot run — the routes use that to
 * answer honestly instead of handing the client a key that signs nothing.
 */
export function initPush(): string {
  if (ready) return publicKey;
  ready = true;

  if (!config.PUSH_ENABLED) return '';

  let keys =
    config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY
      ? { publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY }
      : storedVapid();

  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    storeVapid(keys);
    log.info('Generated a VAPID keypair for web push (stored next to .env).');
  }

  try {
    webpush.setVapidDetails(config.VAPID_SUBJECT, keys.publicKey, keys.privateKey);
    publicKey = keys.publicKey;
  } catch (err) {
    // A hand-edited VAPID_SUBJECT that isn't a mailto:/https: URL lands here.
    log.warn({ err }, 'Invalid VAPID configuration — push disabled');
    publicKey = '';
  }
  return publicKey;
}

export function pushPublicKey(): string {
  return initPush();
}

export function pushEnabled(): boolean {
  return Boolean(initPush());
}

/**
 * Deliver to every registered device.
 *
 * Failures are per-subscription and mostly uninteresting: a phone that was
 * reset, an endpoint the browser rotated. 404/410 mean the subscription is
 * permanently gone and is dropped, which is the only way the store stays clean
 * without the user ever visiting settings. Everything else is left in place —
 * a push service having a bad minute must not unsubscribe the user's phone.
 */
export async function sendPush(message: PushMessage): Promise<number> {
  if (!pushEnabled()) return 0;

  const rows = listSubscriptions();
  if (!rows.length) return 0;

  const payload = JSON.stringify(message);
  const delivered: string[] = [];

  await Promise.all(
    rows.map(async (row) => {
      const endpoint = row.subscription.endpoint;
      try {
        await webpush.sendNotification(row.subscription, payload, {
          TTL: 60 * 60 * 12,
          /**
           * Not 'normal'. A dozing Android device defers normal-urgency
           * messages until it next wakes for its own reasons, which can be
           * many minutes — and the whole point of these is that the phone is
           * face-down on a table. Every message we send is one a person is
           * waiting on: a reply, or an approval blocking the agent outright.
           */
          urgency: 'high',
        });
        delivered.push(endpoint);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          removeSubscription(endpoint);
          log.info(`Dropped an expired push subscription (${status}).`);
        } else {
          log.warn({ err, status }, 'Push delivery failed');
        }
      }
    }),
  );

  markSent(delivered);
  // Logged per send, not just on failure: "the banner never arrived" is
  // otherwise impossible to split into "we never sent it" and "the phone
  // never showed it", which is exactly the question worth answering first.
  log.info(`Pushed ${message.kind} to ${delivered.length}/${rows.length} device(s).`);
  return delivered.length;
}
