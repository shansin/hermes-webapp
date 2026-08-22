/**
 * Telling an expired sign-in apart from a dead network.
 *
 * These two produce identical symptoms in the browser — a rejected `fetch` and
 * a WebSocket that closes with 1006 — and the app's response to them is
 * opposite: one needs a trip through Google, the other needs patience. Getting
 * it wrong is not a crash but a lie on screen ("Reconnecting…" for ever), which
 * is why the discrimination is tested rather than assumed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const load = async () => {
  vi.resetModules();
  return import('../src/lib/accessSession');
};

/** A response shaped like the one `redirect: 'manual'` yields at the edge. */
const opaqueRedirect = () =>
  ({ type: 'opaqueredirect', status: 0 }) as unknown as Response;

const ok = () => ({ type: 'basic', status: 200 }) as unknown as Response;

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('probeAccess', () => {
  it('reports expiry when the edge bounces the probe to a login page', async () => {
    const { probeAccess, isAccessExpired } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => opaqueRedirect()));

    await expect(probeAccess()).resolves.toBe(true);
    expect(isAccessExpired()).toBe(true);
  });

  it('probes with redirect:manual, which is the only way to see the bounce', async () => {
    // Following the redirect instead would hit a login page that sends no CORS
    // headers, so `fetch` would reject and there would be nothing to inspect.
    const { probeAccess } = await load();
    const fetchMock = vi.fn(async () => opaqueRedirect());
    vi.stubGlobal('fetch', fetchMock);

    await probeAccess();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/healthz');
    expect((init as RequestInit).redirect).toBe('manual');
  });

  it('does not cry expiry when the network is simply gone', async () => {
    const { probeAccess, isAccessExpired } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    await expect(probeAccess()).resolves.toBe(false);
    expect(isAccessExpired()).toBe(false);
  });

  it('does not cry expiry when the probe succeeds', async () => {
    const { probeAccess, isAccessExpired } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => ok()));

    await expect(probeAccess()).resolves.toBe(false);
    expect(isAccessExpired()).toBe(false);
  });

  it('probes once no matter how many calls fail at the same moment', async () => {
    // A screen full of queries all failing together must not turn into a
    // burst of probes at the edge.
    const { probeAccess } = await load();
    const fetchMock = vi.fn(async () => opaqueRedirect());
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([probeAccess(), probeAccess(), probeAccess(), probeAccess()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops probing once expiry has been established', async () => {
    const { probeAccess } = await load();
    const fetchMock = vi.fn(async () => opaqueRedirect());
    vi.stubGlobal('fetch', fetchMock);

    await probeAccess();
    await probeAccess();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers exactly once', async () => {
    const { probeAccess, onAccessExpired } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => opaqueRedirect()));
    const handler = vi.fn();
    onAccessExpired(handler);

    await probeAccess();
    await probeAccess();

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

/**
 * The third state, and the one the app could not previously name.
 *
 * A client-side DNS failure and a dead backend are identical from script: the
 * probe throws either way. But a probe that throws never reached Cloudflare,
 * and one that returns anything at all did — which is enough to tell the person
 * whether to look at their own network or at Hermes.
 */
describe('host reachability', () => {
  it('stays quiet about a single failure — one throw is a blip', async () => {
    const { probeAccess, isHostUnreachable } = await load();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await probeAccess();
    expect(isHostUnreachable()).toBe(false);
  });

  it('says so once the failures stop looking like a blip', async () => {
    const { probeAccess, isHostUnreachable } = await load();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await probeAccess();
    await probeAccess();
    expect(isHostUnreachable()).toBe(true);
  });

  it('clears itself the moment a probe lands, without waiting to be told', async () => {
    const { probeAccess, isHostUnreachable } = await load();
    let up = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!up) throw new TypeError('Failed to fetch');
        return ok();
      }),
    );

    await probeAccess();
    await probeAccess();
    expect(isHostUnreachable()).toBe(true);

    up = true;
    await probeAccess();
    expect(isHostUnreachable()).toBe(false);
  });

  /**
   * A 401 or a login redirect had to travel to Cloudflare and back to exist, so
   * it is proof the network is fine — the opposite conclusion from a throw,
   * reached from the same failing call.
   */
  it('treats a refusal as proof the path is up, not as a network fault', async () => {
    const { probeAccess, isHostUnreachable, isAccessExpired } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => opaqueRedirect()));

    await probeAccess();
    expect(isAccessExpired()).toBe(true);
    expect(isHostUnreachable()).toBe(false);
  });

  it('does not let a recovered blip accumulate toward the threshold', async () => {
    const { probeAccess, isHostUnreachable } = await load();
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (fail) throw new TypeError('Failed to fetch');
        return ok();
      }),
    );

    await probeAccess(); // one throw
    fail = false;
    await probeAccess(); // recovered — the count must reset
    fail = true;
    await probeAccess(); // one throw again, not two in a row
    expect(isHostUnreachable()).toBe(false);
  });

  /**
   * The probe is not the only thing that learns the network is back, and
   * treating it as though it were is what left the banner up over a working
   * app: probes run from the reconnect path, which stops the moment a socket
   * opens. `ws/client.ts` calls this on every completed handshake.
   */
  it('is cleared by an opened socket, with no probe involved', async () => {
    const { probeAccess, isHostUnreachable, markHostReached } = await load();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await probeAccess();
    await probeAccess();
    expect(isHostUnreachable()).toBe(true);

    markHostReached();
    expect(isHostUnreachable()).toBe(false);
  });

  it('notifies subscribers on each flip, and only on a flip', async () => {
    const { probeAccess, onHostReachabilityChange } = await load();
    const seen: boolean[] = [];
    onHostReachabilityChange((v) => seen.push(v));

    let up = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!up) throw new TypeError('Failed to fetch');
        return ok();
      }),
    );

    await probeAccess();
    await probeAccess();
    await probeAccess(); // still down — must not re-notify
    up = true;
    await probeAccess();

    expect(seen).toEqual([true, false]);
  });
});

