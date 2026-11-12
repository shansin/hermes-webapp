/**
 * Turning four unrelated API shapes into one "what is running" list.
 *
 * The failures worth catching here are the quiet ones. Missing a running
 * delegation defeats the point of the pane; showing a crashed kanban worker as
 * healthy is worse, because it reads as progress. And every field these
 * normalisers touch is optional on the wire, so an older Hermes that omits
 * `is_active` entirely has to produce an empty list rather than a crash.
 */
import { describe, expect, it } from 'vitest';
import { QueryClient, type QueryKey } from '@tanstack/react-query';
import { invalidateActivity } from '../src/lib/useActivity';
import { kanbanKeys } from '../src/api/kanban';
import { DELEGATION_KEY } from '../src/api/delegation';
import { LIVE_SESSIONS_KEY, parseLiveSessions, parsePendingPairing } from '../src/api/needsYou';
import type { LiveSession, PendingPairing } from '../src/api/needsYou';
import type { NotificationEntry } from '../src/api/notifications';
import {
  FAILED_WINDOW_MS,
  fromKanbanAttention,
  fromPairing,
  fromWaiting,
  mergeNeedsYou,
  recentFailures,
} from '../src/lib/needsYou';
import {
  QUIET_AFTER_S,
  countAttentionCards,
  countRunning,
  countWaiting,
  fromCron,
  fromDelegations,
  fromKanban,
  fromSessions,
  isQuiet,
  mergeActivity,
  type ActivityItem,
} from '../src/lib/activity';
import type { ActiveSubagent } from '../src/api/delegation';
import type { SessionRow } from '../src/api/sessions';
import type { Task } from '../src/api/kanban';
import type { CronJob } from '../src/api/hub';

const NOW = 1_787_500_000;

const session = (over: Partial<SessionRow> = {}): SessionRow =>
  ({
    id: 's1',
    title: 'Meta stock question',
    started_at: NOW - 600,
    ended_at: null,
    is_active: true,
    last_activity_at: NOW - 10,
    last_activity_description: 'delegate_task: subagent running execute_code (iteration 5/250)',
    ...over,
  }) as unknown as SessionRow;

const task = (over: Partial<Task> = {}): Task =>
  ({ id: 't1', title: 'Strategy to minimize tax', started_at: NOW - 300, ...over }) as unknown as Task;

const job = (over: Partial<CronJob> = {}): CronJob =>
  ({ id: 'j1', name: 'meta-trial-digest', enabled: true, ...over }) as CronJob;

const child = (over: Partial<ActiveSubagent> = {}): ActiveSubagent =>
  ({
    subagent_id: 'sa-0-a5b872fd',
    goal: "Research Alphabet's Q2 2026 results",
    delegation_id: 'deleg_382493b3',
    owner_agent_session_id: 's1',
    started_at: NOW - 120,
    status: 'running',
    tool_count: 5,
    last_tool: 'web_extract',
    ...over,
  }) as ActiveSubagent;

/**
 * The lane that exists because a background delegation is invisible everywhere
 * else: those children get no session rows and emit no `subagent.*` events, so
 * a session running three researchers showed up as one row — the parent.
 */
