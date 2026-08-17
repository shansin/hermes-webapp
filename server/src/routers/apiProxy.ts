/**
 * HTTP proxy for `/api/*` → the loopback Hermes backend.
 *
 * Two things make this more than a passthrough:
 *
 *  1. **Host rewriting.** Hermes validates the `Host` header against the
 *     interface it bound (an anti-DNS-rebinding guard). A request arriving as
 *     `Host: 192.168.1.50:3000` is rejected, so we always present the upstream
 *     as `Host: 127.0.0.1:9119`.
 *  2. **Auth injection.** The phone never sees the dashboard session token; the
 *     proxy adds `Authorization: Bearer …` server-side.
 *
 * Request and response bodies are streamed, so audio uploads and file
 * downloads don't buffer in memory.
 */
import { Hono } from 'hono';
import { config, getToken, resolveToken, upstreamHttp, upstreamHost } from '../config.js';
import { log } from '../log.js';

export const apiProxy = new Hono();

// Hop-by-hop headers must not be forwarded (RFC 9110 §7.6.1); `host` and
// `authorization` are replaced wholesale below.
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'authorization',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'content-length',
]);

const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

apiProxy.all('/api/*', async (c) => {
  const url = new URL(c.req.url);
  const target = upstreamHttp + url.pathname + url.search;

  const headers = new Headers();
  for (const [k, v] of Object.entries(c.req.header())) {
    if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  }
  headers.set('host', upstreamHost);

  const token = getToken() || (await resolveToken());
  if (token) headers.set('authorization', `Bearer ${token}`);

  const method = c.req.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? c.req.raw.body : undefined,
      // Required by undici whenever a stream is used as the request body.
      duplex: 'half',
      redirect: 'manual',
      signal: AbortSignal.timeout(15 * 60 * 1000),
    } as RequestInit & { duplex: 'half' });

    const outHeaders = new Headers();
    upstream.headers.forEach((v, k) => {
      if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) outHeaders.set(k, v);
    });

    // A 401 here almost always means a scraped token went stale because the
    // backend restarted. Drop it so the next request re-discovers.
    if (upstream.status === 401 && !config.HERMES_TOKEN) {
      log.warn('upstream 401 — token may be stale, will re-resolve');
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  } catch (err) {
    log.error({ err, target }, 'api proxy request failed');
    return c.json(
      {
        error: 'upstream_unreachable',
        detail: `Could not reach the Hermes backend at ${upstreamHost}.`,
      },
      502,
    );
  }
});
