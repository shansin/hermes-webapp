/**
 * Which board a kanban call addresses.
 *
 * Every route in the plugin takes `?board=<slug>`, and omitting it does **not**
 * mean "the only board" — it means whatever the server's own pointer currently
 * says. `POST /boards/<slug>/switch` moves that pointer, and it is process-wide:
 * the desktop app, a CLI, or a cron job switching boards silently redirects
 * every unqualified call this app makes. The board on screen would keep its
 * title and its cards while the card being dragged landed in a different
 * SQLite file, and nothing anywhere would report it — the same shape of silent
 * cross-write that `?profile=` has on sessions, cron, skills and models.
 *
 * So the slug is threaded explicitly through every read and every write, and
 * this file pins each one. The reads matter as much as the writes: a board
 * fetched with a slug and a task fetched without one is a sheet describing a
 * card that is not on the board behind it.
 *
 * The query keys carry the slug for the same reason. Two boards sharing one
 * cache entry means switching boards shows the previous board's cards until
 * the refetch lands, and a mutation on one invalidates the other.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiDel = vi.fn();
const apiPut = vi.fn();

vi.mock('../src/api/client', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    patch: (...a: unknown[]) => apiPatch(...a),
    del: (...a: unknown[]) => apiDel(...a),
    put: (...a: unknown[]) => apiPut(...a),
  },
}));

import * as kanban from '../src/api/kanban';
import { kanbanUrl, kanbanKeys } from '../src/api/kanban';

function wrap() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

/** Drive a mutation hook once and hand back the URL it called. */
async function callWith<T>(
  hook: () => { mutateAsync: (v: T) => Promise<unknown> },
  vars: T,
): Promise<void> {
  const { result } = renderHook(hook, { wrapper: wrap() });
  await result.current.mutateAsync(vars);
}

const urls = () =>
  [...apiGet.mock.calls, ...apiPost.mock.calls, ...apiPatch.mock.calls, ...apiDel.mock.calls].map(
    (c) => c[0] as string,
  );

beforeEach(() => {
  for (const m of [apiGet, apiPost, apiPatch, apiDel, apiPut]) m.mockReset();
  apiGet.mockResolvedValue({ columns: [], assignees: [], tenants: [] });
  apiPost.mockResolvedValue({ ok: true, task: { id: 't_1', status: 'ready' } });
  apiPatch.mockResolvedValue({ task: { id: 't_1', status: 'ready' } });
  apiDel.mockResolvedValue({ deleted: true });
});

describe('kanbanUrl', () => {
  it('leaves the path alone for the server’s current board', () => {
    expect(kanbanUrl('/board')).toBe('/api/plugins/kanban/board');
    expect(kanbanUrl('/board', null)).toBe('/api/plugins/kanban/board');
    // The empty string is the same statement as null, not a board named "".
    expect(kanbanUrl('/board', '')).toBe('/api/plugins/kanban/board');
  });

  it('appends the board, joining an existing query with &', () => {
    expect(kanbanUrl('/board', 'work')).toBe('/api/plugins/kanban/board?board=work');
    expect(kanbanUrl('/tasks/t_1/log?tail=100', 'work')).toBe(
      '/api/plugins/kanban/tasks/t_1/log?tail=100&board=work',
    );
  });

  it('encodes a slug that would otherwise change the query', () => {
    expect(kanbanUrl('/board', 'a&board=b')).toBe('/api/plugins/kanban/board?board=a%26board%3Db');
  });
});

describe('reads carry the board', () => {
  it('board, with its tenant and archived flags', () => {
    renderHook(() => kanban.useBoard({ board: 'work', tenant: 'acme', includeArchived: true }), {
      wrapper: wrap(),
    });
    expect(apiGet.mock.calls[0]![0]).toBe(
      '/api/plugins/kanban/board?tenant=acme&include_archived=true&board=work',
    );
  });

  it('task detail', () => {
    renderHook(() => kanban.useTask('t_1', 'work'), { wrapper: wrap() });
    expect(apiGet.mock.calls[0]![0]).toBe('/api/plugins/kanban/tasks/t_1?board=work');
  });

  it('worker log', () => {
    renderHook(() => kanban.useTaskLog('t_1', true, 'work', 500), { wrapper: wrap() });
    expect(apiGet.mock.calls[0]![0]).toBe('/api/plugins/kanban/tasks/t_1/log?tail=500&board=work');
  });

  it('home channels', () => {
    renderHook(() => kanban.useHomeChannels('t_1', 'work'), { wrapper: wrap() });
    expect(apiGet.mock.calls[0]![0]).toBe(
      '/api/plugins/kanban/home-channels?task_id=t_1&board=work',
    );
  });

  it('run inspect', () => {
    renderHook(() => kanban.useRunInspect(41, 'work'), { wrapper: wrap() });
    expect(apiGet.mock.calls[0]![0]).toBe('/api/plugins/kanban/runs/41/inspect?board=work');
  });
});