describe('delegated children', () => {
  it('lists one row per running child', () => {
    const items = fromDelegations([
      child(),
      child({ subagent_id: 'sa-1', goal: "Research Meta's Q2 2026 results" }),
      child({ subagent_id: 'sa-2', goal: "Research Microsoft's fiscal Q3 2026 results" }),
    ]);

    expect(items).toHaveLength(3);
    expect(items.every((i) => i.kind === 'subagent' && i.state === 'running')).toBe(true);
  });

  /* Four things are working; the parent is not a summary of the other three. */
  it('does not replace the session that dispatched them', () => {
    const items = mergeActivity(fromSessions([session()]), fromDelegations([child(), child({ subagent_id: 'sa-1' })]));

    expect(countRunning(items)).toBe(3);
  });

  it('leads back to the conversation that owns it', () => {
    expect(fromDelegations([child()])[0]?.url).toBe('/chat?session=s1');
  });

  /* "web_extract · 5 tools" is the difference between working and wedged. */
  it('says what the child is inside', () => {
    expect(fromDelegations([child()])[0]?.detail).toBe('web_extract · 5 tools');
  });

  it('admits when a child has not called anything yet', () => {
    expect(fromDelegations([child({ last_tool: null, tool_count: 0 })])[0]?.detail).toBe(
      'starting up',
    );
  });

  it('drops a child that has finished', () => {
    expect(fromDelegations([child({ status: 'done' })])).toEqual([]);
  });

  /* An unfamiliar status shows a row that should not be there rather than
     hiding one that should — the same way cron reads its endings. */
  it('keeps a child whose status it does not recognise', () => {
    expect(fromDelegations([child({ status: 'winding-down' })])).toHaveLength(1);
  });

  it('survives a registry answer with nothing in it', () => {
    expect(fromDelegations(undefined)).toEqual([]);
    expect(fromDelegations([{ subagent_id: 'bare' } as ActiveSubagent])).toHaveLength(1);
  });

  /**
   * The registry keeps `started_at` and no heartbeat, so the quiet rule — which
   * every other lane earns honestly — would print "no update in 6m" over a
   * child that is running a tool right now.
   */
  it('is never marked quiet on a start time', () => {
    const item = fromDelegations([child({ started_at: NOW - QUIET_AFTER_S * 10 })])[0]!;

    expect(item.sinceIsStart).toBe(true);
    expect(isQuiet(item, NOW)).toBe(false);
  });
});

describe('sessions', () => {
  /** The whole reason the pane exists: a delegation running out of sight. */
  it('surfaces an active session with its live progress line', () => {
    const [item] = fromSessions([session()]);
    expect(item).toMatchObject({
      kind: 'session',
      state: 'running',
      title: 'Meta stock question',
      detail: 'delegate_task: subagent running execute_code (iteration 5/250)',
      url: '/chat?session=s1',
    });
  });

  it('ignores a session that is not active', () => {
    expect(fromSessions([session({ is_active: false })])).toEqual([]);
  });

  /** Both set should not happen; if it does, the session is over. */
  it('ignores an active flag on a session that has ended', () => {
    expect(fromSessions([session({ ended_at: NOW - 5 })])).toEqual([]);
  });

  /**
   * An older backend has no `is_active` column at all. Treating undefined as
   * "running" would fill the pane with every session ever.
   */
  it('treats a missing flag as not running rather than guessing', () => {
    expect(fromSessions([session({ is_active: undefined })])).toEqual([]);
  });

  it('falls back to the start time when there is no activity stamp', () => {
    const [item] = fromSessions([session({ last_activity_at: null })]);
    expect(item?.since).toBe(NOW - 600);
  });

  it('survives a row with nothing on it', () => {
    expect(() => fromSessions([{ id: 'x' } as unknown as SessionRow])).not.toThrow();
  });
});

describe('quiet detection', () => {
  const item = (since: number | null): ActivityItem => ({
    id: 'i',
    kind: 'session',
    state: 'running',
    title: 't',
    detail: null,
    since,
    url: '/',
  });

  it('a recently updated row is not quiet', () => {
    expect(isQuiet(item(NOW - 5), NOW)).toBe(false);
  });

  /**
   * Hermes keeps `is_active` true for five minutes after the last sign of
   * life, so a row can be stale while still legitimately listed. Saying how
   * long it has been silent is the honest middle: still shown, not claimed to
   * be working.
   */
  it('a row past the threshold is quiet but still listed', () => {
    const stale = item(NOW - QUIET_AFTER_S - 30);
    expect(isQuiet(stale, NOW)).toBe(true);
    expect(countRunning([stale])).toBe(1);
  });

  it('a row with no clock is never called quiet', () => {
    expect(isQuiet(item(null), NOW)).toBe(false);
  });
});

