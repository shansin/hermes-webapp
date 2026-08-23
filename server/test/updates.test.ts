/**
 * The two feed sources that are not cron.
 *
 * What matters here is restraint in both directions. The feed has to record
 * what the agent said while nobody was watching — including on a machine with
 * no push devices at all, which is the case the widened early-out in
 * `events.ts` exists for. And it has to stay quiet about the backend bouncing,
 * because a row per restart trains you to ignore the row that means the agent
 * has actually been down all night.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hermes-updates-'));

vi.mock('../src/config.js', () => ({ stateDir: dir }));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendPush = vi.fn(async () => 0);
vi.mock('../src/push/send.js', () => ({ sendPush, pushEnabled: () => false }));

/** Flipped per test: the feed must be written either way, push must not. */
let subscriptions: unknown[] = [];
vi.mock('../src/push/store.js', () => ({ listSubscriptions: () => subscriptions }));

type Updates = typeof import('../src/push/updates.js');
type Feed = typeof import('../src/push/feed.js');
let updates: Updates;
let feed: Feed;

beforeEach(async () => {
  rmSync(join(dir, '.hermes-cron-feed.json'), { force: true });
  subscriptions = [];
  sendPush.mockClear();
  vi.resetModules();
  vi.useFakeTimers();
  updates = await import('../src/push/updates.js');
  feed = await import('../src/push/feed.js');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the agent’s own announcements', () => {
  it('writes notification.show as the agent’s words', () => {
    updates.recordGatewayEvent('notification.show', { text: 'Time to brush your teeth' }, 's1');

    const rows = feed.listEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'agent',
      severity: 'info',
      title: 'Hermes',
      body: 'Time to brush your teeth',
      url: '/chat?session=s1',
    });
  });

  it('accepts the `message` spelling the gateway also uses', () => {
    updates.recordGatewayEvent('notification.show', { message: 'Standup in 5' }, 's1');
    expect(feed.listEntries()[0]?.body).toBe('Standup in 5');
  });

  /**
   * Kept as written. `events.ts` flattens its own copy for the banner; what is
   * stored is what the card shows, and the card has room for all of it.
   */
  it('keeps the announcement whole, markdown and line breaks intact', () => {
    updates.recordGatewayEvent('notification.show', { text: '## Done\n\n- one\n- two' }, 's1');
    expect(feed.listEntries()[0]?.body).toBe('## Done\n\n- one\n- two');
  });

  it('collapses the gaps a wide-screen reply leaves behind', () => {
    updates.recordGatewayEvent('notification.show', { text: 'one\n\n\n\n\ntwo  \n' }, 's1');
    expect(feed.listEntries()[0]?.body).toBe('one\n\ntwo');
  });

  it('names the task for background.complete', () => {
    updates.recordGatewayEvent('background.complete', { title: 'Nightly index' }, 's1');
    expect(feed.listEntries()[0]).toMatchObject({
      source: 'agent',
      title: 'Nightly index',
      body: 'Nightly index finished',
    });
  });

  it('names the subagent for subagent.complete', () => {
    updates.recordGatewayEvent('subagent.complete', { name: 'Explore' }, 's1');
    expect(feed.listEntries()[0]?.body).toBe('Explore finished');
  });

  /**
   * The regression the widened early-out in `events.ts` exists to prevent. A
   * setup with no push devices is exactly the one that needs the written
   * record, because there is no banner to miss it on.
   */
  it('records with no push devices registered, and pushes nothing itself', () => {
    subscriptions = [];
    updates.recordGatewayEvent('notification.show', { text: 'Kettle is on' }, 's1');
    expect(feed.listEntries()).toHaveLength(1);
    expect(sendPush).not.toHaveBeenCalled();
  });

  /**
   * `events.ts` already fans these three out on its own path. Sending from
   * here as well would double every banner.
   */
  it('still pushes nothing when devices are registered', () => {
    subscriptions = [{ endpoint: 'https://push.example/1' }];
    updates.recordGatewayEvent('notification.show', { text: 'Kettle is on' }, 's1');
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('has nothing to say about an empty notification', () => {
    updates.recordGatewayEvent('notification.show', {}, 's1');
    updates.recordGatewayEvent('notification.show', { text: '   ' }, 's1');
    expect(feed.listEntries()).toEqual([]);
  });

  it.each([
    'message.complete',
    'message.delta',
    'approval.request',
    'clarify.request',
    'tool.start',
    'cron.changed',
  ])('%s stays out of the feed', (type) => {
    updates.recordGatewayEvent(type, { text: 'noise', question: 'noise' }, 's1');
    expect(feed.listEntries()).toEqual([]);
  });

  /**
   * `events.ts` scans raw frame text against `FEED_EVENT_TYPES` before parsing
   * anything, so a type handled below but missing from that list would never
   * reach the feed on a machine with no push devices — and nothing would say
   * why. This is the only place the two can be checked against each other.
   */
  it('handles every type it advertises to the frame scanner', async () => {
    const { FEED_EVENT_TYPES } = updates;
    for (const type of FEED_EVENT_TYPES) {
      rmSync(join(dir, '.hermes-cron-feed.json'), { force: true });
      vi.resetModules();
      const mod = await import('../src/push/updates.js');
      const f = await import('../src/push/feed.js');
      // Every payload field any of them reads, so each finds its own.
      mod.recordGatewayEvent(type, { text: 'x', title: 'x', name: 'x' }, 's1');
      expect(f.listEntries(), `${type} produced no feed entry`).toHaveLength(1);
    }
  });

  it('falls back to the chat route when the event carries no session', () => {
    updates.recordGatewayEvent('notification.show', { text: 'Anywhere' }, null);
    expect(feed.listEntries()[0]?.url).toBe('/chat');
  });
});

