/**
 * The Hem proxy.
 *
 * A thin LAN-facing shell around the Hermes backend, which stays on loopback:
 *
 *   phone ──http──> :3000 ─┬─ /api/*  ──> 127.0.0.1:9119  (REST, Host+Bearer rewritten)
 *                          ├─ /api/ws ──> 127.0.0.1:9119  (JSON-RPC, Origin rewritten)
 *                          ├─ /healthz                    (proxy's own status)
 *                          ├─ /push/*                     (web-push subscriptions)
 *                          ├─ /push/feed                  (the cron notification feed)
 *                          └─ /*      ──> web/dist        (the React PWA)
 *
 * The state the proxy owns is the push subscription list and the cron
 * notification feed, plus a gateway socket of its own to drive both — see
 * `push/events.ts` for why that cannot ride on the per-client proxy socket,
 * and `push/feed.ts` for why the feed cannot be assembled in the browser.
 *
 * We deliberately do not implement any agent logic — Hermes already has all of
 * it, including the kanban board (`/api/plugins/kanban/*`, proxied like the
 * rest of `/api`).
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createServer as createHttpsServer } from 'node:https';

import { config, accessEnabled, getToken, resolveToken, upstreamHttp, upstreamHost } from './config.js';
import { requireAccess } from './auth.js';
import { log } from './log.js';
import { apiProxy } from './routers/apiProxy.js';
import { pushRouter } from './routers/push.js';
import { shareRouter } from './routers/share.js';
import { notificationsRouter } from './routers/notifications.js';
import { startPushListener, stopPushListener } from './push/events.js';
import { startCronSweep, stopCronSweep } from './push/cron.js';
import { flushFeed } from './push/feed.js';
import { pushPublicKey } from './push/send.js';
import { attachWsProxy } from './routers/wsProxy.js';
import { staticRouter, hasBuiltWeb, webBuildId, initStatic } from './static.js';

const app = new Hono();

/**
 * The gate, first in line. Registered before every route — including
 * `/healthz`, which `requireAccess` exempts itself rather than relying on
 * being declared above this line, so reordering the routes below can never
 * quietly open a door.
 *
 * A no-op unless Cloudflare Access is configured; see `auth.ts`.
 */
app.use('*', requireAccess);

/**
 * Upstream health, cached briefly.
 *
 * The app polls this every 30s from every open tab, and start.sh hammers it
 * while waiting for the backend. Without a cache each poll is a real round
 * trip to Hermes; a short TTL plus single-flight collapses a burst into one.
 */
const HEALTH_TTL_MS = 2000;
let healthAt = 0;
/**
 * When this process came up — the closest thing the proxy has to a deploy
 * timestamp, since it runs from source under `tsx` and has no build artefact
 * of its own. Restarting the service is the deploy.
 */
const startedAt = new Date().toISOString();

let healthCache: { backend: 'up' | 'down' | 'unauthorized'; version: string | null } | null = null;
let healthInFlight: Promise<{
  backend: 'up' | 'down' | 'unauthorized';
  version: string | null;
}> | null = null;

