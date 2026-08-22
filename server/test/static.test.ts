/**
 * Static asset serving — the part of the proxy a phone touches on every cold
 * load, and the only place in this codebase that turns a URL into a filesystem
 * path.
 *
 * `WEB_DIST` is set before the module is imported, because `webDist` is
 * resolved once at module scope. Every test therefore runs against a fixture
 * dist rather than whatever `pnpm build` last produced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dist: string;
let staticRouter: typeof import('../src/static.js')['staticRouter'];
let initStatic: typeof import('../src/static.js')['initStatic'];
let hasBuiltWeb: typeof import('../src/static.js')['hasBuiltWeb'];

/** ~4 KB, past `MIN_COMPRESS_BYTES` and compressible enough to be obvious. */
const BIG_JS = `console.log(${JSON.stringify('x'.repeat(4096))});\n`;

const get = (path: string, headers: Record<string, string> = {}) =>
  staticRouter.request(new Request(`http://proxy.test${path}`, { headers }));

let webBuildId: typeof import('../src/static.js').webBuildId;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'hermes-dist-'));
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Hermes</title>');
  await writeFile(join(dist, 'assets', 'index-abc123.js'), BIG_JS);
  await writeFile(join(dist, 'assets', 'tiny-def456.js'), 'export{}');
  await writeFile(join(dist, 'icon-192.png'), Buffer.alloc(2048, 7));
  await writeFile(join(dist, 'sw.js'), 'self.addEventListener("push",()=>{});');
  await writeFile(join(dist, 'manifest.webmanifest'), JSON.stringify({ name: 'Hermes' }));
  await mkdir(join(dist, 'nested'), { recursive: true });
  await writeFile(join(dist, 'nested', 'deep.txt'), 'deep');

  process.env.WEB_DIST = dist;
  const mod = await import('../src/static.js');
  staticRouter = mod.staticRouter;
  initStatic = mod.initStatic;
  hasBuiltWeb = mod.hasBuiltWeb;
  webBuildId = mod.webBuildId;
  await initStatic();
});

afterAll(async () => {
  await rm(dist, { recursive: true, force: true });
});

describe('manifest', () => {
  it('reports a built web app once index.html is indexed', () => {
    expect(hasBuiltWeb()).toBe(true);
  });

  it('serves nested files', async () => {
    const res = await get('/nested/deep.txt');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('deep');
  });
});

describe('content types', () => {
  it.each([
    ['/index.html', 'text/html; charset=utf-8'],
    ['/assets/index-abc123.js', 'text/javascript; charset=utf-8'],
    ['/icon-192.png', 'image/png'],
    ['/manifest.webmanifest', 'application/manifest+json'],
  ])('%s is served as %s', async (path, type) => {
    const res = await get(path);
    expect(res.headers.get('content-type')).toBe(type);
  });
});

