/**
 * The Cloudflare Access gate.
 *
 * Every failure this module can have is a silent one. A gate that rejects a
 * good token produces a locked-out phone, which at least announces itself; a
 * gate that accepts a bad one produces a wide-open agent that looks perfectly
 * healthy from every screen in the app. So these tests mint real RS256 tokens
 * against a real key set and serve a real JWKS document, rather than stubbing
 * `jwtVerify` and asserting we called it — the claim checks *are* the feature.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { Hono } from 'hono';

const TEAM = 'testteam.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const ISSUER = `https://${TEAM}`;
const CERTS = `${ISSUER}/cdn-cgi/access/certs`;

let enabled = true;
let emails = new Set(['owner@example.com']);

vi.mock('../src/config.js', () => ({
  get config() {
    return { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  },
  get accessEnabled() {
    return enabled;
  },
  get allowedEmails() {
    return emails;
  },
}));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { requireAccess, extractToken, resetKeySet } = await import('../src/auth.js');

let privateKey: CryptoKey;
let publicJwk: JWK;
/** A second key the JWKS does not advertise, for the wrong-signer case. */
let strangerKey: CryptoKey;
/** How many times the key set was fetched, to prove caching and kid-refetch. */
let certFetches = 0;

const KID = 'kid-1';

async function mint(
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey; kid?: string; exp?: string | number } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? privateKey);
}

/** A minimal app standing in for the real middleware chain. */
function app() {
  const a = new Hono();
  a.use('*', requireAccess);
  a.get('/healthz', (c) => c.json({ ok: true }));
  a.get('/api/sessions', (c) => c.json({ email: c.get('accessEmail') ?? null }));
  return a;
}

const send = (path: string, headers: Record<string, string> = {}) =>
  app().request(new Request(`http://proxy${path}`, { headers }));

beforeEach(async () => {
  enabled = true;
  emails = new Set(['owner@example.com']);
  certFetches = 0;
  resetKeySet();

  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  strangerKey = (await generateKeyPair('RS256', { extractable: true })).privateKey as CryptoKey;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === CERTS) {
        certFetches++;
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractToken', () => {
  it('prefers the header cloudflared injects', () => {
    const get = (n: string) =>
      ({ 'cf-access-jwt-assertion': 'from-header', cookie: 'CF_Authorization=from-cookie' })[n];
    expect(extractToken(get)).toBe('from-header');
  });

  it('falls back to the cookie, which is all a WebSocket handshake can carry', () => {
    const get = (n: string) => ({ cookie: 'other=1; CF_Authorization=from-cookie; x=2' })[n];
    expect(extractToken(get)).toBe('from-cookie');
  });

  it('is null when neither is present', () => {
    expect(extractToken(() => undefined)).toBeNull();
  });
});

describe('requireAccess', () => {
  it('passes a valid assertion through and records who it was', async () => {
    const jwt = await mint({ email: 'owner@example.com' });
    const res = await send('/api/sessions', { 'cf-access-jwt-assertion': jwt });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ email: 'owner@example.com' });
  });

  it('accepts the assertion from the CF_Authorization cookie', async () => {
    const jwt = await mint({ email: 'owner@example.com' });
    const res = await send('/api/sessions', { cookie: `CF_Authorization=${jwt}` });

    expect(res.status).toBe(200);
  });

  it('matches the allowlist case-insensitively', async () => {
    const jwt = await mint({ email: 'Owner@Example.COM' });
    expect((await send('/api/sessions', { 'cf-access-jwt-assertion': jwt })).status).toBe(200);
  });

  it('401s when there is no assertion at all', async () => {
    const res = await send('/api/sessions');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it('401s on a token signed by someone else', async () => {
    const jwt = await mint({ email: 'owner@example.com' }, { key: strangerKey });
    expect((await send('/api/sessions', { 'cf-access-jwt-assertion': jwt })).status).toBe(401);
  });

  it('401s on an expired token', async () => {
    const jwt = await mint({ email: 'owner@example.com' }, { exp: Math.floor(Date.now() / 1000) - 60 });
    expect((await send('/api/sessions', { 'cf-access-jwt-assertion': jwt })).status).toBe(401);
  });

  it('401s when the token is for a different Access application', async () => {
    // The same team signs every application's tokens, so `aud` is the only
    // thing stopping a token minted for some other app on this account.
    const jwt = await new SignJWT({ email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience('b'.repeat(64))
      .setExpirationTime('5m')
      .sign(privateKey);

    expect((await send('/api/sessions', { 'cf-access-jwt-assertion': jwt })).status).toBe(401);
  });

  it('403s a correctly signed token for someone not on the allowlist', async () => {
    const jwt = await mint({ email: 'someone-else@example.com' });
    const res = await send('/api/sessions', { 'cf-access-jwt-assertion': jwt });

    // Distinct from 401 on purpose: retrying the login will never fix this,
    // so the app must not bounce the person through Google again.
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden' });
  });

  it('403s a token carrying no email claim', async () => {
    const jwt = await mint({});
    expect((await send('/api/sessions', { 'cf-access-jwt-assertion': jwt })).status).toBe(403);
  });

  it('leaves /healthz open, because start.sh probes it before anyone can log in', async () => {
    const res = await send('/healthz');
    expect(res.status).toBe(200);
    expect(certFetches).toBe(0);
  });

  it('is a pass-through when the gate is not configured', async () => {
    // The LAN and Tailscale deployments must keep working untouched.
    enabled = false;
    const res = await send('/api/sessions');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ email: null });
  });

  it('fetches the key set once and reuses it', async () => {
    const jwt = await mint({ email: 'owner@example.com' });
    await send('/api/sessions', { 'cf-access-jwt-assertion': jwt });
    await send('/api/sessions', { 'cf-access-jwt-assertion': jwt });

    expect(certFetches).toBe(1);
  });

  it('does not refetch the key set on every unknown kid', async () => {
    await send('/api/sessions', { 'cf-access-jwt-assertion': await mint({ email: 'owner@example.com' }) });
    expect(certFetches).toBe(1);

    // An unknown `kid` is free to invent, so it must not be a lever for making
    // the proxy hammer Cloudflare. Within the cooldown these are simply 401s.
    for (let i = 0; i < 5; i++) {
      const res = await send('/api/sessions', {
        'cf-access-jwt-assertion': await mint({ email: 'owner@example.com' }, { kid: `made-up-${i}` }),
      });
      expect(res.status).toBe(401);
    }

    expect(certFetches).toBe(1);
  });

  it('picks up a rotated signing key once the cooldown has passed', async () => {
    await send('/api/sessions', { 'cf-access-jwt-assertion': await mint({ email: 'owner@example.com' }) });
    expect(certFetches).toBe(1);

    // Cloudflare rotates its Access signing keys. A token under the new kid
    // has to start working without restarting the proxy.
    const rotated = await generateKeyPair('RS256', { extractable: true });
    privateKey = rotated.privateKey as CryptoKey;
    publicJwk = { ...(await exportJWK(rotated.publicKey)), kid: 'kid-2', alg: 'RS256', use: 'sig' };
    const jwt = await mint({ email: 'owner@example.com' }, { kid: 'kid-2' });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 31_000);
      const res = await send('/api/sessions', { 'cf-access-jwt-assertion': jwt });

      expect(certFetches).toBe(2);
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