async function probeBackend(token: string) {
  if (healthCache && Date.now() - healthAt < HEALTH_TTL_MS) return healthCache;
  if (healthInFlight) return healthInFlight;

  healthInFlight = (async () => {
    let backend: 'up' | 'down' | 'unauthorized' = 'down';
    let version: string | null = null;
    try {
      const res = await fetch(upstreamHttp + '/api/health', {
        headers: { host: upstreamHost, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(4000),
      });
      if (res.status === 401) {
        backend = 'unauthorized';
      } else if (res.ok) {
        backend = 'up';
        version = ((await res.json()) as { version?: string }).version ?? null;
      }
    } catch {
      backend = 'down';
    }
    healthCache = { backend, version };
    healthAt = Date.now();
    healthInFlight = null;
    return healthCache;
  })();

  return healthInFlight;
}

/**
 * Proxy health — deliberately distinct from Hermes' own `/api/health`, which
 * is proxied. This one reports whether the *link* to Hermes is working, which
 * is what the first-run screen and start.sh care about.
 */
app.get('/healthz', async (c) => {
  const token = getToken() || (await resolveToken());
  const { backend, version } = await probeBackend(token);

  return c.json({
    ok: backend === 'up',
    backend,
    version,
    upstream: upstreamHost,
    hasToken: Boolean(token),
    webBuilt: hasBuiltWeb(),
    /**
     * What this process is *serving*, and how long it has been up. The client
     * reports what it is *running* (`__BUILD_ID__`, baked into its bundle);
     * the two differing is a service worker holding an old copy, which is
     * otherwise invisible from both ends.
     */
    webBuild: webBuildId(),
    serverStartedAt: startedAt,
    pushEnabled: Boolean(pushPublicKey()),
    lanUrl: lanUrl(),
    publicUrl: config.PUBLIC_URL ?? null,
  });
});

app.route('/', shareRouter);
app.route('/', pushRouter);
app.route('/', notificationsRouter);
app.route('/', apiProxy);
app.route('/', staticRouter);

// Last resort: the web app hasn't been built yet.
app.notFound((c) => {
  if (!hasBuiltWeb()) {
    return c.html(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
       <body style="font:16px system-ui;padding:2rem;background:#0b0b0f;color:#e8e8ef">
       <h1>Hem</h1>
       <p>The web app hasn't been built yet. Run:</p>
       <pre style="background:#1a1a22;padding:1rem;border-radius:8px">pnpm build</pre>
       <p>…or use <code>bash start.sh</code>, which builds automatically.</p>
       </body>`,
      503,
    );
  }
  return c.json({ error: 'not_found' }, 404);
});

/**
 * The URL another device on the LAN should open.
 *
 * The app can't derive this itself: a browser only knows the host it was
 * loaded from, so opening the app on localhost produced a QR code pointing at
 * 127.0.0.1 — useless on the phone it was meant to be scanned by. The server
 * is the only side that knows its own LAN address.
 */
function lanUrl(): string | null {
  const host = lanAddress();
  if (!host) return null;
  const scheme = config.HTTPS_CERT && config.HTTPS_KEY ? 'https' : 'http';
  return `${scheme}://${host}:${config.PROXY_PORT}`;
}

/** Best-effort LAN address, printed so the phone knows where to point. */
function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

// Index web/dist once, so the request path never makes a blocking fs call.
await initStatic();

const token = await resolveToken();
if (!token) {
  log.warn(
    `No Hermes token. Set HERMES_TOKEN in .env, or run the backend as ` +
      `HERMES_DASHBOARD_SESSION_TOKEN=<token> hermes serve. ` +
      `Auto-discovery only works against \`hermes dashboard\`.`,
  );
}

const server = serve(
  {
    fetch: app.fetch,
    port: config.PROXY_PORT,
    hostname: config.PROXY_HOST,
    createServer: config.https ? createHttpsServer : undefined,
    serverOptions: config.https
      ? {
          cert: readFileSync(config.https.cert),
          key: readFileSync(config.https.key),
        }
      : undefined,
  } as Parameters<typeof serve>[0],
  (info) => {
    const scheme = config.https ? 'https' : 'http';
    const lan = lanAddress();
    log.info(`Hem listening on ${scheme}://${config.PROXY_HOST}:${info.port}`);
    // Only when we are actually listening on the LAN. Bound to loopback — the
    // Cloudflare deployment — that address refuses connections, and printing it
    // sends you off to debug a phone that was never going to reach it.
    const onLan = config.PROXY_HOST !== '127.0.0.1' && config.PROXY_HOST !== 'localhost';
    if (lan && onLan) log.info(`  On your phone:  ${scheme}://${lan}:${info.port}`);
    if (config.PUBLIC_URL) log.info(`  Public URL:     ${config.PUBLIC_URL}`);
    log.info(`  Hermes backend: ${upstreamHost} (token ${token ? 'ok' : 'MISSING'})`);
    // A proxy that thinks it is gated but is not is the failure worth shouting
    // about: everything looks healthy while the agent is wide open.
    if (accessEnabled) {
      log.info(`  Access gate:    on (${config.ACCESS_TEAM_DOMAIN})`);
    } else if (config.PUBLIC_URL && !config.PUBLIC_URL.includes('ts.net')) {
      log.warn('  Access gate:    OFF — PUBLIC_URL is set but nothing authenticates callers.');
    }
    if (!config.https && !config.PUBLIC_URL) {
      log.info('  HTTP mode — PWA install/offline/push stay dormant until TLS is configured.');
    } else if (pushPublicKey()) {
      log.info('  Web push:       ready (enable it in Settings on the phone)');
    }
    if (!hasBuiltWeb()) log.warn('  web/dist not built — run `pnpm build`.');
  },
);

attachWsProxy(server as unknown as Parameters<typeof attachWsProxy>[0]);

// Held open for the life of the process: push exists to deliver when no
// browser is connected, so it cannot depend on a client socket being up.
startPushListener();
// And a periodic look on top of the socket's signals: `cron.changed` only ever
// fires for the active profile's job file, so a job in any other profile is
// invisible to the listener — see the note in `push/cron.ts`.
startCronSweep();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`${signal} — shutting down`);
    stopPushListener();
    stopCronSweep();
    // The feed's writes are debounced, so the last one may still be pending.
    flushFeed();
    server.close(() => process.exit(0));
    // Don't let a wedged keep-alive socket hold the process open forever.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