describe('caching', () => {
  it('marks hashed assets immutable', async () => {
    const res = await get('/assets/index-abc123.js');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('forces revalidation of the shell and the service worker', async () => {
    for (const path of ['/index.html', '/sw.js', '/manifest.webmanifest']) {
      const res = await get(path);
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
    }
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const first = await get('/index.html');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await get('/index.html', { 'if-none-match': etag! });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it('honours an If-None-Match list containing the tag', async () => {
    const etag = (await get('/index.html')).headers.get('etag')!;
    const res = await get('/index.html', { 'if-none-match': `W/"other", ${etag}` });
    expect(res.status).toBe(304);
  });

  /**
   * An ETag names a representation, not a file. Handing a brotli body out
   * under the identity body's tag would let any shared cache serve compressed
   * bytes to a client that never asked for them.
   */
  it('varies the ETag by content encoding', async () => {
    const plain = (await get('/assets/index-abc123.js')).headers.get('etag');
    const brotli = (
      await get('/assets/index-abc123.js', { 'accept-encoding': 'br' })
    ).headers.get('etag');
    expect(plain).not.toBe(brotli);
  });

  it('does not answer 304 across encodings', async () => {
    const plainTag = (await get('/assets/index-abc123.js')).headers.get('etag')!;
    const res = await get('/assets/index-abc123.js', {
      'accept-encoding': 'br',
      'if-none-match': plainTag,
    });
    expect(res.status).toBe(200);
  });
});

describe('compression', () => {
  it('prefers brotli and round-trips', async () => {
    const res = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(res.headers.get('content-encoding')).toBe('br');
    const body = Buffer.from(await res.arrayBuffer());
    expect(brotliDecompressSync(body).toString()).toBe(BIG_JS);
  });

  it('falls back to gzip when brotli is not offered', async () => {
    const res = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip' });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const body = Buffer.from(await res.arrayBuffer());
    expect(gunzipSync(body).toString()).toBe(BIG_JS);
  });

  it('sends identity bytes when nothing is accepted', async () => {
    const res = await get('/assets/index-abc123.js');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe(BIG_JS);
  });

  it('leaves already-compressed formats alone', async () => {
    const res = await get('/icon-192.png', { 'accept-encoding': 'br' });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
  });

  it('skips files below the framing-overhead threshold', async () => {
    const res = await get('/assets/tiny-def456.js', { 'accept-encoding': 'br' });
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('advertises Vary: Accept-Encoding on compressible assets', async () => {
    const res = await get('/assets/index-abc123.js');
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
  });

  it('sets a Content-Length matching the compressed body', async () => {
    const res = await get('/assets/index-abc123.js', { 'accept-encoding': 'br' });
    const body = Buffer.from(await res.arrayBuffer());
    expect(res.headers.get('content-length')).toBe(String(body.length));
  });
});

describe('SPA fallback', () => {
  it('serves the shell for a client-side route', async () => {
    const res = await get('/kanban');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('Hermes');
  });

  it('serves the shell for a deep client-side route', async () => {
    const res = await get('/chat/whatever/deeper');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Hermes');
  });

  /**
   * The one thing the fallback must never do. An /api call that reached the
   * static handler has already missed the proxy router, and answering it with
   * index.html turns a routing bug into a JSON parse error three layers away.
   */
  it('never answers an API path with the shell', async () => {
    const res = await get('/api/sessions');
    expect(res.status).toBe(404);
  });

  it('never answers /healthz with the shell', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(404);
  });
});

/**
 * The stamp exists so a person can compare what the server serves against what
 * their browser is running. Both failure modes below are ordinary — a dist
 * built before the stamp existed, or a half-written file — and neither may take
 * the settings screen down with it.
 */
describe('the build stamp', () => {
  it('reports the id the build wrote', async () => {
    await writeFile(join(dist, 'build.json'), JSON.stringify({ id: '2026-08-22 17:04Z abc1234' }));
    expect(webBuildId()).toBe('2026-08-22 17:04Z abc1234');
  });

  it('reports nothing rather than throwing when the file is absent', async () => {
    await rm(join(dist, 'build.json'), { force: true });
    expect(webBuildId()).toBeNull();
  });

  it('survives a file that is not the shape it expects', async () => {
    await writeFile(join(dist, 'build.json'), '{ this is not json');
    expect(webBuildId()).toBeNull();
    await writeFile(join(dist, 'build.json'), JSON.stringify({ id: 42 }));
    expect(webBuildId()).toBeNull();
  });

  /**
   * `SKIP_BUILD=1` in the systemd unit means a rebuild happens without
   * restarting this process, so a value cached at boot would be stale exactly
   * when someone is checking whether their deploy landed.
   */
  it('picks up a rebuild that happened without a restart', async () => {
    await writeFile(join(dist, 'build.json'), JSON.stringify({ id: 'first' }));
    expect(webBuildId()).toBe('first');
    await writeFile(join(dist, 'build.json'), JSON.stringify({ id: 'second' }));
    expect(webBuildId()).toBe('second');
  });
});

describe('path traversal', () => {
  it.each([
    '/../package.json',
    '/../../.env',
    '/assets/../../.env',
    '/%2e%2e/%2e%2e/.env',
    '/..%2f..%2f.env',
    '/./../../.env',
  ])('refuses to escape the dist root via %s', async (path) => {
    const res = await get(path);
    // Either the shell (an unknown SPA route) or a 404 — never file contents.
    const body = await res.text();
    expect(body).not.toContain('HERMES_TOKEN');
    expect(body).not.toContain('"name": "hermes-webapp"');
  });

  it('does not serve a directory as a file', async () => {
    const res = await get('/assets');
    // Falls through to the SPA shell rather than erroring on a directory read.
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });
});

describe('revalidation of mutable files', () => {
  /**
   * A rebuild rewrites index.html in place while the server is running. If the
   * boot-time manifest were trusted for it, an installed phone would keep
   * getting the old shell — and the old shell points at asset hashes that no
   * longer exist.
   */
  it('picks up a rewritten index.html without a restart', async () => {
    const before = await get('/index.html');
    const beforeTag = before.headers.get('etag');

    await writeFile(join(dist, 'index.html'), '<!doctype html><title>Hermes v2</title>');
    const future = new Date(Date.now() + 2000);
    await utimes(join(dist, 'index.html'), future, future);

    const after = await get('/index.html');
    expect(await after.text()).toContain('Hermes v2');
    expect(after.headers.get('etag')).not.toBe(beforeTag);
  });

  it('drops a file that disappeared from disk', async () => {
    await writeFile(join(dist, 'gone.txt'), 'temporary');
    await initStatic();
    expect((await get('/gone.txt')).status).toBe(200);

    await rm(join(dist, 'gone.txt'));
    const res = await get('/gone.txt');
    // No longer a file: falls back to the SPA shell.
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });
});

describe('percent-encoded paths', () => {
  /**
   * Anything dropped into `web/public/` is copied to the dist root verbatim,
   * including names a build never generates. The browser percent-encodes the
   * space on the way out, so the server has to decode it back before it can
   * find the file.
   */
  it('finds a file whose name the browser had to encode', async () => {
    await writeFile(join(dist, 'my icon.png'), Buffer.alloc(64, 3));
    await initStatic();
    const res = await get('/my%20icon.png');
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('finds a non-ASCII file name', async () => {
    await writeFile(join(dist, 'caf\u00e9.txt'), 'espresso');
    await initStatic();
    const res = await get('/caf%C3%A9.txt');
    expect(await res.text()).toBe('espresso');
  });

  it('does not fall over on a malformed escape', async () => {
    const res = await get('/%E0%A4%A.txt');
    // Nonsense in, shell out — never a 500.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });
});

describe('security headers', () => {
  it('stops browsers sniffing a content type', async () => {
    const res = await get('/index.html');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