describe('writes carry the board', () => {
  it('create', async () => {
    await callWith(() => kanban.useCreateTask('work'), { title: 'x' });
    expect(urls()).toContain('/api/plugins/kanban/tasks?board=work');
  });

  it('update', async () => {
    await callWith(() => kanban.useUpdateTask('work'), { id: 't_1', priority: 2 });
    expect(urls()).toContain('/api/plugins/kanban/tasks/t_1?board=work');
  });

  it('delete', async () => {
    await callWith(() => kanban.useDeleteTask('work'), 't_1');
    expect(urls()).toContain('/api/plugins/kanban/tasks/t_1?board=work');
  });

  it('comment', async () => {
    await callWith(() => kanban.useAddComment('work'), { id: 't_1', body: 'hi' });
    expect(urls()).toContain('/api/plugins/kanban/tasks/t_1/comments?board=work');
  });

  /* Both halves, and this is the one where getting it wrong is worst: the
     comment landing on one board's card and the release on another's leaves a
     card unblocked with no answer on it. */
  it('unblock — the comment and the release', async () => {
    await callWith(() => kanban.useUnblockTask('work'), { id: 't_1', note: 'do this' });
    expect(urls()).toEqual([
      '/api/plugins/kanban/tasks/t_1/comments?board=work',
      '/api/plugins/kanban/tasks/t_1?board=work',
    ]);
  });

  it('specify and decompose', async () => {
    await callWith(() => kanban.useSpecifyTask('work'), 't_1');
    await callWith(() => kanban.useDecomposeTask('work'), 't_1');
    expect(urls()).toEqual([
      '/api/plugins/kanban/tasks/t_1/specify?board=work',
      '/api/plugins/kanban/tasks/t_1/decompose?board=work',
    ]);
  });

  it('reclaim, reassign and terminate', async () => {
    await callWith(() => kanban.useReclaimTask('work'), { id: 't_1' });
    await callWith(() => kanban.useReassignTask('work'), { id: 't_1', profile: 'research' });
    await callWith(() => kanban.useTerminateRun('work'), { runId: 41 });
    expect(urls()).toEqual([
      '/api/plugins/kanban/tasks/t_1/reclaim?board=work',
      '/api/plugins/kanban/tasks/t_1/reassign?board=work',
      '/api/plugins/kanban/runs/41/terminate?board=work',
    ]);
  });

  it('bulk', async () => {
    await callWith(() => kanban.useBulkTasks('work'), { ids: ['t_1'], archive: true });
    expect(urls()).toContain('/api/plugins/kanban/tasks/bulk?board=work');
  });

  it('estimate', async () => {
    await callWith(() => kanban.useEstimateTask('work'), 't_1');
    expect(urls()).toContain('/api/plugins/kanban/tasks/t_1/estimate?board=work');
  });

  it('link', async () => {
    await callWith(() => kanban.useLinkTasks('work'), { parentId: 't_1', childId: 't_2' });
    expect(urls()).toContain('/api/plugins/kanban/links?board=work');
  });

  /**
   * Unlink takes its ids in the *query string*, not a body, so the board has
   * to join an existing query rather than start one. A `?board=` written with
   * a leading `?` here would produce a second query string and drop both ids.
   */
  it('unlink — ids in the query, board appended to it', async () => {
    await callWith(() => kanban.useUnlinkTasks('work'), { parentId: 't_1', childId: 't_2' });
    expect(urls()).toContain(
      '/api/plugins/kanban/links?parent_id=t_1&child_id=t_2&board=work',
    );
  });

  it('home subscribe and unsubscribe', async () => {
    await callWith(() => kanban.useHomeSubscription('work'), {
      id: 't_1',
      platform: 'discord',
      on: true,
    });
    await callWith(() => kanban.useHomeSubscription('work'), {
      id: 't_1',
      platform: 'discord',
      on: false,
    });
    expect(urls()).toEqual([
      '/api/plugins/kanban/tasks/t_1/home-subscribe/discord?board=work',
      '/api/plugins/kanban/tasks/t_1/home-subscribe/discord?board=work',
    ]);
  });

  it('dispatch', async () => {
    await callWith(() => kanban.useDispatch('work'), { taskId: 't_1' });
    expect(urls()).toContain('/api/plugins/kanban/dispatch?board=work');
  });
});

describe('query keys', () => {
  /* Two boards sharing a cache entry shows the previous board's cards until
     the refetch lands, and lets a mutation on one invalidate the other. */
  it('separate boards never share a board or task entry', () => {
    expect(kanbanKeys.board('a')).not.toEqual(kanbanKeys.board('b'));
    expect(kanbanKeys.task('t_1', 'a')).not.toEqual(kanbanKeys.task('t_1', 'b'));
  });

  it('an absent board is its own entry, not merged with a named one', () => {
    expect(kanbanKeys.board(null)).toEqual(kanbanKeys.board(undefined));
    expect(kanbanKeys.board(null)).not.toEqual(kanbanKeys.board('default'));
  });

  /**
   * The archived and tenant views are separate entries, and a mutation has to
   * refresh both — which is why mutations invalidate on the *prefix* rather
   * than one exact key. A stale archived view sitting next to a fresh one is
   * the same card in two states on one screen.
   */
  it('the board key is prefixed so one invalidate covers every variant', () => {
    const prefix = ['kanban', 'work', 'board'];
    for (const key of [
      kanbanKeys.board('work'),
      kanbanKeys.board('work', 'acme'),
      kanbanKeys.board('work', null, true),
    ]) {
      expect(key.slice(0, 3)).toEqual(prefix);
    }
  });
});
