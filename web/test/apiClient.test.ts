/**
 * The REST helper.
 *
 * Almost all of this is error handling. The proxy, Hermes and the SPA fallback
 * all report failure differently, and the difference between a readable
 * sentence and "[object Object]" on a phone screen is decided here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { useUi } from '../src/store/ui';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  useUi.getState().setToken('');
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

const text = (body: string, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { 'content-type': 'text/plain', ...(init.headers ?? {}) } });

describe('requests', () => {
  it('parses a JSON response', async () => {
    fetchMock.mockResolvedValue(json({ sessions: [] }));
    await expect(api.get('/api/sessions')).resolves.toEqual({ sessions: [] });
  });

  it('returns text when the response is not JSON', async () => {
    fetchMock.mockResolvedValue(text('plain body'));
    await expect(api.get('/api/thing')).resolves.toBe('plain body');
  });

  it('returns nothing for a 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.del('/api/sessions/1')).resolves.toBeUndefined();
  });

  it.each([
    ['post', 'POST'],
    ['put', 'PUT'],
    ['patch', 'PATCH'],
  ] as const)('%s sends a JSON body', async (method, verb) => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await api[method]('/api/thing', { a: 1 });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe(verb);
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('omits the body and its content type when there is nothing to send', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await api.post('/api/thing');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  /**
   * `/api/files` takes its target path in the body and rejects a bodyless
   * DELETE with a 422, which no ordinary `del` can satisfy.
   */
  it('can send a body with DELETE', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await api.delBody('/api/files', { path: '/tmp/x' });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('DELETE');
    expect(init.body).toBe('{"path":"/tmp/x"}');
  });

  it('sends a multipart upload without forcing a content type', async () => {
    fetchMock.mockResolvedValue(json({ text: 'transcribed' }));
    const form = new FormData();
    form.set('file', new Blob(['audio']));
    await api.upload('/api/audio/transcribe', form);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.body).toBe(form);
    expect(init.headers).not.toHaveProperty('Content-Type');
  });
});

describe('authorisation', () => {
  /**
   * The proxy adds the upstream Bearer token server-side, so same-origin calls
   * carry no credential from the browser at all.
   */
  it('sends no Authorization header by default', async () => {
    fetchMock.mockResolvedValue(json({}));
    await api.get('/api/sessions');
    expect(fetchMock.mock.calls[0]![1].headers).not.toHaveProperty('Authorization');
  });

  it('forwards an explicitly configured token', async () => {
    useUi.getState().setToken('my-token');
    fetchMock.mockResolvedValue(json({}));
    await api.get('/api/sessions');
    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({
      Authorization: 'Bearer my-token',
    });
  });

  it('lets a per-call header win', async () => {
    useUi.getState().setToken('my-token');
    fetchMock.mockResolvedValue(json({}));
    await api.get('/api/sessions');
    // The raw escape hatch shares the same header assembly.
    await api.raw('/api/audio/speak', { headers: { Authorization: 'Bearer other' } });
    expect(fetchMock.mock.calls[1]![1].headers).toMatchObject({ Authorization: 'Bearer other' });
  });
});

describe('errors', () => {
  it('throws an ApiError carrying the status and body', async () => {
    fetchMock.mockResolvedValue(json({ error: 'not_found' }, { status: 404 }));
    await expect(api.get('/api/nope')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'not_found',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('is an instance of ApiError', async () => {
    fetchMock.mockResolvedValue(json({ error: 'nope' }, { status: 500 }));
    await expect(api.get('/api/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('prefers a string detail', async () => {
    fetchMock.mockResolvedValue(json({ detail: 'Session already running' }, { status: 409 }));
    await expect(api.get('/api/x')).rejects.toThrow('Session already running');
  });

  /**
   * FastAPI reports validation failures as `detail: [{loc, msg}]`, which
   * stringifies to "[object Object]" if handed straight to the UI.
   */
  it('unpacks a FastAPI validation detail into field: message', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          detail: [
            { loc: ['body', 'name'], msg: 'field required' },
            { loc: ['body', 'schedule'], msg: 'invalid cron' },
          ],
        },
        { status: 422 },
      ),
    );
    await expect(api.post('/api/cron/jobs', {})).rejects.toThrow(
      'name: field required; schedule: invalid cron',
    );
  });

  it('handles a validation entry with no location', async () => {
    fetchMock.mockResolvedValue(json({ detail: [{ msg: 'nope' }] }, { status: 422 }));
    await expect(api.post('/api/x', {})).rejects.toThrow('nope');
  });

  it('falls back to a short text body', async () => {
    fetchMock.mockResolvedValue(text('upstream is unreachable', { status: 502 }));
    await expect(api.get('/api/x')).rejects.toThrow('upstream is unreachable');
  });

  /**
   * The SPA fallback answers unknown paths with index.html. Splashing a page
   * of HTML across a toast helps nobody.
   */
  it('does not use a long body as the message', async () => {
    fetchMock.mockResolvedValue(text('x'.repeat(500), { status: 404, statusText: 'Not Found' }));
    await expect(api.get('/api/x')).rejects.toThrow('Not Found');
  });

  it('falls back to the status when there is nothing else', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(api.get('/api/x')).rejects.toThrow(/503|Service Unavailable/);
  });

  it('still reports the status when the error body will not parse', async () => {
    fetchMock.mockResolvedValue(
      new Response('{ broken', { status: 500, headers: { 'content-type': 'application/json' } }),
    );
    await expect(api.get('/api/x')).rejects.toMatchObject({ status: 500 });
  });

  it('propagates a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.get('/api/x')).rejects.toThrow('Failed to fetch');
  });
});
