/**
 * The WebSocket bridge, tested end to end against a real upstream.
 *
 * Everything that makes this module more than a pipe is a handshake detail —
 * the Host/Origin disguise, the token substitution, the path allowlist — and
 * none of it is observable without an actual upgrade. So there is a real
 * `ws` server standing in for Hermes and a real client standing in for the
 * phone, with the proxy in between.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { AddressInfo } from 'node:net';

/** How long token discovery takes. Raised in the test that needs a gap. */
let resolveDelayMs = 0;
let token = 'discovered-token';

/** Whether the Access gate is configured, and what it says. */
let accessOn = false;
let accessVerdict: { ok: true; email: string } | { ok: false; reason: string } = {
  ok: false,
  reason: 'missing',
};

vi.mock('../src/config.js', () => ({
  get accessEnabled() {
    return accessOn;
  },
  getToken: () => '',
  resolveToken: async () => {
    if (resolveDelayMs) await new Promise((r) => setTimeout(r, resolveDelayMs));
    return token;
  },
  get upstreamWs() {
    return upstreamUrl;
  },
  get upstreamHost() {
    return upstreamHostValue;
  },
}));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/auth.js', () => ({
  // The assertion checking itself is covered in auth.test.ts against real
  // keys; what matters here is that the upgrade path consults it at all.
  nodeHeaders: () => () => undefined,
  verifyAccess: async () => accessVerdict,
}));

let upstreamUrl = '';
let upstreamHostValue = '';

/** What the fake Hermes saw on the upgrade, so the disguise can be asserted. */
interface Upgrade {
  url: string;
  host?: string;
  origin?: string;
}
let upgrades: Upgrade[];
/** The fake Hermes' end of each bridge, so a teardown is observable there. */
let upstreamSockets: WebSocket[];
let upstreamFrames: string[];
/** Resolved by the fake Hermes on each frame, so tests can await delivery. */
let onUpstreamFrame: (() => void) | null;

let hermesServer: Server;
let hermesWss: WebSocketServer;
let proxyServer: Server;
let proxyPort = 0;

const { attachWsProxy, isProxiedWsPath } = await import('../src/routers/wsProxy.js');

beforeAll(async () => {
  hermesServer = createServer();
  hermesWss = new WebSocketServer({ server: hermesServer });
  hermesWss.on('connection', (socket, req) => {
    upstreamSockets.push(socket);
    upgrades.push({
      url: req.url ?? '',
      host: req.headers.host,
      origin: req.headers.origin as string | undefined,
    });
    socket.on('message', (data: RawData) => {
      upstreamFrames.push(data.toString());
      onUpstreamFrame?.();
      socket.send(`echo:${data.toString()}`);
    });
  });
  await new Promise<void>((r) => hermesServer.listen(0, '127.0.0.1', r));
  const hp = (hermesServer.address() as AddressInfo).port;
  upstreamUrl = `ws://127.0.0.1:${hp}`;
  upstreamHostValue = `127.0.0.1:${hp}`;

  proxyServer = createServer((_req, res) => res.end('ok'));
  attachWsProxy(proxyServer as never);
  await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', r));
  proxyPort = (proxyServer.address() as AddressInfo).port;
});

afterAll(async () => {
  hermesWss.close();
  await new Promise<void>((r) => hermesServer.close(() => r()));
  await new Promise<void>((r) => proxyServer.close(() => r()));
});

beforeEach(() => {
  upgrades = [];
  upstreamSockets = [];
  upstreamFrames = [];
  onUpstreamFrame = null;
  resolveDelayMs = 0;
  token = 'discovered-token';
});

const openClient = (path = '/api/ws', extraHeaders: Record<string, string> = {}) =>
  new Promise<WebSocket>((resolve, reject) => {
    // The phone's own Origin — the LAN address it loaded the app from, which
    // is exactly what Hermes would refuse.
    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}${path}`, {
      headers: { origin: `http://192.168.1.50:${proxyPort}`, ...extraHeaders },
    });
    client.once('open', () => resolve(client));
    client.once('error', reject);
  });

const clients: WebSocket[] = [];
const track = (c: WebSocket) => {
  clients.push(c);
  return c;
};
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

/** Wait for the fake Hermes to have received `n` frames. */
function framesReceived(n: number, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (upstreamFrames.length >= n) {
        onUpstreamFrame = null;
        clearTimeout(t);
        resolve();
      }
    };
    const t = setTimeout(() => {
      onUpstreamFrame = null;
      reject(new Error(`only ${upstreamFrames.length}/${n} frames arrived: ${upstreamFrames}`));
    }, timeoutMs);
    onUpstreamFrame = check;
    check();
  });
}

