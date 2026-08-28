/**
 * The kanban joins and payload shapes that fail silently.
 *
 * **Which conversation a run happened in.** The task row carries no run session
 * id — its `session_id` column holds the session that *created* the card, not
 * the one that worked it — so this was a title correlation and nothing else:
 * `source: kanban` plus a derived title reading `work kanban task <id>`. That
 * title is written by the auxiliary model, and it is routinely not written at
 * all. In this install's research profile most kanban sessions are
 * `title: null`; every one of them was unreachable from its card, which
 * reported "no matching conversation" for runs that had plainly happened, and
 * looked from the board exactly like a run that never opened one. The exact
 * join is `task_runs.metadata.worker_session_id`, which a worker stamps with
 * its own `HERMES_SESSION_ID` on the way out — not every run has it, so it is
 * a fast path rather than a replacement, and the two have to be tried in that
 * order.
 *
 * **Which profile to look in.** Sessions live in per-profile stores and the
 * lookup used `task.assignee`, which is where the card points *now*. A run
 * carries the profile it actually ran as; a reassignment, or a decomposer
 * routing a child to a specialist, makes those two different, and looking in
 * the wrong store returns an empty list rather than an error.
 *
 * **What unblocking has to do first.** Hermes builds the next worker's prompt
 * from title + body + parent results + comments, and the only release is a
 * PATCH to `ready`. Post the comment after the release and the run that was
 * meant to read the answer has already started without it: the worker
 * rediscovers the same blocker, blocks again, and Hermes counts the repeat.
 * So the order is load-bearing and asserted here, along with the refusal to
 * release a card whose answer failed to post.
 *
 * The rest of the file covers payload shapes whose failure mode is the same
 * kind of quiet: a bulk change that reports twelve moved when nine moved, an
 * override cleared with an empty string instead of the flag (which pins the
 * card to a model named `""`), a create that drops the idempotency key or
 * swallows the "no dispatcher is running" warning, and a dispatcher tick read
 * as nested when the wire shape is flat.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiDel = vi.fn();
const apiUpload = vi.fn();

vi.mock('../src/api/client', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    patch: (...a: unknown[]) => apiPatch(...a),
    del: (...a: unknown[]) => apiDel(...a),
    upload: (...a: unknown[]) => apiUpload(...a),
  },
}));

import {
  ATTACHMENT_MAX_BYTES,
  attachmentUrl,
  dispatchRows,
  latestRunHints,
  runSessionId,
  useBulkTasks,
  useCreateTask,
  useDispatch,
  useDeleteAttachment,
  useUnblockTask,
  useUpdateTask,
  useUploadAttachment,
  type Task,
  type TaskRun,
} from '../src/api/kanban';

function wrap() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

/** The single argument a mutation passed to `api.<verb>`, by call index. */
const body = (mock: typeof apiPost, i = 0) => mock.mock.calls[i]![1];

const run = (over: Partial<TaskRun>): TaskRun => ({
  id: 1,
  task_id: 't_1',
  status: 'done',
  outcome: 'completed',
  summary: null,
  error: null,
  started_at: 1000,
  ended_at: 2000,
  ...over,
});

const task = (over: Partial<Task> = {}): Task =>
  ({ id: 't_1', assignee: 'default', status: 'done', ...over }) as Task;

beforeEach(() => {
  apiGet.mockReset();
  apiUpload.mockReset();
  apiDel.mockReset().mockResolvedValue({ ok: true });
  apiPost.mockReset().mockResolvedValue({ ok: true });
  apiPatch.mockReset().mockResolvedValue({ task: task({ status: 'ready' }) });
});

