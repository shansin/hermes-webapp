/**
 * The board-level routes, where the two dangerous flags live.
 *
 * Almost everything in this module is a read. The exceptions are the ones that
 * cannot be taken back, and both are a boolean away from the safe behaviour:
 *
 * - **`DELETE /boards/<slug>` archives by default and destroys with
 *   `?delete=true`.** The hard form takes the board's whole SQLite file with
 *   it — every card, run, comment and attachment — and Hermes has no restore
 *   anywhere. A caller that sent the flag by default, or built the query with
 *   the wrong separator so it landed on the path, would be one mis-tap from an
 *   unrecoverable loss.
 * - **`describe-auto` overwrites a profile's description.** The old text is
 *   stored nowhere else, and the description is what the decomposer routes
 *   on — so regenerating over a hand-written one both destroys it and changes
 *   which agent gets which work. `overwrite` defaults to false for that reason.
 *
 * Beyond those: the orchestration settings are read here because
 * `auto_decompose` decides whether the app's "new cards start in Triage"
 * default is a queue or a parking lot, and `default_assignee` distinguishes
 * "not set" from "resolves to something" — a difference the empty string hides
 * and `resolved_default_assignee` is the only witness to.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiPut = vi.fn();
const apiDel = vi.fn();

vi.mock('../src/api/client', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    patch: (...a: unknown[]) => apiPatch(...a),
    put: (...a: unknown[]) => apiPut(...a),
    del: (...a: unknown[]) => apiDel(...a),
  },
}));

import * as admin from '../src/api/kanbanAdmin';

function wrap() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  for (const m of [apiGet, apiPost, apiPatch, apiPut, apiDel]) m.mockReset();
  apiGet.mockResolvedValue({});
  apiPost.mockResolvedValue({ ok: true });
  apiPatch.mockResolvedValue({ ok: true });
  apiPut.mockResolvedValue({});
  apiDel.mockResolvedValue({});
});

describe('deleting a board', () => {
  /* Archive is the default because it is the recoverable one. A hard delete
     is a permanent loss of every card, run and comment on that board. */
  it('archives unless a hard delete is asked for by name', async () => {
    const { result } = renderHook(() => admin.useDeleteBoard(), { wrapper: wrap() });
    await result.current.mutateAsync({ slug: 'old' });
    expect(apiDel.mock.calls[0]![0]).toBe('/api/plugins/kanban/boards/old');
  });

  it('sends the destroy flag only when asked', async () => {
    const { result } = renderHook(() => admin.useDeleteBoard(), { wrapper: wrap() });
    await result.current.mutateAsync({ slug: 'old', hard: true });
    expect(apiDel.mock.calls[0]![0]).toBe('/api/plugins/kanban/boards/old?delete=true');
  });

  it('encodes a slug rather than letting it reach the path raw', async () => {
    const { result } = renderHook(() => admin.useDeleteBoard(), { wrapper: wrap() });
    await result.current.mutateAsync({ slug: 'a/b' });
    expect(apiDel.mock.calls[0]![0]).toBe('/api/plugins/kanban/boards/a%2Fb');
  });
});

