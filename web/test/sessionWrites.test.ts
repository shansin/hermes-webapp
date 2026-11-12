/**
 * Fenced session writes (Hermes ≥ 0.23).
 *
 * Every PATCH/DELETE of a session must carry a `request_id` and the
 * `expected_revision` it was decided against, read from the mutation
 * snapshot; without them Hermes answers 409 `client_upgrade_required`. An
 * older Hermes has no snapshot route (404) and wants the plain write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteSessionFenced,
  deleteSessionsEach,
  patchSession,
  SessionGoneError,
} from '../src/api/sessions';
import { useUi } from '../src/store/ui';

const fetchMock = vi.fn();
type Call = { url: string; method: string; body: unknown };
let calls: Call[];

beforeEach(() => {
  fetchMock.mockReset();
  calls = [];
  vi.stubGlobal('fetch', fetchMock);
  useUi.getState().setToken('');
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answer by route; record every call. */
function serve(handler: (url: URL, method: string, body: unknown) => Response) {
  fetchMock.mockImplementation(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://hem.test');
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: url.pathname + url.search, method, body });
    return handler(url, method, body);
  });
}

const snapshot = (rev: number, gen: number | null = 0, exists = true) =>
  json({ session_id: 's1', exists, runtime_revision: rev, runtime_generation: gen });

describe('patchSession', () => {
  it('sends the revision it read and a fresh request id', async () => {
    serve((url, method) =>
      url.pathname.endsWith('/mutation-snapshot') ? snapshot(4, 2) : json({ ok: true, revision: 5 }),
    );
    await patchSession('s1', { pinned: true });
    const write = calls.find((c) => c.method === 'PATCH')!;
    expect(write.url).toBe('/api/sessions/s1');
    const body = write.body as Record<string, unknown>;
    expect(body).toMatchObject({ pinned: true, expected_revision: 4, expected_generation: 2 });
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reads the snapshot from, and writes to, the session\'s own profile', async () => {
    serve((url) => (url.pathname.endsWith('/mutation-snapshot') ? snapshot(0) : json({ ok: true })));
    await patchSession('s1', { title: 'x' }, 'fitness');
    expect(calls[0]!.url).toBe('/api/sessions/s1/mutation-snapshot?profile=fitness');
    expect(calls[1]!.body).toMatchObject({ title: 'x', profile: 'fitness' });
  });

  it('omits the generation when the snapshot has none', async () => {
    serve((url) => (url.pathname.endsWith('/mutation-snapshot') ? snapshot(1, null) : json({ ok: true })));
    await patchSession('s1', { archived: true });
    expect(calls[1]!.body).not.toHaveProperty('expected_generation');
  });

  it('sends the plain write to a Hermes with no snapshot route', async () => {
    serve((url) => (url.pathname.endsWith('/mutation-snapshot') ? json({ detail: 'Not Found' }, 404) : json({ ok: true })));
    await patchSession('s1', { pinned: false });
    expect(calls[1]!.body).toEqual({ pinned: false });
  });

  it('refuses to write to a session that is gone', async () => {
    serve(() => snapshot(0, null, false));
    await expect(patchSession('s1', { pinned: true })).rejects.toBeInstanceOf(SessionGoneError);
    expect(calls).toHaveLength(1);
  });

  it('surfaces a revision conflict instead of retrying with a newer revision', async () => {
    serve((url) =>
      url.pathname.endsWith('/mutation-snapshot') ? snapshot(1) : json({ detail: 'revision_conflict' }, 409),
    );
    await expect(patchSession('s1', { pinned: true })).rejects.toThrow('revision_conflict');
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });
});

describe('deleteSessionFenced', () => {
  it('puts the identity in the query', async () => {
    serve((url) => (url.pathname.endsWith('/mutation-snapshot') ? snapshot(3, 1) : json({ ok: true })));
    await deleteSessionFenced('s1', 'default');
    const del = calls.find((c) => c.method === 'DELETE')!;
    const q = new URL(del.url, 'http://x').searchParams;
    expect(q.get('profile')).toBe('default');
    expect(q.get('expected_revision')).toBe('3');
    expect(q.get('expected_generation')).toBe('1');
    expect(q.get('request_id')).toBeTruthy();
  });

  it('treats an already-absent session as deleted', async () => {
    serve(() => snapshot(0, null, false));
    await expect(deleteSessionFenced('s1')).resolves.toMatchObject({ already_absent: true });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('deleteSessionsEach', () => {
  it('deletes what it can and reports the rest', async () => {
    serve((url, method) => {
      if (url.pathname.endsWith('/mutation-snapshot')) return snapshot(0);
      if (method === 'DELETE' && url.pathname === '/api/sessions/bad') return json({ detail: 'session_busy' }, 409);
      return json({ ok: true });
    });
    const res = await deleteSessionsEach(['a', 'bad', 'c']);
    expect(res.deleted.sort()).toEqual(['a', 'c']);
    expect(res.failed).toEqual([{ id: 'bad', reason: 'session_busy' }]);
  });
});