describe('runSessionId', () => {
  it('reads the id a worker stamped into its run metadata', () => {
    expect(runSessionId(run({ metadata: { worker_session_id: '20260826_212029_1a3717' } }))).toBe(
      '20260826_212029_1a3717',
    );
  });

  /* Runs that crashed, were reclaimed, or are still going have no metadata at
     all — and a metadata blob carrying other keys is the common shape. Neither
     may be reported as an id: the caller would fetch `/api/sessions/undefined`
     and read the 404 as "the conversation is gone". */
  it('reports nothing rather than a non-id', () => {
    expect(runSessionId(run({ metadata: null }))).toBeNull();
    expect(runSessionId(run({ metadata: { artifacts: ['/tmp/x.md'] } }))).toBeNull();
    expect(runSessionId(run({ metadata: { worker_session_id: '' } }))).toBeNull();
    expect(runSessionId(run({ metadata: { worker_session_id: 42 } as never }))).toBeNull();
  });
});

describe('latestRunHints', () => {
  it('takes the profile from the run, not from where the card points now', () => {
    // The card was reassigned after it ran. The session is still in `research`.
    expect(
      latestRunHints([run({ profile: 'research' })], task({ assignee: 'default' })).profile,
    ).toBe('research');
  });

  it('falls back to the assignee only when there is no run to ask', () => {
    expect(latestRunHints([], task({ assignee: 'fitness' })).profile).toBe('fitness');
    expect(latestRunHints(undefined, task({ assignee: null })).profile).toBeNull();
  });

  it('picks the newest run by start time, not by array order', () => {
    const hints = latestRunHints(
      [
        run({ id: 1, started_at: 100, profile: 'old', metadata: { worker_session_id: 's_old' } }),
        run({ id: 2, started_at: 900, profile: 'new', metadata: { worker_session_id: 's_new' } }),
      ],
      task(),
    );
    expect(hints).toEqual({ profile: 'new', sessionHint: 's_new' });
  });

  /* Both halves come off the same run on purpose. Reading the profile from the
     newest run and the session id from whichever older one happened to carry
     it builds a lookup for a session that never lived in that store — a 404
     that reads as "deleted". A newest run with no id falls through to the
     title correlation instead, which is the honest answer. */
  it('never mixes one run’s profile with another run’s session id', () => {
    const hints = latestRunHints(
      [
        run({ id: 1, started_at: 100, profile: 'research', metadata: { worker_session_id: 's_1' } }),
        run({ id: 2, started_at: 900, profile: 'default', metadata: null }),
      ],
      task(),
    );
    expect(hints).toEqual({ profile: 'default', sessionHint: null });
  });
});

describe('unblocking a task', () => {
  /**
   * Exercised through the mutation function rather than a rendered sheet: the
   * ordering is the whole behaviour, and it lives in `mutationFn`.
   */
  function unblockFn() {
    return renderHook(() => useUnblockTask(), { wrapper: wrap() }).result;
  }

  it('posts the answer as a comment before releasing the card', async () => {
    const order: string[] = [];
    apiPost.mockImplementation((path: string) => {
      order.push(`POST ${path}`);
      return Promise.resolve({ ok: true });
    });
    apiPatch.mockImplementation((path: string, body: unknown) => {
      order.push(`PATCH ${path} ${JSON.stringify(body)}`);
      return Promise.resolve({ task: task({ status: 'ready' }) });
    });

    const result = unblockFn();
    await result.current.mutateAsync({ id: 't_31c1ac2e', note: 'Cancel any 2 to free a slot' });

    expect(order).toEqual([
      'POST /api/plugins/kanban/tasks/t_31c1ac2e/comments',
      'PATCH /api/plugins/kanban/tasks/t_31c1ac2e {"status":"ready"}',
    ]);
    expect(apiPost.mock.calls[0]![1]).toEqual({
      body: 'Cancel any 2 to free a slot',
      author: 'web',
    });
  });

  /* `ready` is the only status that routes through `unblock_task` — the call
     that closes a dangling run pointer, clears the failure counter and re-gates
     on the parents. A PATCH to `todo` is a direct status write that skips all
     of it, so the card leaves the Blocked column still holding its claim. */
  it('releases to ready, never to todo', async () => {
    const result = unblockFn();
    await result.current.mutateAsync({ id: 't_1' });
    expect(apiPatch.mock.calls[0]![1]).toEqual({ status: 'ready' });
  });

  it('sends no empty comment when there is no answer to give', async () => {
    const result = unblockFn();
    await result.current.mutateAsync({ id: 't_1', note: '   ' });
    expect(apiPost).not.toHaveBeenCalled();
    expect(apiPatch).toHaveBeenCalledTimes(1);
  });

  /* If the answer did not land, the card must stay blocked. An unblocked card
     with no answer on it burns a run rediscovering the same blocker — and that
     costs a `block_recurrences` increment, which is two away from Hermes
     rerouting the card to Triage. */
  it('leaves the card blocked when the comment fails', async () => {
    apiPost.mockRejectedValueOnce(new Error('offline'));
    const result = unblockFn();
    await expect(result.current.mutateAsync({ id: 't_1', note: 'do this' })).rejects.toThrow(
      'offline',
    );
    expect(apiPatch).not.toHaveBeenCalled();
  });
});