describe('kanban', () => {
  const columns = (name: string, tasks: Task[]) => [{ name, tasks }];

  it('running tasks are running', () => {
    const [item] = fromKanban(columns('running', [task()]), NOW);
    expect(item).toMatchObject({ kind: 'kanban', state: 'running', url: '/kanban?task=t1' });
  });

  it.each(['ready', 'scheduled'])('%s tasks are queued', (name) => {
    const [item] = fromKanban(columns(name, [task()]), NOW);
    expect(item?.state).toBe('queued');
  });

  it.each(['done', 'todo', 'triage', 'blocked', 'review'])('%s tasks are not listed', (name) => {
    expect(fromKanban(columns(name, [task()]), NOW)).toEqual([]);
  });

  /**
   * A crashed worker leaves the row in `running` until the dispatcher reclaims
   * it. Rendering that as healthy is the one failure that actively misleads —
   * it looks like progress.
   */
  it('flags a running task whose worker claim has expired', () => {
    const [item] = fromKanban(
      columns('running', [task({ claim_expires: NOW - 60 } as Partial<Task>)]),
      NOW,
    );
    expect(item?.state).toBe('stalled');
    expect(item?.note).toMatch(/claim expired/i);
  });

  it('leaves a task with a live claim alone', () => {
    const [item] = fromKanban(
      columns('running', [task({ claim_expires: NOW + 60 } as Partial<Task>)]),
      NOW,
    );
    expect(item?.state).toBe('running');
  });

  it('survives no board at all', () => {
    expect(fromKanban(undefined, NOW)).toEqual([]);
  });
});

describe('cron', () => {
  const executing = { latest_execution: { status: 'running' } } as Partial<CronJob>;

  it('a job mid-fire is running', () => {
    const [item] = fromCron([job(executing)]);
    expect(item).toMatchObject({ kind: 'cron', state: 'running', url: '/cron?job=j1' });
  });

  it.each(['completed', 'failed', 'cancelled', 'skipped'])(
    'a %s execution is not in flight',
    (status) => {
      const items = fromCron([job({ latest_execution: { status } } as Partial<CronJob>)]);
      expect(items.every((i) => i.state !== 'running')).toBe(true);
    },
  );

  /**
   * Unknown statuses count as in flight: a spurious row is visible and
   * correctable, a hidden running job is neither.
   */
  it('treats an unfamiliar status as still running', () => {
    const [item] = fromCron([job({ latest_execution: { status: 'finalizing' } } as Partial<CronJob>)]);
    expect(item?.state).toBe('running');
  });

  it('lists upcoming jobs as queued, soonest first', () => {
    const items = fromCron([
      job({ id: 'late', name: 'late', next_run_at: NOW + 7200 }),
      job({ id: 'soon', name: 'soon', next_run_at: NOW + 60 }),
    ]);
    expect(items.map((i) => i.title)).toEqual(['soon', 'late']);
  });

  it('caps the queued rows so daily jobs cannot bury the live work', () => {
    const jobs = Array.from({ length: 9 }, (_, i) =>
      job({ id: `j${i}`, name: `job ${i}`, next_run_at: NOW + i * 60 }),
    );
    expect(fromCron(jobs, 3).filter((i) => i.state === 'queued')).toHaveLength(3);
  });

  it('skips paused and disabled jobs', () => {
    expect(fromCron([job({ paused: true, next_run_at: NOW + 60 })])).toEqual([]);
    expect(fromCron([job({ enabled: false, next_run_at: NOW + 60 })])).toEqual([]);
  });

  it('parses an ISO next_run_at', () => {
    const [item] = fromCron([job({ next_run_at: '2026-08-24T09:00:00Z' })]);
    expect(item?.since).toBe(Date.parse('2026-08-24T09:00:00Z') / 1000);
  });
});