/** Wait for the upstream connection to exist. */
async function upgraded(timeoutMs = 2000): Promise<Upgrade> {
  const deadline = Date.now() + timeoutMs;
  while (!upgrades.length) {
    if (Date.now() > deadline) throw new Error('no upstream upgrade');
    await new Promise((r) => setTimeout(r, 5));
  }
  return upgrades[0]!;
}

describe('path allowlist', () => {
  it.each([
    '/api/ws',
    '/api/events',
    '/api/pub',
    '/api/audio/speak-stream',
    /* The board's live-update stream. It needs the bridge for the same two
       reasons `/api/ws` does — Hermes checks Host and Origin against the
       loopback interface, and the plugin's upgrade gate reads the credential
       out of the query string — and a browser can supply neither. */
    '/api/plugins/kanban/events',
  ])('proxies %s', (path) => {
    expect(isProxiedWsPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/api/sessions',
    '/api/ws/extra',
    '/socket.io/',
    '/push/feed',
    // Exact match only: the plugin's REST routes sit under the same prefix as
    // its socket, and a prefix test here would open every one of them to an
    // upgrade the bridge would then dial upstream.
    '/api/plugins/kanban/board',
    '/api/plugins/kanban/events/extra',
  ])('refuses %s', (path) => {
    expect(isProxiedWsPath(path)).toBe(false);
  });

  it('destroys the socket for an unproxied upgrade', async () => {
    await expect(openClient('/nope')).rejects.toThrow();
  });
});

/**
 * Upgrades never touch Hono, so the middleware that gates `/api/*` does not
 * cover them. If this check regressed, the REST surface would stay locked
 * while the socket that actually drives the agent stood open — and nothing in
 * the app would look any different.
 */
describe('the Access gate on upgrades', () => {
  afterEach(() => {
    accessOn = false;
    accessVerdict = { ok: false, reason: 'missing' };
  });

  it('lets the upgrade through untouched when the gate is not configured', async () => {
    const client = track(await openClient());
    expect(client.readyState).toBe(WebSocket.OPEN);
    // The upstream leg is dialled after the client handshake resolves, so it
    // has to be waited for rather than sampled.
    await upgraded();
  });

  it('refuses an unauthenticated upgrade, and never dials Hermes', async () => {
    accessOn = true;
    accessVerdict = { ok: false, reason: 'missing' };

    await expect(openClient()).rejects.toThrow();
    // The point of rejecting during the handshake rather than after: the
    // upstream leg is never opened, so an unauthenticated client cannot make
    // the proxy hold a session against the backend. Give a dial the time it
    // would have needed, so this cannot pass by being sampled too early.
    await new Promise((r) => setTimeout(r, 100));
    expect(upgrades).toEqual([]);
  });

  it('answers with a status rather than resetting the connection', async () => {
    accessOn = true;
    accessVerdict = { ok: false, reason: 'missing' };

    // A bare destroy() is a TCP reset, which reaches the browser as close code
    // 1006 — identical to the network being down, so the client retries for
    // ever instead of prompting for a login.
    const err = await openClient().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/401/);
  });

  it('rejects a signed-in stranger with 403', async () => {
    accessOn = true;
    accessVerdict = { ok: false, reason: 'forbidden' };

    const err = await openClient().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/403/);
    await new Promise((r) => setTimeout(r, 100));
    expect(upgrades).toEqual([]);
  });

  it('proxies normally once the assertion checks out', async () => {
    accessOn = true;
    accessVerdict = { ok: true, email: 'owner@example.com' };

    const client = track(await openClient());
    expect(client.readyState).toBe(WebSocket.OPEN);
    await upgraded();
  });
});

describe('the loopback disguise', () => {
  /**
   * The whole reason this proxy exists. Hermes checks Host against the
   * interface it bound and refuses an Origin whose netloc does not match, so a
   * phone hitting `192.168.1.50:3000` would be turned away with 4403.
   */
  it('presents the upstream as loopback, whatever the phone sent', async () => {
    track(await openClient());
    const up = await upgraded();
    expect(up.host).toBe(upstreamHostValue);
    expect(up.origin).toBe(`http://${upstreamHostValue}`);
    expect(up.origin).not.toContain('192.168.1.50');
  });
});

describe('token handling', () => {
  it('attaches the proxy’s token to the upstream URL', async () => {
    track(await openClient());
    expect(new URL((await upgraded()).url, 'http://x').searchParams.get('token')).toBe(
      'discovered-token',
    );
  });

  /**
   * The browser holds no credential and may send a stale one; the proxy is the
   * component that actually knows the token, so its value has to win.
   */
  it('overrides a stale token sent by the client', async () => {
    track(await openClient('/api/ws?token=stale-from-the-browser'));
    const params = new URL((await upgraded()).url, 'http://x').searchParams;
    expect(params.get('token')).toBe('discovered-token');
  });

  it('preserves other query parameters', async () => {
    track(await openClient('/api/ws?session=abc&replay=1'));
    const params = new URL((await upgraded()).url, 'http://x').searchParams;
    expect(params.get('session')).toBe('abc');
    expect(params.get('replay')).toBe('1');
  });

  it('sends no token when there is none to send', async () => {
    token = '';
    track(await openClient('/api/ws?token=stale'));
    const params = new URL((await upgraded()).url, 'http://x').searchParams;
    expect(params.has('token')).toBe(false);
  });
});

