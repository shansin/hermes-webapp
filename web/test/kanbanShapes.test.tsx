/**
 * Surviving a response that is missing a key.
 *
 * `workers.data?.workers.length ?? 0` reads like a guarded access and is not:
 * the `?.` covers `data` only, so a payload that arrives **present but without
 * the key** turns the rest into a plain `.length` on `undefined`. The throw
 * does not blank the sheet — there is no error boundary anywhere in `App.tsx`,
 * so it unmounts the whole app, which is the same way a skill with a null
 * category once took every screen down (see CLAUDE.md).
 *
 * It is not a hypothetical shape. These are new plugin routes: a Hermes whose
 * kanban plugin predates one of them, a proxy answering a route it does not
 * know, or any version drift between the app and the backend produces exactly
 * it — a 200 whose body is not what this version expects. The app has to
 * render an empty section and carry on.
 *
 * Found by driving the real build in a browser against a stub backend, which
 * is the only place it shows: every unit test here passed while the app was
 * blanking on the first tap of Board health.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

/** Whatever the endpoints "answered" for this test. */
let payloads: Record<string, unknown>;

vi.mock('../src/api/kanbanAdmin', () => ({
  useBoardStats: () => ({ data: payloads.stats, isLoading: false, error: null }),
  useDiagnostics: () => ({ data: payloads.diagnostics, isLoading: false, error: null }),
  useActiveWorkers: () => ({ data: payloads.workers, isLoading: false, error: null }),
}));

vi.mock('../src/api/kanban', () => ({
  useDispatch: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReclaimTask: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTerminateRun: () => ({ mutateAsync: vi.fn(), isPending: false }),
  dispatchRows: () => [],
}));

vi.mock('../src/store/ui', () => ({ useUi: (pick: (s: unknown) => unknown) => pick({ toast: vi.fn() }) }));
vi.mock('../src/lib/haptics', () => ({ buzz: vi.fn() }));

import { BoardHealthSheet } from '../src/components/kanban/BoardHealthSheet';

afterEach(cleanup);

const show = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(BoardHealthSheet, {
        open: true,
        board: null,
        onClose: vi.fn(),
        onOpenTask: vi.fn(),
      }) as ReactNode,
    ),
  );
};

describe('board health against an unexpected payload', () => {
  /** The exact shape that crashed: a 200 with none of the keys on it. */
  it('renders when every endpoint answers with an empty object', () => {
    payloads = { stats: {}, diagnostics: {}, workers: {} };
    expect(() => show()).not.toThrow();
    expect(screen.getByText('QUEUE')).toBeTruthy();
  });

  it('renders when the endpoints answer with nothing at all', () => {
    payloads = { stats: undefined, diagnostics: undefined, workers: undefined };
    expect(() => show()).not.toThrow();
  });

  /* Half a payload is the version-drift shape: the count arrived, the rows the
     count describes did not. */
  it('renders when a count arrives without the rows it counts', () => {
    payloads = { stats: {}, diagnostics: { count: 3 }, workers: { count: 2 } };
    expect(() => show()).not.toThrow();
    expect(screen.getByText(/No worker processes are running/)).toBeTruthy();
  });

  /* And a diagnostics row whose own nested list is absent. */
  it('renders a diagnostics row carrying no diagnostics', () => {
    payloads = {
      stats: {},
      workers: {},
      diagnostics: { count: 1, diagnostics: [{ task_id: 't_1', task_title: 'A card' }] },
    };
    expect(() => show()).not.toThrow();
    expect(screen.getByText('A card')).toBeTruthy();
  });

  it('still renders the real shape', () => {
    payloads = {
      stats: { by_status: { blocked: 1, done: 7 }, oldest_ready_age_seconds: null, now: 0 },
      workers: { workers: [], count: 0, checked_at: 0 },
      diagnostics: { diagnostics: [], count: 0 },
    };
    show();
    expect(screen.getByText('blocked 1')).toBeTruthy();
    expect(screen.getByText('Hermes has nothing to report')).toBeTruthy();
  });
});
