/**
 * The `/api/*` passthrough.
 *
 * Two things here are load-bearing and neither is visible in a happy-path
 * response: the Host header is rewritten so Hermes' anti-DNS-rebinding guard
 * accepts a request that arrived on a LAN address, and the Bearer token is
 * added server-side so the phone never holds a credential.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let configuredToken = '';
const clearToken = vi.fn();
const resolveToken = vi.fn(async () => 'resolved-token');
let currentToken = 'live-token';

vi.mock('../src/config.js', () => ({
  get config() {
    return { HERMES_TOKEN: configuredToken };
  },
  getToken: () => currentToken,
  clearToken,
  resolveToken: () => resolveToken(),
  upstreamHttp: 'http://127.0.0.1:9119',
  upstreamHost: '127.0.0.1:9119',
}));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { apiProxy } = await import('../src/routers/apiProxy.js');

const fetchMock = vi.fn();

/** The request the proxy made upstream. */
const upstreamCall = () => {
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url: url as string, init: init as RequestInit, headers: (init as RequestInit).headers as Headers };
};

const send = (path: string, init: RequestInit = {}) =>
  apiProxy.request(new Request(`http://192.168.1.50:3000${path}`, init));

beforeEach(() => {
  fetchMock.mockReset();
  clearToken.mockClear();
  resolveToken.mockClear();
  currentToken = 'live-token';
  configuredToken = '';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
});

describe('forwarding', () => {
  it('preserves the path and query', async () => {
    await send('/api/sessions?limit=20&q=hello');
    expect(upstreamCall().url).toBe('http://127.0.0.1:9119/api/sessions?limit=20&q=hello');
  });

  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('carries the %s method through', async (method) => {
    await send('/api/thing', { method, body: method === 'GET' ? undefined : '{}' });
    expect(upstreamCall().init.method).toBe(method);
  });

  it('relays the upstream status and body', async () => {
    fetchMock.mockResolvedValue(new Response('{"detail":"nope"}', { status: 422 }));
    const res = await send('/api/thing');
    expect(res.status).toBe(422);
    expect(await res.text()).toBe('{"detail":"nope"}');
  });

  it('sends no body on a GET', async () => {
    await send('/api/sessions');
    expect(upstreamCall().init.body).toBeUndefined();
  });

  /** Audio uploads and file downloads must not buffer in memory. */
  it('streams a request body rather than reading it', async () => {
    await send('/api/audio/transcribe', { method: 'POST', body: 'payload' });
    const { init } = upstreamCall();
    expect((init as { duplex?: string }).duplex).toBe('half');
  });

  it('does not follow a redirect on the client’s behalf', async () => {
    await send('/api/thing');
    expect(upstreamCall().init.redirect).toBe('manual');
  });
});

describe('the loopback disguise', () => {
  /**
   * Hermes validates Host against the interface it bound. A request arriving
   * as `Host: 192.168.1.50:3000` is rejected outright — which is every request
   * a phone makes.
   */
  it('always presents the upstream as loopback', async () => {
    await send('/api/sessions', { headers: { host: '192.168.1.50:3000' } });
    expect(upstreamCall().headers.get('host')).toBe('127.0.0.1:9119');
  });

  it('passes ordinary headers through', async () => {
    await send('/api/sessions', { headers: { 'x-request-id': 'abc', accept: 'application/json' } });
    const { headers } = upstreamCall();
    expect(headers.get('x-request-id')).toBe('abc');
    expect(headers.get('accept')).toBe('application/json');
  });

  /** Hop-by-hop headers belong to one connection and must not be relayed. */
  it.each(['connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authorization'])(
    'strips the hop-by-hop header %s',
    async (name) => {
      await send('/api/sessions', { headers: { [name]: 'something' } });
      expect(upstreamCall().headers.has(name)).toBe(false);
    },
  );

  it('strips hop-by-hop headers from the response too', async () => {
    fetchMock.mockResolvedValue(
      new Response('ok', {
        status: 200,
        headers: { connection: 'close', 'content-encoding': 'gzip', 'x-hermes': 'keep' },
      }),
    );
    const res = await send('/api/thing');
    expect(res.headers.has('connection')).toBe(false);
    expect(res.headers.has('content-encoding')).toBe(false);
    expect(res.headers.get('x-hermes')).toBe('keep');
  });
});

describe('auth injection', () => {
  it('adds the proxy’s token', async () => {
    await send('/api/sessions');
    expect(upstreamCall().headers.get('authorization')).toBe('Bearer live-token');
  });

  /**
   * The phone never sees the dashboard session token, so anything it sends
   * under that header is either stale or someone else's.
   */
  it('replaces whatever the client sent', async () => {
    await send('/api/sessions', { headers: { authorization: 'Bearer from-the-browser' } });
    expect(upstreamCall().headers.get('authorization')).toBe('Bearer live-token');
  });

  it('discovers a token when it does not have one yet', async () => {
    currentToken = '';
    await send('/api/sessions');
    expect(resolveToken).toHaveBeenCalled();
    expect(upstreamCall().headers.get('authorization')).toBe('Bearer resolved-token');
  });

  it('sends no header when there is no token at all', async () => {
    currentToken = '';
    resolveToken.mockResolvedValueOnce('');
    await send('/api/sessions');
    expect(upstreamCall().headers.has('authorization')).toBe(false);
  });
});

describe('a stale scraped token', () => {
  /**
   * A 401 almost always means a scraped token went stale because the backend
   * restarted. Dropping it makes the next request re-discover instead of
   * failing forever.
   */
  it('is dropped on a 401', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const res = await send('/api/sessions');
    expect(res.status).toBe(401);
    expect(clearToken).toHaveBeenCalled();
  });

  /** An explicitly configured token is not guesswork; re-scraping is worse. */
  it('is kept when it was configured explicitly', async () => {
    configuredToken = 'from-dot-env';
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    await send('/api/sessions');
    expect(clearToken).not.toHaveBeenCalled();
  });

  it('is kept on any other status', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    await send('/api/sessions');
    expect(clearToken).not.toHaveBeenCalled();
  });
});

describe('an unreachable backend', () => {
  it('answers 502 with something a person can act on', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await send('/api/sessions');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('upstream_unreachable');
    expect(body.detail).toContain('127.0.0.1:9119');
  });

  it('does not leak the underlying error to the client', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9119'));
    const body = await (await send('/api/sessions')).text();
    expect(body).not.toContain('ECONNREFUSED');
  });
});

describe('scope', () => {
  it('does not claim paths outside /api', async () => {
    const res = await apiProxy.request('http://proxy.test/push/config');
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
