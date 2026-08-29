/**
 * The kanban sweep.
 *
 * This module exists because a card that blocks on `needs_input` waits for a
 * human indefinitely and nothing announced it — the card that prompted the work
 * sat blocked for a day with the answer typed into a comment no run ever read.
 * Everything below is a way that fact could be reported wrongly, and each one
 * is silent from the app:
 *
 * - **Reporting states instead of transitions.** A card blocked yesterday is
 *   still blocked today. A pass that reported what it saw would fire the same
 *   notification every ninety seconds; a pass that used a seen-set would go
 *   permanently quiet on a card that blocked, was answered, ran and blocked
 *   again — which is the *second* thing you need to know, not a repeat of the
 *   first. Only a remembered previous value can tell those apart.
 * - **Announcing the past.** The first sight of a card is not news. Without
 *   that rule, installing the app on a board with months of history fires one
 *   notification per card, and so does every proxy restart.
 * - **Losing the re-block.** Hermes routes a card re-blocked for the same
 *   reason to Triage rather than back to Blocked, so `block_recurrences` has to
 *   be part of the remembered value — otherwise the second block reads as a
 *   plain move to Triage with nothing explaining it.
 * - **Forgetting on a failed pass.** Hermes down, plugin disabled, a stale
 *   token: a pass that reached nothing must not prune its watermarks, or the
 *   whole board is re-announced the moment it comes back.
 * - **Following the server's board pointer.** `POST /boards/<slug>/switch`
 *   moves a process-wide pointer any other client can move. A notifier that
 *   read only the current board would fall silent on the board you were using.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hermes-kanban-'));

const clearToken = vi.fn();
vi.mock('../src/config.js', () => ({
  stateDir: dir,
  getToken: () => 'tok',
  resolveToken: async () => 'tok',
  clearToken,
  upstreamHttp: 'http://127.0.0.1:9119',
  upstreamHost: '127.0.0.1:9119',
}));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendPush = vi.fn(async () => 1);
vi.mock('../src/push/send.js', () => ({ sendPush: (m: unknown) => sendPush(m as never) }));

let devices = 1;
vi.mock('../src/push/store.js', () => ({
  listSubscriptions: () => (devices ? [{ subscription: { endpoint: 'e' } }] : []),
}));

type Kanban = typeof import('../src/push/kanban.js');
type Feed = typeof import('../src/push/feed.js');
let kanban: Kanban;
let feed: Feed;

/** Gateway responses keyed by `pathname + search`, so `?board=` is addressable. */
let routes: Record<string, unknown>;
let statuses: Record<string, number>;
let requested: string[];

beforeEach(async () => {
  // Feed writes are debounced, so the previous module instance may be holding
  // a timer pointed at its own state — see the same note in `feed.test.ts`.
  feed?.flushFeed();
  rmSync(join(dir, '.hermes-cron-feed.json'), { force: true });
  routes = {};
  statuses = {};
  requested = [];
  devices = 1;
  sendPush.mockClear();
  clearToken.mockClear();
  vi.resetModules();

  vi.stubGlobal('fetch', async (url: string) => {
    const parsed = new URL(url);
    const key = parsed.pathname + parsed.search;
    requested.push(key);
    const status = statuses[parsed.pathname];
    if (status) return new Response(null, { status });
    if (!(key in routes)) return new Response(null, { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      headers: { 'content-type': 'application/json' },
    });
  });

  kanban = await import('../src/push/kanban.js');
  feed = await import('../src/push/feed.js');
});

/** One board named `default`, which is what a normal install answers with. */
function boards(...slugs: { slug: string; archived?: boolean }[]) {
  routes['/api/plugins/kanban/boards'] = { boards: slugs };
}

function cards(slug: string | null, ...tasks: Record<string, unknown>[]) {
  const key = slug
    ? `/api/plugins/kanban/board?board=${slug}`
    : '/api/plugins/kanban/board';
  /* The sweep reads `task.status` and falls back to the column name, so the
     column is deliberately named something else here: a fixture that agreed
     with the row would not catch the two being read from the wrong place. */
  routes[key] = { columns: [{ name: 'mixed', tasks }] };
}

