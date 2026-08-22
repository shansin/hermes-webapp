/**
 * The Cloudflare Access gate.
 *
 * This proxy has no user accounts and never had any: reaching :3000 has always
 * meant full control of the agent. That is fine on a trusted LAN and untenable
 * on a public hostname, so the public deployment puts Cloudflare Access in
 * front — it runs the Google sign-in at the edge and refuses anyone outside the
 * allowlist before a packet reaches this machine.
 *
 * Access forwards a short-lived RS256 JWT with everything it lets through. We
 * verify that JWT here as well. The edge check is the one that does the work;
 * this one exists so that the *absence* of the edge is not silently fatal — a
 * tunnel pointed at the wrong port, a `cloudflared` that died, a stray LAN
 * client — all fail closed instead of handing over the agent. That failure is
 * invisible from the app, which is exactly the class of bug the header-disguise
 * tests in `routers/apiProxy.ts` exist for.
 *
 * Enforcement is opt-in (`accessEnabled`), so dev, LAN and Tailscale are
 * untouched.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * The two request shapes this module has to read headers from are not the same
 * object: Hono hands out a Fetch `Headers`, the raw upgrade handler hands out
 * Node's plain `IncomingHttpHeaders` record. Indexing the wrong one returns
 * undefined rather than throwing, so the gate would fail *open* — take a
 * lookup function and let each call site supply the right one.
 */
export type HeaderLookup = (name: string) => string | undefined;

export function nodeHeaders(headers: IncomingHttpHeaders): HeaderLookup {
  return (name) => {
    const v = headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
}

import { config, accessEnabled, allowedEmails } from './config.js';
import { log } from './log.js';

/** Access mints tokens under the team's own hostname. */
const issuer = `https://${config.ACCESS_TEAM_DOMAIN}`;
const certsUrl = `${issuer}/cdn-cgi/access/certs`;

/**
 * `createRemoteJWKSet` caches the key set and refetches by itself when a token
 * arrives with a `kid` it has not seen — which is what makes Cloudflare's key
 * rotation a non-event. Built lazily so an unconfigured process never resolves
 * the URL at import time (and so the tests can drive it).
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function keySet(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(certsUrl), {
      // Refetching is triggered by a `kid` we have not seen, which is also
      // exactly what an attacker gets for free by making one up — so it is
      // rate-limited. The consequence is worth stating: for up to
      // `cooldownDuration` after Cloudflare rotates its signing key, freshly
      // issued assertions are rejected. Cloudflare publishes the new key
      // before it signs with it and keeps the old one valid alongside, so in
      // practice the window never opens; 30s is the floor on how long it
      // could last if it ever did.
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }
  return jwks;
}

/** Test seam: drop the cached key set between cases. */
export function resetKeySet(): void {
  jwks = null;
}

interface AccessClaims extends JWTPayload {
  email?: string;
}

/** Why a request was turned away. Kept apart because they mean different things. */
export type AccessFailure = 'missing' | 'invalid' | 'forbidden';

export type AccessResult =
  | { ok: true; email: string }
  | { ok: false; reason: AccessFailure };

/**
 * Pull the assertion out of a request.
 *
 * The header is what `cloudflared` injects and is preferred. The cookie is the
 * fallback that matters for WebSockets: a browser cannot set a custom header on
 * an upgrade handshake, but it does send the same-origin `CF_Authorization`
 * cookie.
 */
export function extractToken(get: HeaderLookup): string | null {
  const assertion = get('cf-access-jwt-assertion');
  if (assertion) return assertion;

  const cookie = get('cookie');
  if (!cookie) return null;

  // Deliberately a regex rather than a cookie parser: one name, one shape.
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m?.[1] ?? null;
}

/**
 * Verify an assertion and check it names someone allowed.
 *
 * `jwtVerify` covers signature, `alg`, `iss`, `aud`, `exp` and `nbf` in one
 * call; anything it dislikes throws. Never throws itself — callers all want a
 * verdict, not an exception.
 */
export async function verifyAccess(get: HeaderLookup): Promise<AccessResult> {
  const token = extractToken(get);
  if (!token) return { ok: false, reason: 'missing' };

  let claims: AccessClaims;
  try {
    const { payload } = await jwtVerify<AccessClaims>(token, keySet(), {
      issuer,
      audience: config.ACCESS_AUD,
      algorithms: ['RS256'],
    });
    claims = payload;
  } catch (err) {
    // The message names the failed claim; the token itself never gets logged.
    log.warn({ err: (err as Error).message }, 'access: assertion rejected');
    return { ok: false, reason: 'invalid' };
  }

  const email = claims.email?.trim().toLowerCase();
  if (!email || !allowedEmails.has(email)) {
    log.warn({ email: email ?? null }, 'access: signed in, but not on the allowlist');
    return { ok: false, reason: 'forbidden' };
  }

  return { ok: true, email };
}

/**
 * `/healthz` is the one exemption. start.sh polls it unauthenticated over
 * loopback to decide whether the proxy came up, and it is the first thing to
 * check when the tunnel is the suspect — gating it would mean the diagnostic
 * goes dark exactly when it is needed. It exposes no agent state, and in the
 * public deployment the proxy binds loopback, so the only ways to reach it are
 * from this machine or through Access.
 */
function isExempt(path: string): boolean {
  return path === '/healthz';
}

/**
 * Global middleware. A pass-through when the gate is not configured.
 *
 * 401 and 403 are kept distinct on purpose: 401 means "no usable assertion"
 * (the session expired, or nothing put one there), which the web app can
 * recover from by bouncing through Access again. 403 means the signature was
 * good and the person simply is not allowed — retrying will never help.
 */
export const requireAccess: MiddlewareHandler = async (c, next) => {
  if (!accessEnabled || isExempt(c.req.path)) return next();

  const result = await verifyAccess((name) => c.req.header(name));
  if (!result.ok) {
    // Refusals were silent, which made a gated origin reached directly look
    // identical in the log to one nothing was reaching at all.
    log.warn({ path: c.req.path, reason: result.reason }, 'request refused');
    if (result.reason === 'forbidden') {
      return c.json({ error: 'forbidden' }, 403);
    }
    return c.json({ error: 'unauthorized' }, 401);
  }

  c.set('accessEmail', result.email);
  return next();
};