describe('profile descriptions', () => {
  /**
   * The description is what the decomposer matches work against, so an empty
   * one is not "no preference" — it is a profile that can never be picked.
   * Clearing has to be expressible, and `null` is how the endpoint takes it.
   */
  it('clears a description with null rather than an empty string', async () => {
    const { result } = renderHook(() => admin.useSetProfileDescription(), { wrapper: wrap() });
    await result.current.mutateAsync({ name: 'research', description: null });
    expect(apiPatch.mock.calls[0]![0]).toBe('/api/plugins/kanban/profiles/research');
    expect(apiPatch.mock.calls[0]![1]).toEqual({ description: null });
  });

  /* The old text is stored nowhere else. Defaulting to overwrite would make
     "write one for me" quietly destructive on a profile someone described. */
  it('refuses to overwrite by default', async () => {
    const { result } = renderHook(() => admin.useAutoDescribeProfile(), { wrapper: wrap() });
    await result.current.mutateAsync({ name: 'research' });
    expect(apiPost.mock.calls[0]![1]).toEqual({ overwrite: false });
  });

  it('overwrites only when told to', async () => {
    const { result } = renderHook(() => admin.useAutoDescribeProfile(), { wrapper: wrap() });
    await result.current.mutateAsync({ name: 'research', overwrite: true });
    expect(apiPost.mock.calls[0]![1]).toEqual({ overwrite: true });
  });

  /**
   * `ok: false` is not an HTTP error here either — a missing auxiliary model
   * answers 200 with a reason. A caller that only caught rejections would
   * report success for a profile whose description never changed.
   */
  it('surfaces a refusal that arrived as a 200', async () => {
    apiPost.mockResolvedValue({ ok: false, profile: 'research', reason: 'no auxiliary client', description: null });
    const { result } = renderHook(() => admin.useAutoDescribeProfile(), { wrapper: wrap() });
    const res = await result.current.mutateAsync({ name: 'research' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no auxiliary client');
  });
});

describe('orchestration', () => {
  it('sends only the setting that changed', async () => {
    const { result } = renderHook(() => admin.useSetOrchestration(), { wrapper: wrap() });
    await result.current.mutateAsync({ auto_decompose: false });
    expect(apiPut.mock.calls[0]![0]).toBe('/api/plugins/kanban/orchestration');
    expect(apiPut.mock.calls[0]![1]).toEqual({ auto_decompose: false });
  });

  /**
   * The empty string is a real, distinct value: it means "let Hermes resolve
   * it". Treating it as "unset" and omitting it would make the Inherit option
   * a no-op that silently kept whatever was pinned.
   */
  it('can set the default assignee back to inherit', async () => {
    const { result } = renderHook(() => admin.useSetOrchestration(), { wrapper: wrap() });
    await result.current.mutateAsync({ default_assignee: '' });
    expect(apiPut.mock.calls[0]![1]).toEqual({ default_assignee: '' });
  });
});

describe('board-scoped health reads', () => {
  it('carry the board, and omit it for the server’s current one', () => {
    renderHook(() => admin.useBoardStats('work'), { wrapper: wrap() });
    renderHook(() => admin.useActiveWorkers(null), { wrapper: wrap() });
    renderHook(() => admin.useDiagnostics('work', 'critical'), { wrapper: wrap() });

    const urls = apiGet.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain('/api/plugins/kanban/stats?board=work');
    expect(urls).toContain('/api/plugins/kanban/workers/active');
    expect(urls).toContain('/api/plugins/kanban/diagnostics?severity=critical&board=work');
  });

  /* The severity filter starts the query string, so the board has to join it
     with `&`. Getting that wrong produces two `?` and drops the filter. */
  it('joins the board onto an existing query', () => {
    renderHook(() => admin.useDiagnostics('work', 'warning'), { wrapper: wrap() });
    expect(apiGet.mock.calls[0]![0]).toBe(
      '/api/plugins/kanban/diagnostics?severity=warning&board=work',
    );
  });

  /* Every one of these is gated so a closed sheet costs nothing — the workers
     query polls, and an always-on poll behind a sheet nobody opened is a
     request every ten seconds for the life of the screen. */
  it('does not fetch while their sheet is closed', () => {
    renderHook(() => admin.useBoardStats('work', false), { wrapper: wrap() });
    renderHook(() => admin.useActiveWorkers('work', false), { wrapper: wrap() });
    renderHook(() => admin.useDiagnostics('work', null, false), { wrapper: wrap() });
    renderHook(() => admin.useKanbanProfiles(false), { wrapper: wrap() });
    renderHook(() => admin.useOrchestration(false), { wrapper: wrap() });
    renderHook(() => admin.useKanbanModelOptions(false), { wrapper: wrap() });
    expect(apiGet).not.toHaveBeenCalled();
  });
});
