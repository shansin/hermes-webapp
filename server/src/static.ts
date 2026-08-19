/**
 * Serves the built React app from `web/dist`.
 *
 * SPA semantics: any path that isn't a real file falls back to index.html so
 * client-side routes survive a reload or a home-screen launch. Hashed Vite
 * assets get a long immutable cache; the shell and the service worker must not
 * be cached, or an update would never reach an installed phone.
 *
 * Files are read directly rather than via `serveStatic`, whose root is
 * cwd-relative — that breaks as soon as the server is started from `server/`
 * instead of the repo root.
 *
 * Three things keep this fast for a phone on Wi-Fi:
 *
 *  - A manifest of `web/dist` is built once at boot, so the request path does
 *    no `existsSync`/`statSync`. Those are synchronous syscalls, and this is a
 *    single-threaded event loop serving a streaming chat UI.
 *  - Text assets are compressed once, in the background at boot, and the result
 *    is kept in memory. The bundle is ~1.2 MB raw and ~300 KB compressed, and
 *    it is the single largest cost of a cold load.
 *  - Everything carries an ETag, so a reload of the shell costs a 304 instead
 *    of re-streaming index.html.
 */
import { Hono } from 'hono';
import { createReadStream } from 'node:fs';
import { stat, readdir, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, extname, normalize } from 'node:path';
import { gzip, brotliCompress, constants as zlib } from 'node:zlib';
import { promisify } from 'node:util';

// The async forms run on libuv's threadpool, so compressing an asset no longer
// stalls the event loop this process also relays the chat WebSocket on.
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

const here = dirname(fileURLToPath(import.meta.url));
export const webDist = resolve(here, '../../web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Extensions worth compressing. Deliberately excludes `.png`/`.webp`/`.woff2`:
 * they are already compressed, and running them through brotli spends CPU to
 * make them marginally larger.
 */
const COMPRESSIBLE = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.webmanifest',
  '.svg',
  '.txt',
  '.map',
]);

/** Below this, framing overhead outweighs anything compression saves. */
const MIN_COMPRESS_BYTES = 1024;

type Encoding = 'br' | 'gzip';

interface Entry {
  abs: string;
  size: number;
  mtimeMs: number;
  type: string;
  compressible: boolean;
  /**
   * Compressed representations, built on first use and kept.
   *
   * Keyed to the *promise* rather than the buffer so that concurrent requests
   * for the same asset — which is what a cold page load is — share one
   * compression instead of each starting their own and discarding all but the
   * last. A resolved promise costs a microtask to await.
   */
  enc: Map<Encoding, Promise<Buffer>>;
}

/** urlPath (`/assets/index-abc.js`) -> entry. Built once at boot. */
const manifest = new Map<string, Entry>();
let builtWeb = false;

export const hasBuiltWeb = (): boolean => builtWeb;

function entryOf(abs: string, size: number, mtimeMs: number): Entry {
  const ext = extname(abs).toLowerCase();
  return {
    abs,
    size,
    mtimeMs,
    type: MIME[ext] ?? 'application/octet-stream',
    compressible: COMPRESSIBLE.has(ext) && size >= MIN_COMPRESS_BYTES,
    enc: new Map(),
  };
}

/**
 * Walk `web/dist` once and record every file. Vite's asset names are content
 * hashed, so this snapshot stays valid for the life of the process; the few
 * unhashed files (index.html, sw.js, the manifest) are revalidated per request
 * — see `fresh()`.
 */
async function walk(dir: string, prefix: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    const abs = join(dir, d.name);
    const urlPath = `${prefix}/${d.name}`;
    if (d.isDirectory()) {
      await walk(abs, urlPath);
    } else if (d.isFile()) {
      try {
        const st = await stat(abs);
        manifest.set(urlPath, entryOf(abs, st.size, st.mtimeMs));
      } catch {
        // Raced with a rebuild; the per-request revalidation will pick it up.
      }
    }
  }
}

export async function initStatic(): Promise<void> {
  manifest.clear();
  await walk(webDist, '');
  builtWeb = manifest.has('/index.html');
  // Fire and forget: see `warm()`. Boot must not wait on it.
  void warm();
}

/** Hashed assets never change under a fixed name; everything else might. */
const isImmutable = (urlPath: string) => urlPath.startsWith('/assets/');

/**
 * Return the entry for `urlPath`, revalidating the mutable ones.
 *
 * A rebuild while the server is running rewrites index.html and sw.js in
 * place. Re-stat those (async, off the sync path) and drop stale compressed
 * copies so an update actually reaches an installed phone.
 */
async function fresh(urlPath: string): Promise<Entry | null> {
  const hit = manifest.get(urlPath);
  if (hit && isImmutable(urlPath)) return hit;

  const abs = hit?.abs ?? safeJoin(urlPath);
  if (!abs) return null;

  try {
    const st = await stat(abs);
    if (!st.isFile()) return null;
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
    const next = entryOf(abs, st.size, st.mtimeMs);
    manifest.set(urlPath, next);
    return next;
  } catch {
    if (hit) manifest.delete(urlPath);
    return null;
  }
}