describe('markAccessRefused', () => {
  it('believes a 401 without probing', async () => {
    // The trap this exists for: `/healthz` is exempt from the proxy's gate, so
    // probing it after a 401 answers 200 and the app concludes all is well
    // while every real call is being refused. That is what a gated origin
    // reached directly — over Tailscale, carrying no Access assertion — looks
    // like from the browser, and it reconnects for ever.
    const { markAccessRefused, isAccessExpired } = await load();
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);

    markAccessRefused();

    expect(isAccessExpired()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('notifies subscribers once, however many calls refuse', async () => {
    const { markAccessRefused, onAccessExpired } = await load();
    const handler = vi.fn();
    onAccessExpired(handler);

    markAccessRefused();
    markAccessRefused();
    markAccessRefused();

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('the login marker', () => {
  it('survives the service worker by tagging the URL it navigates to', async () => {
    // Without a query the service worker answers the navigation out of the
    // precache and the redirect to Google never happens; `cf_login` is what
    // `navigateFallbackDenylist` matches on.
    const { goToAccessLogin } = await load();
    const assign = vi.fn();
    vi.stubGlobal('window', {
      location: { href: 'https://hermes.shsin.blog/chat?a=1', assign },
      history: { replaceState: vi.fn() },
    });

    goToAccessLogin();

    const target = new URL(assign.mock.calls[0]![0] as string);
    expect(target.pathname).toBe('/chat');
    expect(target.searchParams.get('a')).toBe('1');
    expect(target.searchParams.get('cf_login')).toBeTruthy();
  });

  it('is cleaned out of the address bar on the way back', async () => {
    const { stripLoginMarker } = await load();
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { href: 'https://hermes.shsin.blog/chat?a=1&cf_login=123' },
      history: { replaceState },
    });

    stripLoginMarker();

    expect(replaceState).toHaveBeenCalledWith(null, '', '/chat?a=1');
  });

  it('leaves a clean URL alone rather than rewriting history for nothing', async () => {
    const { stripLoginMarker } = await load();
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { href: 'https://hermes.shsin.blog/chat' },
      history: { replaceState },
    });

    stripLoginMarker();

    expect(replaceState).not.toHaveBeenCalled();
  });
});
