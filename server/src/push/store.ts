/**
 * Push subscription storage.
 *
 * A JSON file next to `.env`, not a database: this proxy is a single-user
 * home-LAN tool and the entire dataset is "which phones did I install this on"
 * — typically one or two rows that change a few times a year.
 *
 * Writes are atomic (temp file + rename) because the process can be killed at
 * any moment by start.sh, and a truncated file would silently drop every
 * subscription the next time the proxy boots.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { stateDir } from '../config.js';
import { log } from '../log.js';

/** The browser's `PushSubscription.toJSON()` shape, as the client sends it. */
const SubscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
export type PushSubscription = z.infer<typeof SubscriptionSchema>;

const RecordSchema = z.object({
  subscription: SubscriptionSchema,
  /** For the settings screen: "iPhone, added 3 Feb". Free-text, client-set. */
  label: z.string().max(120).default(''),
  createdAt: z.number(),
  /** Bumped on every successful send; lets a stale row be spotted by eye. */
  lastSentAt: z.number().nullable().default(null),
});
export type PushRecord = z.infer<typeof RecordSchema>;

const FileSchema = z.object({
  vapid: z.object({ publicKey: z.string(), privateKey: z.string() }).nullable().default(null),
  subscriptions: z.array(RecordSchema).default([]),
});
type FileShape = z.infer<typeof FileSchema>;

const FILE = resolve(stateDir, '.hermes-push.json');

let state: FileShape = { vapid: null, subscriptions: [] };
let loaded = false;

function load(): FileShape {
  if (loaded) return state;
  loaded = true;
  if (!existsSync(FILE)) return state;
  try {
    const parsed = FileSchema.safeParse(JSON.parse(readFileSync(FILE, 'utf8')));
    if (parsed.success) {
      state = parsed.data;
    } else {
      // A malformed file is worth saying out loud: the symptom otherwise is
      // "push silently stopped working after an upgrade".
      log.warn(`Ignoring unreadable ${FILE} — push subscriptions reset.`);
    }
  } catch (err) {
    log.warn({ err }, `Could not read ${FILE}`);
  }
  return state;
}

function persist(): void {
  const tmp = `${FILE}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, FILE);
  } catch (err) {
    log.warn({ err }, `Could not write ${FILE} — push subscriptions are memory-only`);
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Nothing further to do; the rename already failed.
    }
  }
}

/** The persisted VAPID keypair, if one was generated on an earlier boot. */
export function storedVapid(): { publicKey: string; privateKey: string } | null {
  return load().vapid;
}

export function storeVapid(keys: { publicKey: string; privateKey: string }): void {
  load().vapid = keys;
  persist();
}

export function listSubscriptions(): PushRecord[] {
  return load().subscriptions;
}

/**
 * Add or refresh a subscription, keyed by endpoint.
 *
 * Re-subscribing is normal — browsers rotate endpoints, and the client
 * re-registers on every launch to survive a `pushsubscriptionchange` it slept
 * through — so this must upsert rather than accumulate duplicates that would
 * each deliver the same banner.
 */
export function saveSubscription(subscription: PushSubscription, label: string): void {
  const rows = load().subscriptions;
  const existing = rows.find((r) => r.subscription.endpoint === subscription.endpoint);
  if (existing) {
    existing.subscription = subscription;
    if (label) existing.label = label;
  } else {
    rows.push({ subscription, label, createdAt: Date.now(), lastSentAt: null });
  }
  persist();
}

/** Returns whether anything was actually removed. */
export function removeSubscription(endpoint: string): boolean {
  const rows = load().subscriptions;
  const before = rows.length;
  state.subscriptions = rows.filter((r) => r.subscription.endpoint !== endpoint);
  if (state.subscriptions.length === before) return false;
  persist();
  return true;
}

export function markSent(endpoints: string[]): void {
  if (!endpoints.length) return;
  const now = Date.now();
  for (const row of load().subscriptions) {
    if (endpoints.includes(row.subscription.endpoint)) row.lastSentAt = now;
  }
  persist();
}

export const storeFile = FILE;
