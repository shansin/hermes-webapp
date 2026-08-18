/**
 * Environment configuration for the Hermes Control proxy.
 *
 * Everything is optional and defaults to a stock Hermes install. The one value
 * that needs care is the dashboard session token: see `resolveToken`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Find `.env` by walking up from this file, so the repo-root config is picked
 * up whether the process was started from the root (`start.sh`) or from
 * `server/` (`pnpm --filter … dev`).
 */
let dotEnvDir: string | null = null;

function findDotEnv(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      dotEnvDir = dir;
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromCwd = resolve(process.cwd(), '.env');
  if (existsSync(fromCwd)) {
    dotEnvDir = process.cwd();
    return fromCwd;
  }
  return null;
}

// Hand-rolled rather than pulling in dotenv for a dozen lines.
function loadDotEnv(): void {
  const path = findDotEnv();
  if (!path) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    // Real env always wins over the file, so `PORT=x pnpm start` works.
    if (process.env[key] !== undefined) continue;
    process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const Schema = z.object({
  PROXY_PORT: z.coerce.number().int().positive().default(3000),
  PROXY_HOST: z.string().default('0.0.0.0'),
  HERMES_HOST: z.string().default('127.0.0.1'),
  HERMES_PORT: z.coerce.number().int().positive().default(9119),
  HERMES_TOKEN: z.string().default(''),
  /**
   * The URL other devices should use, when it isn't derivable from this
   * machine's interfaces — a `tailscale serve` front, say, which terminates TLS
   * under a MagicDNS name and forwards here over loopback. start.sh sets it.
   */
  PUBLIC_URL: z
    .string()
    .url()
    .optional()
    .transform((u) => u?.replace(/\/+$/, '')),
  HTTPS_CERT: z.string().optional(),
  HTTPS_KEY: z.string().optional(),
  /**
   * Web-push identity. Optional: when unset, a keypair is generated on first
   * boot and persisted next to `.env`, so push works with no setup once the
   * app is served over TLS. Set them explicitly to pin a keypair across
   * machines — rotating the public key invalidates every existing
   * subscription, so the stored one is only ever generated once.
   */
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  /** Contact address VAPID requires. Push services want mailto: or https:. */
  VAPID_SUBJECT: z.string().default('mailto:hermes@localhost'),
  /** Set to 0 to keep the proxy from holding a socket open for push. */
  PUSH_ENABLED: z
    .enum(['0', '1'])
    .default('1')
    .transform((v) => v === '1'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error('Invalid configuration:\n' + issues);
  process.exit(1);
}
const env = parsed.data;

/**
 * The Hermes backend origin. Must stay on loopback: Hermes forces OAuth on a
 * non-loopback bind, and its Host/Origin guards compare against the bound
 * address — which is exactly what the proxy rewrites requests to look like.
 */
export const upstreamHost = `${env.HERMES_HOST}:${env.HERMES_PORT}`;
export const upstreamHttp = `http://${upstreamHost}`;
export const upstreamWs = `ws://${upstreamHost}`;

/**
 * The token is mutable at runtime because it can be discovered lazily: a
 * `hermes dashboard` we did not start has a random per-process token, and the
 * only way to learn it is to scrape the SPA HTML it serves on loopback.
 */
let sessionToken = env.HERMES_TOKEN;

export function getToken(): string {
  return sessionToken;
}

/**
 * Resolve the dashboard session token.
 *
 * `HERMES_TOKEN` wins when set — that is the path start.sh uses, exporting the
 * same value as HERMES_DASHBOARD_SESSION_TOKEN so the backend adopts it.
 *
 * Otherwise scrape it out of the Hermes SPA HTML, which embeds the token as
 * `window.__HERMES_DASHBOARD_SESSION_TOKEN__="…"`. This only works against
 * `hermes dashboard` (which serves a UI); headless `hermes serve` has no HTML,
 * in which case the token must be supplied explicitly.
 */
let pendingResolve: Promise<string> | null = null;

export async function resolveToken(): Promise<string> {
  if (sessionToken) return sessionToken;
  // Single-flight: a WS upgrade and an API call arriving together during boot
  // would otherwise each scrape the SPA HTML independently.
  if (pendingResolve) return pendingResolve;

  pendingResolve = (async () => {
    try {
      const res = await fetch(upstreamHttp + '/', {
        headers: { host: upstreamHost },
        signal: AbortSignal.timeout(5000),
      });
      const html = await res.text();
      const m = /__HERMES_DASHBOARD_SESSION_TOKEN__\s*=\s*"([^"]+)"/.exec(html);
      if (m?.[1]) sessionToken = m[1];
    } catch {
      // Backend down or headless — callers surface this as a health warning.
    } finally {
      pendingResolve = null;
    }
    return sessionToken;
  })();

  return pendingResolve;
}

/**
 * Forget a scraped token after the backend rejects it, so the next caller
 * re-discovers. Never clears an explicitly configured `HERMES_TOKEN`: that one
 * is not guesswork, and dropping it would just scrape a worse answer.
 */
export function clearToken(): void {
  if (env.HERMES_TOKEN) return;
  sessionToken = '';
}

/**
 * Where the proxy keeps files it owns (push subscriptions, the generated VAPID
 * keypair). Sits next to `.env` so a repo checkout keeps its state together,
 * falling back to the working directory when there is no `.env` at all.
 */
export const stateDir = dotEnvDir ?? process.cwd();

export const config = {
  ...env,
  upstreamHost,
  upstreamHttp,
  upstreamWs,
  https:
    env.HTTPS_CERT && env.HTTPS_KEY
      ? { cert: env.HTTPS_CERT, key: env.HTTPS_KEY }
      : null,
};

export type Config = typeof config;
