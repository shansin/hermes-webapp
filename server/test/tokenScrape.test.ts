/**
 * Discovering the session token from a dashboard we did not start.
 *
 * The pattern was written against `__HERMES_DASHBOARD_SESSION_TOKEN__`, a name
 * no Hermes checked against has ever emitted — they inject
 * `__HERMES_SESSION_TOKEN__`. So the scrape never matched, and the failure was
 * the invisible kind: `/api/health` needs no credential, so the backend looked
 * up while every real call 401'd. Pinned against the spelling the live HTML
 * actually carries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let html = '';

beforeEach(() => {
  vi.resetModules();
  // An explicit token would short-circuit the scrape; the repo's own `.env`
  // must not supply one, and an already-set variable takes precedence over it.
  process.env.HERMES_TOKEN = '';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html' } })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveToken', () => {
  it('finds the token under the name Hermes injects', async () => {
    html = '<script>window.__HERMES_SESSION_TOKEN__="tok-live";</script>';
    const { resolveToken } = await import('../src/config.js');
    expect(await resolveToken()).toBe('tok-live');
  });

  it('still accepts the older spelling', async () => {
    html = '<script>window.__HERMES_DASHBOARD_SESSION_TOKEN__ = "tok-old"</script>';
    const { resolveToken } = await import('../src/config.js');
    expect(await resolveToken()).toBe('tok-old');
  });

  it('finds nothing in a page that carries no token', async () => {
    html = '<html><body>headless</body></html>';
    const { resolveToken } = await import('../src/config.js');
    expect(await resolveToken()).toBe('');
  });
});