describe('merge', () => {
  it('puts live work first, then doubtful, then what is next', () => {
    const merged = mergeActivity(
      fromCron([job({ next_run_at: NOW + 600 })]),
      fromKanban([{ name: 'running', tasks: [task({ claim_expires: NOW - 1 } as Partial<Task>)] }], NOW),
      fromSessions([session()]),
    );
    expect(merged.map((i) => i.state)).toEqual(['running', 'stalled', 'queued']);
  });

  it('orders running by most recently active', () => {
    const merged = mergeActivity(
      fromSessions([
        session({ id: 'old', title: 'old', last_activity_at: NOW - 200 }),
        session({ id: 'new', title: 'new', last_activity_at: NOW - 5 }),
      ]),
    );
    expect(merged.map((i) => i.title)).toEqual(['new', 'old']);
  });

  it('counts only what is actually running', () => {
    const merged = mergeActivity(
      fromSessions([session()]),
      fromCron([job({ next_run_at: NOW + 600 })]),
    );
    expect(merged).toHaveLength(2);
    expect(countRunning(merged)).toBe(1);
  });

  it('an idle machine produces an empty list, not a crash', () => {
    expect(mergeActivity(fromSessions([]), fromKanban(undefined, NOW), fromCron(undefined))).toEqual(
      [],
    );
  });
});

/**
 * Which agent a row belongs to.
 *
 * The pane merges three sources that each span every profile — the kanban
 * board is one shared store, the cron list defaults to `profile=all`, and
 * sessions now fan out — so a row that cannot say whose work it is leaves the
 * reader unable to tell the research agent from the one they are talking to.
 *
 * The session link matters more than the label. Sessions live in per-profile
 * stores and a resume that does not name the profile looks the id up in the
 * active one and finds nothing, so a row for another agent's work would open
 * an empty chat rather than the conversation it is advertising.
 */
describe('activity rows carry their owner', () => {
  const live = { is_active: true, ended_at: null, last_activity_at: 1_700_000_000 };

  it('labels a session with its profile and puts it in the resume link', () => {
    const [row] = fromSessions([
      { id: 's1', title: 'work kanban task t_1', profile: 'research', ...live } as never,
    ]);
    expect(row?.owner).toBe('research');
    expect(row?.url).toBe('/chat?session=s1&profile=research');
  });

  it('falls back to profile_name when profile is absent', () => {
    const [row] = fromSessions([
      { id: 's2', title: 'x', profile_name: 'fitness', ...live } as never,
    ]);
    expect(row?.owner).toBe('fitness');
  });

  it('leaves the link unscoped when no profile is reported', () => {
    // An older backend, or the active profile's own store. The link has to
    // stay exactly as it was, because that is every notification already
    // sitting on a phone.
    const [row] = fromSessions([{ id: 's3', title: 'x', ...live } as never]);
    expect(row?.owner).toBeUndefined();
    expect(row?.url).toBe('/chat?session=s3');
  });

  it('encodes a profile that would otherwise break the query', () => {
    const [row] = fromSessions([
      { id: 's4', title: 'x', profile: 'a&b', ...live } as never,
    ]);
    expect(row?.url).toBe('/chat?session=s4&profile=a%26b');
  });

  it('labels a kanban row with its assignee', () => {
    const rows = fromKanban(
      [{ name: 'running', tasks: [{ id: 't_1', title: 'EB5', assignee: 'research' } as never] }],
      1_700_000_000,
    );
    expect(rows[0]?.owner).toBe('research');
  });

  it('leaves an unassigned kanban row without an owner', () => {
    // Unassigned is a real and important state — the dispatcher skips those
    // silently — so it must not be dressed up with a borrowed label.
    const rows = fromKanban(
      [{ name: 'ready', tasks: [{ id: 't_2', title: 'orphan', assignee: null } as never] }],
      1_700_000_000,
    );
    expect(rows[0]?.owner).toBeUndefined();
  });

  it('labels a cron row with the store it came from', () => {
    const rows = fromCron([
      { id: 'j1', name: 'digest', profile: 'fitness', next_run_at: 1_700_000_100 } as never,
    ]);
    expect(rows[0]?.owner).toBe('fitness');
  });
});

/**
 * The early invalidation, checked against the keys the real hooks build. The
 * board half once invalidated `['kanban', 'board']`, a prefix no board query
 * has (they start `['kanban', <board>, 'board', …]`), so it refreshed nothing
 * and nothing said so.
 */