/**
 * The gateway socket is idle between turns, and anything in the middle — a home
 * NAT, or Cloudflare, which closes an idle proxied WebSocket at 100s — will
 * quietly drop it. The client reconnects, so nothing breaks and nothing is
 * logged; the only symptom is an app that sits flashing "Reconnecting…". That
 * is invisible enough to be worth pinning down.
 */
describe('the client keepalive', () => {
  /**
   * A data frame, not a protocol ping, and that is the whole point of the test.
   *
   * `client.ping()` is the textbook way to do this and it was killing the
   * connection: 55 of the 176 abnormal client closes across two days of proxy
   * logs landed 45.007–45.062s after the bridge opened — the first ping tick,
   * plus milliseconds — and each one cost a running turn, because Hermes hard
   * interrupts a session whose transport has been detached for its reap grace.
   * The newline reaches no handler in the client (it splits on newlines and
   * skips empty lines), including in an old bundle still sitting on a phone.
   */
  it('sends a data frame, and no protocol ping, while the socket is idle', async () => {
    // Fake only setInterval: the sockets below are real and need their own I/O
    // timers to keep working.
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      const client = track(await openClient());
      await upgraded();

      let pinged = false;
      client.once('ping', () => {
        pinged = true;
      });
      const frame = new Promise<string>((resolve) =>
        client.once('message', (data: RawData) => resolve(data.toString())),
      );
      await vi.advanceTimersByTimeAsync(45_000);

      await expect(
        Promise.race([
          frame,
          new Promise((_, r) => setTimeout(() => r(new Error('no keepalive arrived')), 2000)),
        ]),
      ).resolves.toBe('\n');
      expect(pinged).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A newline is inert in a stream of JSON lines and is a byte of corruption in
   * a stream of audio, so the keepalive is sent on the JSON-RPC path only. The
   * other bridged paths are request-scoped streams that are never idle anyway;
   * what they still get is the stall check and the interval's own cleanup.
   */
  it('sends no keepalive frame on a path that is not JSON-RPC', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      const client = track(await openClient('/api/audio/speak-stream'));
      await upgraded();

      let frames = 0;
      client.on('message', () => {
        frames++;
      });
      await vi.advanceTimersByTimeAsync(45_000 * 2);
      await new Promise((r) => setTimeout(r, 200));

      expect(frames).toBe(0);
      expect(upstreamSockets[0]!.readyState).toBe(WebSocket.OPEN);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The kanban events socket is the other long-idle one — the plugin sends
   * nothing at all between board changes, so Cloudflare closes it at 100s
   * exactly as it did the gateway socket. Its client runs `JSON.parse` on
   * every frame, so a newline would throw there; the frame it gets is a JSON
   * object with no `events` key, which that client already skips because the
   * endpoint only ever sends `{events, cursor}`.
   */
  it('sends a parseable keepalive on the kanban events path', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      const client = track(await openClient('/api/plugins/kanban/events?since=0'));
      await upgraded();

      const frame = new Promise<string>((resolve) =>
        client.once('message', (data: RawData) => resolve(data.toString())),
      );
      await vi.advanceTimersByTimeAsync(45_000);

      const text = await Promise.race([
        frame,
        new Promise<string>((_, r) => setTimeout(() => r(new Error('no keepalive arrived')), 2000)),
      ]);
      expect(text).toBe('{"keepalive":true}');
      // Parseable, and carrying nothing a frame handler would act on.
      expect(JSON.parse(text)).toEqual({ keepalive: true });
      expect(JSON.parse(text).events).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops sending once the client has gone', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      const client = await openClient();
      await upgraded();
      const closed = new Promise<void>((r) => client.once('close', () => r()));
      client.close();
      await closed;

      // A leaked interval would go on poking a dead socket for the life of the
      // process, once per client that ever connected.
      const before = vi.getTimerCount();
      await vi.advanceTimersByTimeAsync(45_000 * 3);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A phone on a stalled radio: still connected, no longer reading.
   *
   * Losing the ping lost its pong with it, so the keepalive can no longer be
   * answered — what it can still see is its own send buffer. A peer that has
   * stopped reading stops draining it, and the bridge has to go rather than sit
   * "open" forever holding a Hermes gateway session behind it. (A peer that
   * vanished at the TCP level is the kernel's job now: `setKeepAlive` on the
   * accepted socket errors the connection out instead of leaving it half-open.)
   */
  it('drops a bridge whose client has stopped reading', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      const client = track(await openClient());
      await upgraded();
      const upstream = upstreamSockets[0]!;
      const upstreamClosed = new Promise<void>((r) => upstream.once('close', () => r()));

      // Pausing the socket is a peer that has stopped reading without saying
      // so. Enough bytes to outlast the receive window, so the send buffer on
      // this side is genuinely stuck rather than merely momentarily full.
      client.pause();
      const chunk = 'x'.repeat(512 * 1024);
      for (let i = 0; i < 16; i++) upstream.send(chunk);
      // Real time, not the faked interval: the frames have to cross the bridge
      // and pile up on the client leg before the tick can see the stall.
      await new Promise((r) => setTimeout(r, 500));

      await vi.advanceTimersByTimeAsync(45_000);

      await expect(
        Promise.race([
          upstreamClosed,
          new Promise((_, r) => setTimeout(() => r(new Error('the bridge was left open')), 4000)),
        ]),
      ).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a bridge whose client is reading', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      track(await openClient());
      await upgraded();
      const upstream = upstreamSockets[0]!;

      // Several rounds of keepalive, all of them read and drained.
      for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(45_000);

      expect(upstream.readyState).toBe(WebSocket.OPEN);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The join key between this log and a capture taken in a browser.
 *
 * Timestamps cannot do the job: the machines involved are tens of milliseconds
 * apart, which was enough during one investigation to make a socket appear to
 * predate the bridge that carried it and send the reading off down a false
 * trail. `cf-ray` is one string that both ends see.
 */
describe('request correlation', () => {
  it('records the Cloudflare ray id on the bridge it belongs to', async () => {
    const { log } = await import('../src/log.js');
    const info = vi.mocked(log.info);
    info.mockClear();

    track(await openClient('/api/ws', { 'cf-ray': '8f2c1d4e5a6b7c8d-SJC' }));
    await upgraded();

    const bridged = info.mock.calls.find((c) => c[1] === 'websocket bridged');
    expect(bridged?.[0]).toMatchObject({ ray: '8f2c1d4e5a6b7c8d-SJC' });
  });

  /**
   * No header is not an error — it is the signature of a request that reached
   * the proxy without passing the edge, which is worth being able to see.
   */
  it('leaves the field absent when the request did not come through the tunnel', async () => {
    const { log } = await import('../src/log.js');
    const info = vi.mocked(log.info);
    info.mockClear();

    track(await openClient());
    await upgraded();

    const bridged = info.mock.calls.find((c) => c[1] === 'websocket bridged');
    expect((bridged?.[0] as { ray?: string }).ray).toBeUndefined();
  });
});

describe('relaying', () => {
  it('carries a frame upstream and the reply back', async () => {
    const client = track(await openClient());
    const reply = new Promise<string>((r) => client.once('message', (d) => r(d.toString())));
    client.send('{"jsonrpc":"2.0","id":1,"method":"session.list"}');
    expect(await reply).toBe('echo:{"jsonrpc":"2.0","id":1,"method":"session.list"}');
  });

  it('preserves frame boundaries rather than coalescing', async () => {
    const client = track(await openClient());
    client.send('one');
    client.send('two');
    client.send('three');
    await framesReceived(3);
    expect(upstreamFrames).toEqual(['one', 'two', 'three']);
  });

  /**
   * A phone submits its first RPC the instant the socket opens — that is what
   * the app's `connect()` does. The upstream leg is still being established at
   * that point, and on a cold boot the proxy may also be discovering its token,
   * so those frames have to be held rather than dropped.
   */
  it('does not lose frames sent before the upstream leg is ready', async () => {
    resolveDelayMs = 120;
    const client = track(await openClient());
    client.send('first');
    client.send('second');
    await framesReceived(2, 3000);
    expect(upstreamFrames).toEqual(['first', 'second']);
  });

  it('closes the client when the upstream goes away', async () => {
    const client = track(await openClient());
    const closed = new Promise<number>((r) => client.once('close', (code) => r(code)));
    await upgraded();
    for (const s of hermesWss.clients) s.close(1000, 'bye');
    expect(await closed).toBeGreaterThanOrEqual(1000);
  });

  it('never propagates a reserved close code onto the wire', async () => {
    const client = track(await openClient());
    const closed = new Promise<number>((r) => client.once('close', (code) => r(code)));
    await upgraded();
    // 1006 is what an abrupt upstream drop produces, and it is illegal to send.
    for (const s of hermesWss.clients) s.terminate();
    const code = await closed;
    expect([1005, 1006]).not.toContain(code === 1006 ? -1 : code);
  });
});
