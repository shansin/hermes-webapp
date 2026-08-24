/**
 * Turning Hermes' config into something readable on a phone.
 *
 * `GET /api/config` returns ninety top-level keys; `display` alone holds
 * fifty-nine and `agent` forty-one. Rendered as one tree that is unusable, so
 * the screen flattens each section to `path → value` rows and searches across
 * them. The flattening is here, not in the component, because both halves of it
 * fail quietly and only one of them is visible.
 *
 * **Masking is defensive rather than urgent, and that is worth stating.** A
 * stock config turns out to hold no plaintext credentials at all — Hermes keeps
 * them in the environment, and the `*_env` keys hold the *name* of a variable,
 * not its contents. But nothing stops a hand-edited `config.yaml` from carrying
 * one, and this screen is reachable from a phone on a shared network, so the
 * rule exists for that config rather than for this one.
 *
 * It is written against whole names because the obvious `/key|token|secret/`
 * test is worse than nothing: it swallows `max_tokens`, `keyword`,
 * `threshold_tokens` and — checked against the real config — `voice.record_key`,
 * which is a push-to-talk keybinding. An inspector that redacts a keyboard key
 * is one nobody believes about anything else.
 */

/** Leaf names that hold a credential, matched whole. */
const SECRET_NAMES = new Set([
  'api_key',
  'apikey',
  'secret',
  'client_secret',
  'password',
  'password_hash',
  'passwd',
  'token',
  'access_token',
  'bearer_token',
  'refresh_token',
  'session_key',
  'private_key',
  'credential',
]);

/**
 * Whether a leaf's value should be hidden.
 *
 * Only strings are ever masked: a boolean or a number under a secret-shaped
 * name is a setting about the secret, not the secret.
 */
export function isSecretLeaf(name: string, value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  const leaf = name.toLowerCase();
  // `*_env` holds the *name* of an environment variable — the whole point of
  // which is that the value lives somewhere else.
  if (leaf.endsWith('_env')) return false;
  if (SECRET_NAMES.has(leaf)) return true;
  // Suffix forms: `openai_api_key`, `github_token`. Anchored to the end so
  // `max_tokens` and `show_token_analytics` are untouched, and deliberately
  // *not* including a bare `_key` — that matched `voice.record_key`, which is
  // a push-to-talk keybinding, and an inspector that redacts a keyboard key is
  // one nobody believes about anything else.
  return ['_api_key', '_secret', '_password', '_token'].some(
    (suffix) => leaf.endsWith(suffix) && !leaf.endsWith('_tokens'),
  );
}

export interface ConfigRow {
  /** Dotted path below the section, e.g. `retry.max_attempts`. */
  path: string;
  /** The final segment, which is what the masking rule reads. */
  leaf: string;
  value: unknown;
  secret: boolean;
}

/**
 * Flatten one section to its leaves.
 *
 * Empty objects and arrays are kept as leaves rather than dropped: "this is
 * set to nothing" is an answer, and a section that silently omitted them would
 * claim keys did not exist.
 */
export function flattenSection(value: unknown, prefix = ''): ConfigRow[] {
  const out: ConfigRow[] = [];
  const walk = (v: unknown, path: string) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        walk(child, path ? `${path}.${k}` : k);
      }
      return;
    }
    const leaf = path.split('.').pop() ?? path;
    out.push({ path, leaf, value: v, secret: isSecretLeaf(leaf, v) });
  };
  walk(value, prefix);
  return out;
}

/** A leaf rendered for display. Secrets never reach the DOM. */
export function displayValue(row: ConfigRow): string {
  if (row.secret) return '••••••••';
  const v = row.value;
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.length === 0 ? '[]' : JSON.stringify(v);
  if (typeof v === 'object') return '{}';
  return String(v);
}

/**
 * Sections matching a query, with their matching rows.
 *
 * Matches on the section name as well as the row path, so typing `cron` gives
 * the whole cron section rather than only the rows with `cron` twice in them.
 */
export function searchConfig(
  config: Record<string, unknown>,
  query: string,
): { name: string; rows: ConfigRow[] }[] {
  const needle = query.trim().toLowerCase();
  const sections = Object.keys(config)
    .sort()
    .map((name) => ({ name, rows: flattenSection(config[name]) }));
  if (!needle) return sections;
  return sections
    .map(({ name, rows }) =>
      name.toLowerCase().includes(needle)
        ? { name, rows }
        : { name, rows: rows.filter((r) => r.path.toLowerCase().includes(needle)) },
    )
    .filter((s) => s.rows.length > 0);
}
