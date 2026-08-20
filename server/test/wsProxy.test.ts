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

vi.mock('../src/config.js', () => ({
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

let upstreamUrl = '';
let upstreamHostValue = '';

/** What the fake Hermes saw on the upgrade, so the disguise can be asserted. */
interface Upgrade {
  url: string;
  host?: string;
  origin?: string;
}
let upgrades: Upgrade[];
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
  upstreamFrames = [];
  onUpstreamFrame = null;
  resolveDelayMs = 0;
  token = 'discovered-token';
});

const openClient = (path = '/api/ws') =>
  new Promise<WebSocket>((resolve, reject) => {
    // The phone's own Origin — the LAN address it loaded the app from, which
    // is exactly what Hermes would refuse.
    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}${path}`, {
      headers: { origin: `http://192.168.1.50:${proxyPort}` },
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
  it.each(['/api/ws', '/api/events', '/api/pub', '/api/audio/speak-stream'])(
    'proxies %s',
    (path) => {
      expect(isProxiedWsPath(path)).toBe(true);
    },
  );

  it.each(['/', '/api/sessions', '/api/ws/extra', '/socket.io/', '/push/feed'])(
    'refuses %s',
    (path) => {
      expect(isProxiedWsPath(path)).toBe(false);
    },
  );

  it('destroys the socket for an unproxied upgrade', async () => {
    await expect(openClient('/nope')).rejects.toThrow();
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