describe('the backend going away', () => {
  it('says nothing about a restart that reconnects inside the grace window', () => {
    updates.backendWentDown();
    vi.advanceTimersByTime(3_000);
    updates.backendCameBack();
    vi.advanceTimersByTime(60_000);
    expect(feed.listEntries()).toEqual([]);
  });

  it('records an outage that outlasts the grace window', () => {
    updates.backendWentDown();
    expect(feed.listEntries()).toEqual([]);

    vi.advanceTimersByTime(21_000);
    const rows = feed.listEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'system',
      severity: 'warn',
      kind: 'backend.down',
      status: 'down',
      url: '/settings',
      sessionId: null,
    });
  });

  it('records the recovery, with how long it was gone', () => {
    updates.backendWentDown();
    vi.advanceTimersByTime(21_000);
    vi.advanceTimersByTime(10 * 60_000);
    updates.backendCameBack();

    const rows = feed.listEntries();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'backend.up', severity: 'ok', status: 'up' });
    expect(rows[0]?.body).toContain('10 minutes');
  });

  /**
   * The push listener connects once at start-up, which is not a recovery from
   * anything. A row there would greet every proxy restart with news that the
   * backend is fine.
   */
  it('says nothing when the link comes up having never gone down', () => {
    updates.backendCameBack();
    expect(feed.listEntries()).toEqual([]);
  });

  it('does not stack rows while the backend stays away', () => {
    updates.backendWentDown();
    vi.advanceTimersByTime(21_000);
    for (let i = 0; i < 5; i++) {
      updates.backendWentDown();
      vi.advanceTimersByTime(21_000);
    }
    expect(feed.listEntries().filter((e) => e.kind === 'backend.down')).toHaveLength(1);
  });

  /**
   * A proxy on its way out must not announce that the backend is offline: the
   * close it is reacting to is its own.
   */
  it('drops a pending outage report on shutdown', () => {
    updates.backendWentDown();
    updates.resetBackendWatch();
    vi.advanceTimersByTime(60_000);
    expect(feed.listEntries()).toEqual([]);
  });

  it('pushes the outage when a device is registered', () => {
    subscriptions = [{ endpoint: 'https://push.example/1' }];
    updates.backendWentDown();
    vi.advanceTimersByTime(21_000);
    expect(sendPush).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'backend.down', url: '/notifications', tag: 'backend-state' }),
    );
  });
});
