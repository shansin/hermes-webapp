/**
 * Hiding a session before its delete is sent.
 *
 * The undo toasts on the Sessions screen work by removing rows from the query
 * cache and holding the request for the life of the toast (`lib/undo.ts`), so
 * the cache edit *is* the feature — if it misses, the row stays put and the
 * tap looks like it did nothing, while the delete goes through eight seconds
 * later regardless.
 *
 * It is tested because there are now two shapes filed under the `['sessions']`
 * prefix: the plain lists, and the paged list's `{ pages: [...] }`. A setter
 * that understood one and quietly ignored the other is exactly the failure
 * this suite exists to catch — nothing throws, nothing logs, the row simply
 * does not move.
 */
import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { hideSessions, restoreSessions, sessionKeys } from '../src/api/sessions';
import type { SessionList, SessionRow } from '../src/api/sessions';

function row(id: string): SessionRow {
  return {
    id,
    title: id,
    source: null,
    model: null,
    started_at: 1,
    ended_at: null,
    message_count: 0,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
  };
}

function list(...ids: string[]): SessionList {
  return { sessions: ids.map(row), total: ids.length, limit: 100, offset: 0 };
}

describe('hideSessions', () => {
  it('removes rows from a plain list', () => {
    const qc = new QueryClient();
    qc.setQueryData(sessionKeys.list(100), list('a', 'b', 'c'));

    hideSessions(qc, new Set(['b']));

    const after = qc.getQueryData<SessionList>(sessionKeys.list(100));
    expect(after?.sessions.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('removes rows from every page of a paged list', () => {
    // The shape the sessions screen actually reads once "Show older" has been
    // used. A row can sit on any page, so every page has to be walked.
    const qc = new QueryClient();
    qc.setQueryData(sessionKeys.pages(), {
      pages: [list('a', 'b'), list('c', 'd')],
      pageParams: [0, 100],
    });

    hideSessions(qc, new Set(['b', 'c']));

    const after = qc.getQueryData<{ pages: SessionList[] }>(sessionKeys.pages());
    expect(after?.pages.map((p) => p.sessions.map((s) => s.id))).toEqual([['a'], ['d']]);
  });

  it('hits both shapes in one pass', () => {
    // The same session is listed by the screen and by the chat header's
    // recent-sessions query, and both have to lose the row or it reappears
    // the moment you navigate.
    const qc = new QueryClient();
    qc.setQueryData(sessionKeys.list(3), list('a', 'b'));
    qc.setQueryData(sessionKeys.pages(), { pages: [list('a', 'b')], pageParams: [0] });

    hideSessions(qc, new Set(['a']));

    expect(qc.getQueryData<SessionList>(sessionKeys.list(3))?.sessions).toHaveLength(1);
    expect(
      qc.getQueryData<{ pages: SessionList[] }>(sessionKeys.pages())?.pages[0]!.sessions,
    ).toHaveLength(1);
  });

  it('leaves unrelated cache entries alone', () => {
    const qc = new QueryClient();
    qc.setQueryData(sessionKeys.stats, { anything: true });
    qc.setQueryData(['kanban', 'board'], { columns: [] });

    expect(() => hideSessions(qc, new Set(['a']))).not.toThrow();
    expect(qc.getQueryData(sessionKeys.stats)).toEqual({ anything: true });
    expect(qc.getQueryData(['kanban', 'board'])).toEqual({ columns: [] });
  });

  it('puts back exactly what it found', () => {
    // Undo has to restore the list as it was, not wait on a refetch — the
    // request never went out, so a refetch would be the only thing that could
    // bring the row back, and over a slow link that is a visible gap.
    const qc = new QueryClient();
    const before = list('a', 'b', 'c');
    qc.setQueryData(sessionKeys.list(100), before);

    const snapshot = hideSessions(qc, new Set(['a', 'b']));
    expect(qc.getQueryData<SessionList>(sessionKeys.list(100))?.sessions).toHaveLength(1);

    restoreSessions(qc, snapshot);
    expect(qc.getQueryData<SessionList>(sessionKeys.list(100))).toEqual(before);
  });
});