describe('bulk changes', () => {
  /**
   * Hermes applies each id independently and refuses some — a claimed card
   * cannot be reassigned without `reclaim_first`, and a transition may not be
   * legal from where a particular card sits. The HTTP status is 200 either way,
   * so a caller reading only that reports "12 moved" for a call where nine
   * moved, with no way to tell which three did not.
   */
  it('reports which ids the server refused, not just the call succeeding', async () => {
    apiPost.mockResolvedValueOnce({
      results: [
        { id: 't_1', ok: true },
        { id: 't_2', ok: false, error: 'task is claimed' },
      ],
    });
    const { result } = renderHook(() => useBulkTasks(), { wrapper: wrap() });
    const res = await result.current.mutateAsync({ ids: ['t_1', 't_2'], status: 'ready' });

    expect(res.results.filter((r) => !r.ok)).toEqual([
      { id: 't_2', ok: false, error: 'task is claimed' },
    ]);
  });

  it('sends the ids alongside the change', async () => {
    apiPost.mockResolvedValueOnce({ results: [] });
    const { result } = renderHook(() => useBulkTasks(), { wrapper: wrap() });
    await result.current.mutateAsync({ ids: ['t_1'], assignee: 'research', reclaim_first: true });

    expect(body(apiPost)).toEqual({ ids: ['t_1'], assignee: 'research', reclaim_first: true });
  });
});

describe('dispatch', () => {
  /* A dry run is the answer to "why is nothing starting" and it changes
     nothing on the server, so refetching the board afterwards would be both a
     wasted round trip and a claim that something happened. */
  it('does not invalidate the board for a dry run', async () => {
    apiPost.mockResolvedValue({ spawned: [], skipped: { unassigned: 2 } });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);

    const { result } = renderHook(() => useDispatch(), { wrapper });
    await result.current.mutateAsync({ dryRun: true });
    expect(invalidate).not.toHaveBeenCalled();

    await result.current.mutateAsync({});
    expect(invalidate).toHaveBeenCalled();
  });

  it('carries dry_run and max in the query, and the task in the body', async () => {
    apiPost.mockResolvedValue({});
    const { result } = renderHook(() => useDispatch(), { wrapper: wrap() });
    await result.current.mutateAsync({ dryRun: true, max: 3 });
    expect(apiPost.mock.calls[0]![0]).toBe('/api/plugins/kanban/dispatch?dry_run=true&max=3');

    await result.current.mutateAsync({ taskId: 't_1' });
    expect(apiPost.mock.calls[1]![0]).toBe('/api/plugins/kanban/dispatch');
    expect(body(apiPost, 1)).toEqual({ task_id: 't_1' });
  });

  /* The old signature took a bare id. Nothing in the app still calls it that
     way, but the shape is easy to reintroduce by habit and would silently
     become a full board sweep from a sheet showing one card. */
  it('still accepts a bare task id', async () => {
    apiPost.mockResolvedValue({});
    const { result } = renderHook(() => useDispatch(), { wrapper: wrap() });
    await result.current.mutateAsync('t_1');
    expect(body(apiPost)).toEqual({ task_id: 't_1' });
  });
});

