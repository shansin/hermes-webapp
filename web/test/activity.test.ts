/**
 * Turning three unrelated API shapes into one "what is running" list.
 *
 * The failures worth catching here are the quiet ones. Missing a running
 * delegation defeats the point of the pane; showing a crashed kanban worker as
 * healthy is worse, because it reads as progress. And every field these
 * normalisers touch is optional on the wire, so an older Hermes that omits
 * `is_active` entirely has to produce an empty list rather than a crash.
 */
import { describe, expect, it } from 'vitest';
import {
  QUIET_AFTER_S,
  countRunning,
  fromCron,
  fromKanban,
  fromSessions,
  isQuiet,
  mergeActivity,
  type ActivityItem,
} from '../src/lib/activity';
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