/** Resolve inside webDist and verify containment — blocks `../` traversal. */
function safeJoin(urlPath: string): string | null {
  const candidate = resolve(webDist, '.' + normalize(urlPath));
  if (candidate !== webDist && !candidate.startsWith(webDist + '/')) return null;
  return candidate;
}

/** The best encoding the client accepts, or null to send the bytes as-is. */
function negotiate(accept: string | undefined, e: Entry): Encoding | null {
  if (!e.compressible || !accept) return null;
  const a = accept.toLowerCase();
  // Brotli first: ~15% smaller than gzip on this bundle, and universal on the
  // phones that can install a PWA at all.
  if (a.includes('br')) return 'br';
  if (a.includes('gzip')) return 'gzip';
  return null;
}

function encoded(e: Entry, enc: Encoding): Promise<Buffer> {
  const cached = e.enc.get(enc);
  if (cached) return cached;

  const job = (async () => {
    const raw = await readFile(e.abs);
    // Quality 5 rather than 11: 11 would spend ~a second on a 470 KB bundle
    // for a few percent, and `warm()` below is racing the first request.
    return enc === 'br'
      ? brotliAsync(raw, {
          params: {
            [zlib.BROTLI_PARAM_QUALITY]: 5,
            [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        })
      : gzipAsync(raw, { level: 6 });
  })().catch((err: unknown) => {
    // Never cache a failure: a transient read error would otherwise wedge this
    // representation for the life of the process.
    if (e.enc.get(enc) === job) e.enc.delete(enc);
    throw err;
  });

  e.enc.set(enc, job);
  return job;
}

/**
 * Compress everything up front, in the background.
 *
 * Compression used to happen on the first request for each asset, which put it
 * squarely in the path of a cold page load — and synchronously, on the event
 * loop, while this same process relays a streaming chat socket. Measured over
 * the current `web/dist`: 164 ms across 71 files (4.67 MB → 1.25 MB), and a
 * cold load asks for several chunks at once, so that time serialized.
 *
 * Deliberately not awaited by `initStatic`: the server should start listening
 * immediately, and a request that arrives mid-warm simply joins the in-flight
 * promise above rather than duplicating the work.
 *
 * Brotli only. `negotiate` prefers it and every phone that can install a PWA
 * accepts it, so precompressing gzip as well would double the work to serve a
 * client we essentially never see; that path stays lazy.
 */
async function warm(): Promise<void> {
  for (const entry of manifest.values()) {
    if (!entry.compressible) continue;
    // Sequential on purpose — this is background work, and firing 70 threadpool
    // jobs at once would contend with the requests it exists to speed up.
    await encoded(entry, 'br').catch(() => {
      // A file that can't be read now will be retried on request.
    });
  }
}

/**
 * ETag identifies a *representation*, so the encoding is part of it — serving
 * a brotli body under the same tag as the identity body would let a cache hand
 * compressed bytes to a client that asked for plain.
 */
const etagOf = (e: Entry, enc: Encoding | null) =>
  `W/"${e.size.toString(36)}-${Math.trunc(e.mtimeMs).toString(36)}${enc ? `-${enc}` : ''}"`;

async function send(e: Entry, urlPath: string, accept: string | undefined, inm: string | undefined) {
  const enc = negotiate(accept, e);
  const etag = etagOf(e, enc);

  const headers = new Headers({
    'Content-Type': e.type,
    ETag: etag,
    'Cache-Control': isImmutable(urlPath)
      ? 'public, max-age=31536000, immutable'
      : // index.html, sw.js and the manifest must revalidate so updates land.
        'no-cache',
  });
  if (e.compressible) headers.set('Vary', 'Accept-Encoding');

  if (inm && inm.split(',').some((t) => t.trim() === etag)) {
    return new Response(null, { status: 304, headers });
  }

  if (enc) {
    const body = await encoded(e, enc);
    headers.set('Content-Encoding', enc);
    headers.set('Content-Length', String(body.length));
    return new Response(body, { headers });
  }

  headers.set('Content-Length', String(e.size));
  const stream = Readable.toWeb(createReadStream(e.abs)) as ReadableStream;
  return new Response(stream, { headers });
}

export const staticRouter = new Hono();

staticRouter.get('*', async (c, next) => {
  if (!builtWeb) return next();

  const urlPath = new URL(c.req.url).pathname;
  const accept = c.req.header('accept-encoding');
  const inm = c.req.header('if-none-match');

  const hit = await fresh(urlPath);
  if (hit) return send(hit, urlPath, accept, inm);

  // Unknown path → SPA route. Never fall back for API calls.
  if (urlPath.startsWith('/api/') || urlPath.startsWith('/healthz')) return next();

  const shell = await fresh('/index.html');
  if (!shell) return next();
  return send(shell, '/index.html', accept, inm);
});