describe('per-task overrides', () => {
  /**
   * `null` in a partial PATCH means "unchanged", so there is no way to say
   * "go back to the profile's setting" by omitting a field. Sending an empty
   * string instead of the flag pins the card to a model called `""`.
   */
  it('clears an override with the flag, never with an empty value', async () => {
    const { result } = renderHook(() => useUpdateTask(), { wrapper: wrap() });
    await result.current.mutateAsync({ id: 't_1', clear_model_override: true });
    expect(body(apiPatch)).toEqual({ clear_model_override: true });

    await result.current.mutateAsync({ id: 't_1', clear_reasoning_effort: true });
    expect(body(apiPatch, 1)).toEqual({ clear_reasoning_effort: true });
  });

  it('sends a model with its provider, since Hermes rejects a provider alone', async () => {
    const { result } = renderHook(() => useUpdateTask(), { wrapper: wrap() });
    await result.current.mutateAsync({
      id: 't_1',
      model_override: 'claude-opus-5',
      provider_override: 'anthropic',
    });
    expect(body(apiPatch)).toEqual({
      model_override: 'claude-opus-5',
      provider_override: 'anthropic',
    });
  });
});

describe('creating a task', () => {
  /**
   * A double-tapped Create on a flaky connection is the ordinary phone case.
   * Hermes returns the *existing* card for a key it has seen rather than making
   * a second one, so the key turns a duplicate into a no-op — but only if it is
   * actually sent.
   */
  it('carries an idempotency key', async () => {
    apiPost.mockResolvedValue({ task: { id: 't_1' } });
    const { result } = renderHook(() => useCreateTask(), { wrapper: wrap() });
    await result.current.mutateAsync({ title: 'x', idempotency_key: 'abc' });
    expect(body(apiPost)).toMatchObject({ idempotency_key: 'abc' });
  });

  /**
   * Not an error, and the one message that must not be swallowed: the card was
   * created into Ready with an assignee and no dispatcher is running, so
   * nothing will ever claim it. Hermes says so here and nowhere else.
   */
  it('passes the dispatcher warning through rather than dropping it', async () => {
    apiPost.mockResolvedValue({ task: { id: 't_1' }, warning: 'No gateway is running' });
    const { result } = renderHook(() => useCreateTask(), { wrapper: wrap() });
    const res = await result.current.mutateAsync({ title: 'x' });
    expect(res.warning).toBe('No gateway is running');
  });
});

