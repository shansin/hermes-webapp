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
 */
import { Hono } from 'hono';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, extname, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const webDist = resolve(here, '../../web/dist');

export const hasBuiltWeb = (): boolean => existsSync(join(webDist, 'index.html'));

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

function send(absPath: string, urlPath: string): Response {
  const size = statSync(absPath).size;
  const type = MIME[extname(absPath).toLowerCase()] ?? 'application/octet-stream';

  const headers = new Headers({ 'Content-Type': type, 'Content-Length': String(size) });
  if (urlPath.startsWith('/assets/')) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    // index.html, sw.js and the manifest must revalidate so updates land.
    headers.set('Cache-Control', 'no-cache');
  }

  const stream = Readable.toWeb(createReadStream(absPath)) as ReadableStream;
  return new Response(stream, { headers });
}

export const staticRouter = new Hono();

staticRouter.get('*', async (c, next) => {
  if (!hasBuiltWeb()) return next();

  const urlPath = new URL(c.req.url).pathname;

  // Resolve inside webDist and verify containment — blocks `../` traversal.
  const candidate = resolve(webDist, '.' + normalize(urlPath));
  if (
    (candidate === webDist || candidate.startsWith(webDist + '/')) &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
  ) {
    return send(candidate, urlPath);
  }

  // Unknown path → SPA route. Never fall back for API calls.
  if (urlPath.startsWith('/api/') || urlPath.startsWith('/healthz')) return next();
  return send(join(webDist, 'index.html'), '/index.html');
});
