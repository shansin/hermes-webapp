/**
 * The cross-origin check.
 *
 * Both failure directions are invisible until someone is affected: too loose
 * and any page on the LAN drives the agent with nothing in the app to say so;
 * too tight and the phone's writes and gateway socket — the whole app — are
 * refused behind a front nobody thought of. So the supported fronts are pinned
 * here next to the attack.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const cfg = { PUBLIC_URL: undefined as string | undefined, ALLOWED_ORIGINS: '' };
vi.mock('../src/config.js', () => ({ config: cfg }));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { originAllowed, requireSameOrigin } = await import('../src/origin.js');

beforeEach(() => {
  cfg.PUBLIC_URL = undefined;
  cfg.ALLOWED_ORIGINS = '';
});

describe('originAllowed', () => {
  it.each([
    ['the LAN address', 'http://192.168.1.20:3000', '192.168.1.20:3000'],
    // cloudflared forwards the public Host (no httpHostHeader in the tunnel).
    ['the Cloudflare hostname', 'https://hermes.shsin.blog', 'hermes.shsin.blog'],
    ['a Host that spells out the default port', 'https://hermes.shsin.blog', 'hermes.shsin.blog:443'],
    ['the Tailscale name', 'https://studio.tail1234.ts.net', 'studio.tail1234.ts.net'],
    // Vite proxies with changeOrigin: false, so Host stays :5173 too.
    ['the Vite dev server', 'http://localhost:5173', 'localhost:5173'],
    ['a differently-cased Host', 'http://studio.local:3000', 'Studio.Local:3000'],
  ])('admits a page on %s', (_label, origin, host) => {
    expect(originAllowed(origin, host)).toBe(true);
  });

  it.each([
    ['another site', 'https://evil.example', '192.168.1.20:3000'],
    ['another port on this machine', 'http://192.168.1.20:8080', '192.168.1.20:3000'],
    ['an opaque origin', 'null', '192.168.1.20:3000'],
    ['a non-web scheme', 'file://', '192.168.1.20:3000'],
    ['a request with no Host to compare', 'http://192.168.1.20:3000', undefined],
  ])('refuses %s', (_label, origin, host) => {
    expect(originAllowed(origin, host)).toBe(false);
  });

  /* A front that rewrites Host to loopback would otherwise refuse the app. */
  it('admits PUBLIC_URL whatever the Host says', () => {
    cfg.PUBLIC_URL = 'https://studio.tail1234.ts.net';
    expect(originAllowed('https://studio.tail1234.ts.net', '127.0.0.1:3000')).toBe(true);
    expect(originAllowed('http://studio.tail1234.ts.net', '127.0.0.1:3000')).toBe(false);
  });

  it('admits ALLOWED_ORIGINS, and * switches the check off', () => {
    cfg.ALLOWED_ORIGINS = ' https://hem.example.lan , not a url ';
    expect(originAllowed('https://hem.example.lan', '127.0.0.1:3000')).toBe(true);
    expect(originAllowed('https://evil.example', '127.0.0.1:3000')).toBe(false);
    cfg.ALLOWED_ORIGINS = '*';
    expect(originAllowed('null', undefined)).toBe(true);
  });
});

describe('the REST middleware', () => {
  const app = new Hono();
  app.use('*', requireSameOrigin);
  app.all('*', (c) => c.json({ ok: true }));

  const send = (method: string, path: string, headers: Record<string, string>) =>
    app.request(new Request(`http://proxy.test${path}`, { method, headers }));

  it('serves the app’s own write', async () => {
    const res = await send('POST', '/push/feed/read', {
      host: 'hermes.shsin.blog',
      origin: 'https://hermes.shsin.blog',
    });
    expect(res.status).toBe(200);
  });

  it('refuses a cross-site write with 403 and no gate marker', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await send(method, '/api/sessions', { host: '192.168.1.20:3000', origin: 'https://evil.example' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'origin_forbidden' });
      // The Access gate's marker is what the app reads as "signed out".
      expect(res.headers.get('x-hem-gate')).toBeNull();
    }
  });

  /* A cross-origin read gets no CORS grant, so the page cannot see it. */
  it('leaves GETs alone', async () => {
    const res = await send('GET', '/push/feed', { host: '192.168.1.20:3000', origin: 'https://evil.example' });
    expect(res.status).toBe(200);
  });

  /* curl, start.sh, anything that is not a browser page. */
  it('lets a write with no Origin through', async () => {
    expect((await send('POST', '/api/sessions', { host: '192.168.1.20:3000' })).status).toBe(200);
  });

  /* Android posts the share target as a browser-initiated navigation, which
     carries `Origin: null`; the route only redirects into a draft. */
  it('lets the share target through with an opaque origin', async () => {
    expect((await send('POST', '/share', { host: '192.168.1.20:3000', origin: 'null' })).status).toBe(200);
  });
});