describe('reading a dispatcher tick', () => {
  /**
   * Captured from a live tick. The buckets are **top-level keys**, not a
   * nested `skipped` object — a flat `asdict` of the dispatcher's own result.
   * A renderer that reached for `result.skipped` found nothing and drew an
   * empty panel, which reads as "the dispatcher had nothing to say" rather
   * than as a bug.
   */
  const LIVE_TICK = {
    reclaimed: 0,
    promoted: 0,
    reconciled_orphans: [],
    spawned: [],
    skipped_unassigned: [],
    auto_assigned_default: [],
    skipped_nonspawnable: [],
    skipped_per_profile_capped: [],
    crashed: [],
    auto_blocked: [],
    timed_out: [],
    stale: [],
    respawn_guarded: [],
    rate_limited: [],
    skipped_locked: false,
    memory_pressure: null,
  };

  it('shows nothing for an idle tick rather than fourteen zeroes', () => {
    expect(dispatchRows(LIVE_TICK)).toEqual([]);
  });

  it('names the buckets that have something in them', () => {
    const rows = dispatchRows({
      ...LIVE_TICK,
      spawned: [{ task_id: 't_1' }],
      skipped_unassigned: ['t_2', 't_3'],
      promoted: 1,
    });
    expect(rows).toEqual([
      { key: 'spawned', label: 'started', detail: '1' },
      { key: 'skipped_unassigned', label: 'skipped — nobody assigned', detail: '2' },
      { key: 'promoted', label: 'promoted to ready', detail: '1' },
    ]);
  });

  /* `skipped_locked` is a boolean — another tick was already running — and it
     is the answer to "I pressed it and nothing happened". A renderer that only
     understood arrays and counts would drop it. */
  it('understands a boolean bucket', () => {
    expect(dispatchRows({ ...LIVE_TICK, skipped_locked: true })).toEqual([
      { key: 'skipped_locked', label: 'skipped locked', detail: 'yes' },
    ]);
  });

  /* The dataclass gains fields between Hermes versions. A row this app has
     never heard of still renders, because dropping it silently is how a
     dispatcher stops explaining itself after an upgrade. */
  it('renders a bucket it has never seen, with its name tidied', () => {
    expect(dispatchRows({ skipped_future_reason: ['t_9'] })).toEqual([
      { key: 'skipped_future_reason', label: 'skipped future reason', detail: '1' },
    ]);
  });

  it('ignores nulls and other non-countable values', () => {
    expect(dispatchRows({ memory_pressure: null, notes: 'hello' } as never)).toEqual([]);
  });
});

describe('attachments', () => {
  /**
   * Not storage. `build_worker_context` puts each attachment's absolute path
   * into the next run's prompt, so a file here is a file the agent can open —
   * which makes this the only route by which a phone hands an agent a document
   * outside a chat message. The multipart shape is what the endpoint requires,
   * and it is not something a JSON body can stand in for.
   */
  it('uploads as multipart, naming the app as the uploader', async () => {
    const upload = vi.fn().mockResolvedValue({ attachment: { id: 1 } });
    apiUpload.mockImplementation(upload);
    const { result } = renderHook(() => useUploadAttachment(), { wrapper: wrap() });
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    await result.current.mutateAsync({ id: 't_1', file });

    expect(upload.mock.calls[0]![0]).toBe('/api/plugins/kanban/tasks/t_1/attachments');
    const form = upload.mock.calls[0]![1] as FormData;
    expect(form.get('file')).toBe(file);
    /* The endpoint defaults this to `dashboard`. Naming the app is what makes
       an attachment's origin readable next to one an agent added itself. */
    expect(form.get('uploaded_by')).toBe('web');
  });

  /**
   * Download is a link, not a fetch: the endpoint answers with a FileResponse,
   * the proxy adds the token and Access is satisfied by the cookie the browser
   * already holds. Reading a 25 MB file into a phone's memory to hand it back
   * as a blob URL would be strictly worse.
   */
  it('addresses a download by plain same-origin URL, board included', () => {
    expect(attachmentUrl(7)).toBe('/api/plugins/kanban/attachments/7');
    expect(attachmentUrl(7, 'work')).toBe('/api/plugins/kanban/attachments/7?board=work');
  });

  /* The attachment is addressed by its own id, but the *list* it has to be
     removed from is the task's — so the delete needs both, and a mutation that
     only knew the attachment id would leave the row on screen. */
  it('refreshes the task’s list after removing one', async () => {
    apiDel.mockResolvedValue({ ok: true, id: 3 });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);

    const { result } = renderHook(() => useDeleteAttachment(), { wrapper });
    await result.current.mutateAsync({ attachmentId: 3, taskId: 't_1' });

    expect(apiDel.mock.calls[0]![0]).toBe('/api/plugins/kanban/attachments/3');
    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(['kanban', null, 'attachments', 't_1']);
  });

  /* Hermes rejects anything over this with a 413, which reaches the app as a
     bare error some way into a slow upload. The constant exists so the sheet
     can say so before spending a phone's uplink on it. */
  it('knows the server’s size cap', () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});
