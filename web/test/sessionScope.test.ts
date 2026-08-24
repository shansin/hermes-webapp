/**
 * Which profile's store a session call reads.
 *
 * Sessions live in per-profile `state.db` files and every endpoint addresses
 * one at a time. Omitting the profile means "the active one", which was the
 * only possible answer until a second profile existed — and then became a
 * silent filter: a kanban task running as `research` opened a live session the
 * sessions screen could not see and gave no hint of.
 *
 * The detail route is the sharp edge. It does not report the mismatch; it
 * answers **404 Session not found** for a session that plainly exists, which
 * reads as "deleted" rather than "wrong store". Verified against the live
 * backend while this was written:
 *
 *   GET /api/sessions/<id>                   → 404
 *   GET /api/sessions/<id>?profile=research  → 200
 */
import { describe, it, expect } from 'vitest';
import { sessionUrl } from '../src/api/sessions';

describe('sessionUrl', () => {
  it('leaves the path alone for the active profile', () => {
    expect(sessionUrl('/api/sessions')).toBe('/api/sessions');
    expect(sessionUrl('/api/sessions', null)).toBe('/api/sessions');
    expect(sessionUrl('/api/sessions', '')).toBe('/api/sessions');
  });

  it('appends the profile when there is no existing query', () => {
    expect(sessionUrl('/api/sessions/abc', 'research')).toBe('/api/sessions/abc?profile=research');
  });

  it('joins with & when the path already carries a query', () => {
    expect(sessionUrl('/api/sessions?limit=100&archived=exclude', 'research')).toBe(
      '/api/sessions?limit=100&archived=exclude&profile=research',
    );
  });

  it('never leaves a bare trailing ?', () => {
    // An earlier shape built the suffix and sliced its separator off, which
    // produced `/api/sessions/abc?` whenever no profile was named.
    for (const url of [sessionUrl('/api/sessions/abc'), sessionUrl('/api/sessions/abc', null)]) {
      expect(url.endsWith('?')).toBe(false);
    }
  });

  it('encodes a name that would otherwise change the query', () => {
    expect(sessionUrl('/api/sessions', 'a&profile=b')).toBe(
      '/api/sessions?profile=a%26profile%3Db',
    );
  });

  it('does not treat a profile named "0" as absent', () => {
    expect(sessionUrl('/api/sessions', '0')).toBe('/api/sessions?profile=0');
  });
});

/**
 * The task→session join, as `useTaskSession` performs it.
 *
 * Hermes leaves `session_id` null on the task row for the whole run, so the
 * only available join is the session's derived title — `work kanban task <id>`
 * — plus `source: kanban`. The predicate is reproduced here rather than
 * exported from the hook, because what is being pinned is the *rule*: match on
 * both, and never match a session belonging to a different task.
 */
const matches = (row: { source?: string | null; title?: string | null }, taskId: string) =>
  (row.source ?? '').toLowerCase() === 'kanban' &&
  typeof row.title === 'string' &&
  row.title.includes(taskId);

describe('task → session correlation', () => {
  const taskId = 't_06a15459';

  it('matches the session a kanban run opened', () => {
    expect(matches({ source: 'kanban', title: `work kanban task ${taskId}` }, taskId)).toBe(true);
  });

  it('ignores a session for a different task', () => {
    expect(matches({ source: 'kanban', title: 'work kanban task t_23f03886' }, taskId)).toBe(false);
  });

  it('ignores a non-kanban session that happens to mention the id', () => {
    // A chat where you pasted the task id is not the run's transcript, and
    // opening it instead would be worse than showing nothing.
    expect(matches({ source: 'web', title: `why did ${taskId} fail` }, taskId)).toBe(false);
    expect(matches({ source: 'cron', title: `${taskId} digest` }, taskId)).toBe(false);
  });

  it('tolerates a missing or oddly-cased source', () => {
    expect(matches({ source: 'KANBAN', title: `work kanban task ${taskId}` }, taskId)).toBe(true);
    expect(matches({ source: null, title: `work kanban task ${taskId}` }, taskId)).toBe(false);
  });

  it('does not match a row with no title', () => {
    expect(matches({ source: 'kanban', title: null }, taskId)).toBe(false);
    expect(matches({ source: 'kanban' }, taskId)).toBe(false);
  });
});
