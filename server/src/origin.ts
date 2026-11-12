/**
 * Refuse a browser page from another origin: the cross-site WebSocket check.
 *
 * Hermes guards itself against this — it refuses a WebSocket `Origin` whose
 * netloc is not the interface it bound. The proxy then disarms that guard on
 * purpose, by rewriting every handshake to look like loopback (the disguise is
 * the reason it exists; see `routers/wsProxy.ts`), which left nothing checking
 * the browser's real Origin. A browser lets any page open a socket to any
 * address, sending its own Origin and trusting the server to look — so in LAN
 * mode, where nothing authenticates callers, any web page someone on the LAN
 * had open could dial `ws://<lan-ip>:3000/api/ws` and drive the agent.
 *
 * The rule is same-origin, and deliberately no more: an `Origin` whose host is
 * the request's own `Host` is the app talking to itself, whatever name it was
 * loaded under — LAN address, Cloudflare hostname, Tailscale name, Vite on
 * :5173 (which forwards Host unchanged). `PUBLIC_URL` and `ALLOWED_ORIGINS`
 * cover a front that rewrites Host; `*` there is the off switch. The real
 * boundary for anything public is Cloudflare Access (`auth.ts`); this closes
 * the hole the disguise opened, and does not try to be an allowlist of names.
 *
 * Applied to WebSocket handshakes and to REST writes. A request with no
 * `Origin` passes — curl, start.sh, and same-origin GETs omit it, while a
 * browser always sends one on a cross-origin fetch, a non-GET and a handshake.
 */
import type { MiddlewareHandler } from 'hono';
import type { IncomingHttpHeaders } from 'node:http';

import { config } from './config.js';
import { log } from './log.js';

/** Methods with no side effects, which a page cannot read the answer to anyway. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `host[:port]`, lower-cased, a default port dropped — how `URL.host` spells it. */
const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/:(80|443)$/, '');

/** Origins admitted beyond same-origin, read per call so a test can vary them. */
function extraOrigins(): { all: boolean; origins: Set<string> } {
  const origins = new Set<string>();
  let all = false;
  const entries = [config.PUBLIC_URL ?? '', ...config.ALLOWED_ORIGINS.split(',')];
  for (const raw of entries.map((s) => s.trim()).filter(Boolean)) {
    if (raw === '*') {
      all = true;
      continue;
    }
    try {
      origins.add(new URL(raw).origin);
    } catch {
      // Not a URL; it can never equal a serialized Origin, so it admits nothing.
    }
  }
  return { all, origins };
}

/**
 * Whether a browser page at `origin` may drive a request addressed to `host`.
 * `null` — a sandboxed frame, a `data:` page — fails to parse and is refused.
 */
export function originAllowed(origin: string, host: string | undefined): boolean {
  const extra = extraOrigins();
  if (extra.all) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (host && normalizeHost(url.host) === normalizeHost(host)) return true;
  return extra.origins.has(url.origin);
}

/** Logged once a minute per origin: a hostile page in a forgotten tab retries for ever. */
const lastLogged = new Map<string, number>();
function logRefusal(origin: string, path: string, kind: string): void {
  const now = Date.now();
  if (now - (lastLogged.get(origin) ?? -Infinity) < 60_000) return;
  if (lastLogged.size > 256) lastLogged.clear();
  lastLogged.set(origin, now);
  log.warn({ origin, path }, `${kind} refused: cross-origin — add it to ALLOWED_ORIGINS if it is yours`);
}

/**
 * REST writes. Registered ahead of the Access gate, so a forged request is
 * turned away without a key-set fetch to find out.
 *
 * `/share` is exempt: Android posts the share target as a browser-initiated
 * navigation, which carries `Origin: null`, and the route does nothing but
 * redirect into a draft (`routers/share.ts`).
 */
export const requireSameOrigin: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin');
  if (!origin || SAFE_METHODS.has(c.req.method) || c.req.path === '/share') return next();
  if (originAllowed(origin, c.req.header('host'))) return next();
  logRefusal(origin, c.req.path, 'request');
  // Without the Access gate's marker header: this is not about a session, and
  // the app reads that marker as "signed out".
  return c.json({ error: 'origin_forbidden' }, 403);
};

/**
 * The same check for a WebSocket handshake, which never reaches Hono (see
 * `attachWsProxy`). True when the upgrade must be refused.
 */
export function refuseUpgrade(path: string, headers: IncomingHttpHeaders): boolean {
  const origin = headers.origin;
  if (!origin) return false;
  if (originAllowed(origin, headers.host)) return false;
  logRefusal(origin, path, 'websocket upgrade');
  return true;
}