describe('invalidateActivity', () => {
  const BOARD = kanbanKeys.board(null, null, false);
  const SESSIONS = ['sessions', 'recent', 25, 'research'];
  const CRON = ['cron'];

  function seeded(): QueryClient {
    const qc = new QueryClient();
    for (const key of [BOARD, SESSIONS, DELEGATION_KEY, CRON, LIVE_SESSIONS_KEY]) qc.setQueryData(key, {});
    return qc;
  }

  /* An approval is asked mid-turn, so the turn boundaries are also when a
     session enters or leaves `waiting`. Shared, because the badge reads it. */
  it('refreshes the live session list with the shared lanes', () => {
    const qc = seeded();
    invalidateActivity(qc, 'message.start', 'shared');
    expect(stale(qc, LIVE_SESSIONS_KEY)).toBe(true);
    const full = seeded();
    invalidateActivity(full, 'message.start', 'full');
    expect(stale(full, LIVE_SESSIONS_KEY)).toBe(false);
  });
  const stale = (qc: QueryClient, key: QueryKey) => qc.getQueryState(key)?.isInvalidated;

  it('refreshes the board the Activity screen reads', () => {
    const qc = seeded();
    invalidateActivity(qc, 'message.complete', 'full');
    expect(stale(qc, BOARD)).toBe(true);
    expect(stale(qc, CRON)).toBe(false);
  });

  it('refreshes cron only on its own nudge', () => {
    const qc = seeded();
    invalidateActivity(qc, 'cron.changed', 'full');
    expect(stale(qc, CRON)).toBe(true);
  });

  /* The shared half runs once, app-wide; the full half on the screen alone. A
     lane in both would be invalidated twice per event. */
  it('keeps the two halves disjoint', () => {
    const shared = seeded();
    invalidateActivity(shared, 'cron.changed', 'shared');
    expect([SESSIONS, DELEGATION_KEY].map((k) => stale(shared, k))).toEqual([true, true]);
    expect([BOARD, CRON].map((k) => stale(shared, k))).toEqual([false, false]);

    const full = seeded();
    invalidateActivity(full, 'cron.changed', 'full');
    expect([SESSIONS, DELEGATION_KEY].map((k) => stale(full, k))).toEqual([false, false]);
  });

  it('ignores events that change nothing it shows', () => {
    const qc = seeded();
    invalidateActivity(qc, 'message.delta', 'shared');
    invalidateActivity(qc, 'message.delta', 'full');
    for (const key of [BOARD, SESSIONS, DELEGATION_KEY, CRON]) expect(stale(qc, key)).toBe(false);
  });
});

/* ------------------------------------------------------------- needs you */

const liveRow = (over: Partial<LiveSession> = {}): LiveSession => ({
  id: 'a1b2c3d4',
  session_key: '20261112_101500_abc',
  status: 'waiting',
  title: 'Deploy the blog',
  last_active: NOW - 90,
  started_at: NOW - 600,
  message_count: 12,
  ...over,
});

/**
 * Sessions parked on a person. The registry is process-wide and its rows carry
 * no profile, so the profile has to come from somewhere else — or a row for
 * another agent's session opens an empty chat.
 */