const card = (over: Record<string, unknown> = {}) => ({
  id: 't_1',
  title: 'Place holds on both books',
  status: 'todo',
  ...over,
});

const entries = () => feed.listEntries();
const kinds = () => entries().map((e) => e.kind);

/** Adopt the board's current state, so the next pass sees only changes. */
async function seed(): Promise<void> {
  await kanban.reconcileKanban();
  feed.flushFeed();
}

describe('seeding', () => {
  it('says nothing about a board it is seeing for the first time', async () => {
    boards({ slug: 'default' });
    cards('default', card({ status: 'blocked', block_kind: 'needs_input' }), card({ id: 't_2', status: 'done' }));

    await kanban.reconcileKanban();

    expect(entries()).toHaveLength(0);
    expect(sendPush).not.toHaveBeenCalled();
  });

  /* The whole point of the watermark being on disk. A restart that forgot
     would re-announce every blocked and done card on the board. */
  it('stays quiet across a restart, because the watermark is persisted', async () => {
    boards({ slug: 'default' });
    cards('default', card({ status: 'blocked' }));
    await seed();

    vi.resetModules();
    const reloaded = await import('../src/push/kanban.js');
    await reloaded.reconcileKanban();

    expect(entries()).toHaveLength(0);
  });
});

describe('transitions', () => {
  it('reports a card that has just blocked, and pushes it', async () => {
    boards({ slug: 'default' });
    cards('default', card({ status: 'todo' }));
    await seed();

    cards(
      'default',
      card({
        status: 'blocked',
        block_kind: 'needs_input',
        latest_summary: 'Card is at the 50-hold cap. Cancel two.',
      }),
    );
    await kanban.reconcileKanban();

    expect(kinds()).toEqual(['kanban.blocked']);
    expect(entries()[0]).toMatchObject({
      title: 'Place holds on both books',
      body: 'Card is at the 50-hold cap. Cancel two.',
      severity: 'warn',
      // The card, not the board: the sheet is where the answer is given.
      url: '/kanban?task=t_1',
    });
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  /* A card is blocked for as long as nobody answers it. Repeating the
     notification every ninety seconds is how a person learns to ignore it. */
  it('does not repeat while the card sits there', async () => {
    boards({ slug: 'default' });
    cards('default', card({ status: 'todo' }));
    await seed();

    cards('default', card({ status: 'blocked' }));
    await kanban.reconcileKanban();
    await kanban.reconcileKanban();
    await kanban.reconcileKanban();

    expect(kinds()).toEqual(['kanban.blocked']);
  });

  /* The case a seen-set gets wrong: the card was answered, ran, and blocked
     again. That second block is the news that the answer did not work. */
  it('reports a re-block after the card was answered', async () => {
    boards({ slug: 'default' });
    cards('default', card({ status: 'blocked' }));
    await seed();

    cards('default', card({ status: 'running' }));
    await kanban.reconcileKanban();

    cards('default', card({ status: 'blocked', block_recurrences: 1 }));
    await kanban.reconcileKanban();

    expect(kinds()).toEqual(['kanban.blocked']);
  });

  /**
   * Hermes re-blocks in place until `BLOCK_RECURRENCE_LIMIT`, so the *status*
   * can be unchanged while the counter moves. Without the counter in the
   * watermark this pass is silent about a card that just failed a second time.
   */
  it('notices a second block at the same status via the recurrence counter', async () => {
    boards({ slug: 'default' });
    cards('default', card({ status: 'blocked', block_recurrences: 0 }));
    await seed();

    cards('default', card({ status: 'blocked', block_recurrences: 1 }));
    await kanban.reconcileKanban();

    expect(kinds()).toEqual(['kanban.blocked']);
  });

  it('reports a completion with the agent’s own summary', async () => {
    boards({ slug: 'default' });
    cards('default', card({ status: 'running' }));
    await seed();

    cards('default', card({ status: 'done', latest_summary: 'Found 2 beginner Spanish books.' }));
    await kanban.reconcileKanban();

    expect(entries()[0]).toMatchObject({
      kind: 'kanban.done',
      body: 'Found 2 beginner Spanish books.',
      severity: 'ok',
      failed: false,
    });
  });

  /* Blocked and gave-up land in the same column and are not the same event:
     one is a question, the other is work that failed. The failure counter is
     the only thing that tells them apart. */
  it('reads a card that ran out of retries as an error, not a question', async () => {
    boards({ slug: 'default' });
    cards('default', card({ status: 'running' }));
    await seed();

    cards(
      'default',
      card({ status: 'blocked', consecutive_failures: 3, last_failure_error: 'spawn failed: no such profile' }),
    );
    await kanban.reconcileKanban();

    expect(entries()[0]).toMatchObject({
      severity: 'error',
      failed: true,
      body: 'spawn failed: no such profile',
    });
  });

  /* The board works all day. A feed that reported every move would be a second
     copy of the board, with the four rows that matter lost among the forty
     that do not. */
  it('says nothing about ordinary progress', async () => {
    boards({ slug: 'default' });
    cards('default', card({ status: 'triage' }));
    await seed();

    for (const status of ['todo', 'ready', 'running']) {
      cards('default', card({ status }));
      await kanban.reconcileKanban();
    }

    expect(entries()).toHaveLength(0);
  });

  /**
   * A card *created* into Triage is not news; a blocked card rerouted there by
   * the unblock-loop breaker is the most important row the feed can carry. The
   * only discriminator is where it came from.
   */
  it('reports a move into Triage only when it came from Blocked', async () => {
    boards({ slug: 'default' });
    cards('default', card({ status: 'blocked', block_recurrences: 1 }));
    await seed();

    cards('default', card({ status: 'triage', block_recurrences: 2 }));
    await kanban.reconcileKanban();

    expect(kinds()).toEqual(['kanban.triage']);
    expect(entries()[0]!.body).toContain('blocked for the same reason');
  });

  it('ignores a move into Triage from anywhere else', async () => {
    boards({ slug: 'default' });
    cards('default', card({ status: 'todo' }));
    await seed();

    cards('default', card({ status: 'triage' }));
    await kanban.reconcileKanban();

    expect(entries()).toHaveLength(0);
  });
});

describe('boards', () => {
  it('sweeps every board, not just the one the server points at', async () => {
    boards({ slug: 'default' }, { slug: 'work' });
    cards('default', card({ status: 'todo' }));
    cards('work', card({ id: 't_9', status: 'todo' }));
    await seed();

    cards('default', card({ status: 'blocked' }));
    cards('work', card({ id: 't_9', status: 'blocked' }));
    await kanban.reconcileKanban();

    expect(entries()).toHaveLength(2);
  });

  /* Two boards can legitimately hold the same task id — they are separate
     SQLite files — so the watermark has to be keyed on both or one board's
     card silently suppresses the other's. */
  it('keeps watermarks per board for the same task id', async () => {
    boards({ slug: 'a' }, { slug: 'b' });
    cards('a', card({ status: 'blocked' }));
    cards('b', card({ status: 'todo' }));
    await seed();

    cards('b', card({ status: 'blocked' }));
    await kanban.reconcileKanban();

    expect(entries()).toHaveLength(1);
  });

  it('skips an archived board', async () => {
    boards({ slug: 'default' }, { slug: 'old', archived: true });
    cards('default', card());
    await kanban.reconcileKanban();

    expect(requested).not.toContain('/api/plugins/kanban/board?board=old');
  });

  /* An older plugin has no `/boards` route at all. Falling back to the
     unqualified board is what keeps the sweep working there rather than
     silently doing nothing. */
  it('falls back to the current board when /boards is absent', async () => {
    cards(null, card());
    await kanban.reconcileKanban();

    expect(requested).toContain('/api/plugins/kanban/board');
  });
});

describe('failure', () => {
  it('is silent and harmless when the plugin is not installed', async () => {
    statuses['/api/plugins/kanban/boards'] = 404;
    statuses['/api/plugins/kanban/board'] = 404;

    await expect(kanban.reconcileKanban()).resolves.toBeUndefined();
    expect(entries()).toHaveLength(0);
  });

  /**
   * The pass that reaches nothing must not forget what it knew.
   *
   * Hermes restarting, the plugin being toggled off, a token going stale —
   * each gives an empty pass, and pruning on one would drop every watermark
   * and re-announce the entire board as soon as it came back.
   */
  it('keeps its watermarks through a pass that saw no cards', async () => {
    boards({ slug: 'default' });
    cards('default', card({ status: 'blocked' }));
    await seed();

    statuses['/api/plugins/kanban/boards'] = 503;
    statuses['/api/plugins/kanban/board'] = 503;
    await kanban.reconcileKanban();

    delete statuses['/api/plugins/kanban/boards'];
    delete statuses['/api/plugins/kanban/board'];
    await kanban.reconcileKanban();

    expect(entries()).toHaveLength(0);
  });

  /**
   * One board failing must not cost the others their memory.
   *
   * The prune used to run once over every `kanban:task:` watermark against the
   * cards a whole pass had seen, so a board that answered a timeout or a 401
   * while its neighbours answered normally had all of its watermarks dropped.
   * Its cards then read as first sights on the next pass and were adopted
   * silently — so whatever they did while it was unreachable was announced by
   * nobody, which is precisely the window this module exists to cover.
   */
  it('keeps a board’s watermarks when only that board is unreachable', async () => {
    boards({ slug: 'a' }, { slug: 'b' });
    cards('a', card({ status: 'todo' }));
    cards('b', card({ id: 't_9', status: 'todo' }));
    await seed();

    // Board b alone stops answering; board a is read normally.
    delete routes['/api/plugins/kanban/board?board=b'];
    await kanban.reconcileKanban();

    cards('b', card({ id: 't_9', status: 'blocked' }));
    await kanban.reconcileKanban();

    expect(kinds()).toEqual(['kanban.blocked']);
  });

  /**
   * The same failure by its wider road: `/boards` itself falling over.
   *
   * `boardSlugs` then falls back to `[null]` — the server's current board —
   * which is right, and used to be ruinous: that one board's cards were the
   * whole of `seen`, so the prune forgot every card on every *other* board in
   * a single pass.
   */
  it('keeps every board’s watermarks when /boards falls over for a pass', async () => {
    boards({ slug: 'a' }, { slug: 'b' });
    cards('a', card({ status: 'todo' }));
    cards('b', card({ id: 't_9', status: 'todo' }));
    // What the unqualified route answers: whatever the server's pointer says.
    cards(null, card({ status: 'todo' }));
    await seed();

    statuses['/api/plugins/kanban/boards'] = 503;
    await kanban.reconcileKanban();
    delete statuses['/api/plugins/kanban/boards'];

    cards('b', card({ id: 't_9', status: 'blocked' }));
    await kanban.reconcileKanban();

    expect(kinds()).toEqual(['kanban.blocked']);
  });

  it('drops a stale token so the next pass re-scrapes', async () => {
    statuses['/api/plugins/kanban/boards'] = 401;
    await kanban.reconcileKanban();
    expect(clearToken).toHaveBeenCalled();
  });

  /* The row is the record that survives nobody being connected; the push is
     best-effort on top of it. A machine with no registered device must still
     get the row. */
  it('records the row even with no push devices registered', async () => {
    devices = 0;
    boards({ slug: 'default' });
    cards('default', card({ status: 'todo' }));
    await seed();

    cards('default', card({ status: 'blocked' }));
    await kanban.reconcileKanban();

    expect(entries()).toHaveLength(1);
    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe('watermarks', () => {
  it('reports null the first time and the stored value after', () => {
    expect(feed.getWatermark('x')).toBeNull();
    feed.setWatermark('x', 'one');
    expect(feed.getWatermark('x')).toBe('one');
    feed.setWatermark('x', null);
    expect(feed.getWatermark('x')).toBeNull();
  });

  it('prunes only its own prefix, and only what is not kept', () => {
    feed.setWatermark('kanban:task::t_1', 'done:0');
    feed.setWatermark('kanban:task::t_2', 'done:0');
    feed.setWatermark('other:thing', 'keep me');

    feed.pruneWatermarks('kanban:task:', new Set(['kanban:task::t_1']));

    expect(feed.getWatermark('kanban:task::t_1')).toBe('done:0');
    expect(feed.getWatermark('kanban:task::t_2')).toBeNull();
    expect(feed.getWatermark('other:thing')).toBe('keep me');
  });
});