describe('waiting sessions', () => {
  it('lists only `waiting`, by stored id rather than live handle', () => {
    const items = fromWaiting([
      liveRow(),
      liveRow({ id: 'ffff0000', session_key: 'other', status: 'working' }),
      liveRow({ id: 'eeee0000', session_key: 'idle-one', status: 'idle' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('session:20261112_101500_abc');
    expect(items[0]!.url).toBe('/chat?session=20261112_101500_abc');
    expect(items[0]!.attention).toBe('waiting');
    expect(items[0]!.state).toBe('attention');
    expect(items[0]!.since).toBe(NOW - 90);
  });

  it('borrows the profile from the session rows, so the link opens the right store', () => {
    const [item] = fromWaiting([liveRow()], [session({ id: '20261112_101500_abc', profile: 'research' })]);
    expect(item!.owner).toBe('research');
    expect(item!.url).toBe('/chat?session=20261112_101500_abc&profile=research');
  });

  it('falls back to the live handle only when there is no stored id', () => {
    const [item] = fromWaiting([liveRow({ session_key: null })]);
    expect(item!.url).toBe('/chat?session=a1b2c3d4');
  });

  it('borrows the title from the stored row when the live one has none', () => {
    const [item] = fromWaiting([liveRow({ title: '' })], [session({ id: '20261112_101500_abc', title: 'Stored title' })]);
    expect(item!.title).toBe('Stored title');
  });

  it('counts each session once, and counts nothing on an empty or absent list', () => {
    expect(countWaiting([liveRow(), liveRow({ id: 'dup' }), liveRow({ status: 'working', session_key: 'x' })])).toBe(1);
    expect(countWaiting(undefined)).toBe(0);
    expect(fromWaiting(undefined)).toEqual([]);
  });

  /* One odd row must cost that row, not the lane — a throw would read as
     "nobody is waiting". */
  it('parses row by row', () => {
    const rows = parseLiveSessions({ sessions: [liveRow(), { status: 'waiting' }, null, 'x'] });
    expect(rows).toHaveLength(1);
    expect(parseLiveSessions(null)).toEqual([]);
    expect(parseLiveSessions({ sessions: 'nope' })).toEqual([]);
  });
});

describe('kanban cards that are your move', () => {
  const columns = (blocked: Task[], review: Task[] = []) => [
    { name: 'running', tasks: [task({ id: 'r' })] },
    { name: 'blocked', tasks: blocked },
    { name: 'review', tasks: review },
    { name: 'done', tasks: [task({ id: 'd' })] },
  ];

  it('takes Blocked and Review and nothing else', () => {
    const items = fromKanbanAttention(columns([task({ id: 'b' })], [task({ id: 'v' })]));
    expect(items.map((i) => [i.id, i.attention])).toEqual([
      ['kanban:b', 'blocked'],
      ['kanban:v', 'review'],
    ]);
    expect(items[0]!.url).toBe('/kanban?task=b');
  });

  /* The same split the push sweep makes: a card that ran out of retries is
     not a question, and the error is the useful line. */
  it('says which kind of blocked it is', () => {
    const [asking, gaveUp, other] = fromKanbanAttention(
      columns([
        task({ id: 'q', block_kind: 'needs_input', latest_summary: null }),
        task({ id: 'f', consecutive_failures: 3, last_failure_error: 'Timeout after 600s' }),
        task({ id: 'o', block_kind: 'waiting_on_parent', latest_summary: null }),
      ]),
    );
    expect(asking!.detail).toBe('Asking you a question');
    expect(gaveUp!.detail).toBe('Timeout after 600s');
    expect(gaveUp!.note).toBe('Gave up');
    expect(other!.detail).toBe('Blocked (waiting on parent)');
  });

  it('counts from the board when it is in hand, from /stats otherwise', () => {
    const board = columns([task({ id: 'b1' }), task({ id: 'b2' })], [task({ id: 'v' })]);
    expect(countAttentionCards(board, { blocked: 9, review: 9 })).toBe(3);
    expect(countAttentionCards(undefined, { blocked: 2, review: 1, running: 4 })).toBe(3);
    expect(countAttentionCards(undefined, undefined)).toBe(0);
    expect(countAttentionCards(undefined, { blocked: Number.NaN })).toBe(0);
  });
});

describe('pairing requests', () => {
  it('reads the pending list the backend returns, never a code', () => {
    const rows = parsePendingPairing(
      {
        pending: [
          { platform: 'telegram', request_id: 'r1', user_id: '42', user_name: 'Ana', age_minutes: 5 },
          { platform: 'discord', request_id: '', user_id: 7, user_name: '', age_minutes: 0 },
          'junk',
        ],
        approved: [{ user_id: '1' }],
      },
      'default',
    );
    expect(rows).toEqual([
      { platform: 'telegram', requestId: 'r1', user: 'Ana', ageMinutes: 5, profile: 'default' },
      { platform: 'discord', requestId: '', user: '7', ageMinutes: 0, profile: 'default' },
    ]);
    expect(parsePendingPairing({}, null)).toEqual([]);
  });

  it('leads to the Machine screen’s pairing section', () => {
    const pending: PendingPairing[] = [
      { platform: 'telegram', requestId: 'r1', user: 'Ana', ageMinutes: 5, profile: 'research' },
      { platform: 'telegram', requestId: 'r1', user: 'Ana', ageMinutes: 5, profile: 'research' },
    ];
    const items = fromPairing(pending, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Ana on Telegram');
    expect(items[0]!.url).toBe('/machine#pairing');
    expect(items[0]!.owner).toBe('research');
    expect(items[0]!.since).toBe(NOW - 300);
  });
});

describe('the needs-you list', () => {
  it('leads with a session parked mid-turn, review last', () => {
    const merged = mergeNeedsYou(
      fromKanbanAttention([{ name: 'review', tasks: [task({ id: 'v', started_at: NOW })] }]),
      fromPairing([{ platform: 'slack', requestId: 'p', user: 'Bo', ageMinutes: 1, profile: null }], NOW),
      fromKanbanAttention([{ name: 'blocked', tasks: [task({ id: 'b' })] }]),
      fromWaiting([liveRow()]),
    );
    expect(merged.map((i) => i.attention)).toEqual(['waiting', 'blocked', 'pairing', 'review']);
  });
});

describe('failed in the last 24h', () => {
  const NOW_MS = NOW * 1000;
  const entry = (over: Partial<NotificationEntry> = {}): NotificationEntry => ({
    id: Math.random().toString(36),
    at: NOW_MS - 60_000,
    kind: 'cron.failed',
    source: 'cron',
    severity: 'error',
    title: 'nightly-backup',
    body: '**RuntimeError**: disk full\nmore detail',
    url: '/cron?job=j1',
    jobId: 'j1',
    jobName: 'nightly-backup',
    runId: null,
    status: 'error',
    failed: true,
    sessionId: null,
    ...over,
  });

  it('keeps failures inside the window and drops everything else', () => {
    const items = recentFailures(
      [
        entry(),
        entry({ jobId: 'old', url: '/cron?job=old', at: NOW_MS - FAILED_WINDOW_MS - 1 }),
        entry({ jobId: 'ok', url: '/chat?session=s', failed: false, severity: 'ok' }),
        entry({ jobId: null, kind: 'backend.down', severity: 'warn', failed: false, url: '/settings' }),
      ],
      NOW_MS,
    );
    expect(items.map((i) => i.url)).toEqual(['/cron?job=j1']);
    expect(items[0]!.state).toBe('failed');
    expect(items[0]!.detail).toBe('RuntimeError: disk full');
  });

  /* A job failing every five minutes is one problem, not 288 rows. */
  it('groups a job’s failures, newest speaking for the group', () => {
    const items = recentFailures(
      [
        entry({ at: NOW_MS - 1_000, url: '/chat?session=newest', body: 'newest' }),
        entry({ at: NOW_MS - 5_000, url: '/chat?session=older', body: 'older' }),
        entry({ at: NOW_MS - 9_000, url: '/chat?session=oldest', body: 'oldest' }),
      ],
      NOW_MS,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.count).toBe(3);
    expect(items[0]!.url).toBe('/chat?session=newest');
    expect(items[0]!.detail).toBe('newest');
  });

  it('counts severity `error` as a failure even where `failed` is not set', () => {
    const items = recentFailures(
      [entry({ jobId: null, kind: 'kanban.triage', source: 'system', failed: false, url: '/kanban?task=t9' })],
      NOW_MS,
    );
    expect(items).toHaveLength(1);
  });

  /* A card that gave up is both a feed failure and a Blocked card; it is
     listed once, where the action is. */
  it('leaves out what "Needs you" already lists', () => {
    const items = recentFailures(
      [entry({ jobId: null, url: '/kanban?task=t1' }), entry()],
      NOW_MS,
      new Set(['/kanban?task=t1']),
    );
    expect(items.map((i) => i.url)).toEqual(['/cron?job=j1']);
  });

  it('survives an absent feed', () => {
    expect(recentFailures(undefined, NOW_MS)).toEqual([]);
  });
});
