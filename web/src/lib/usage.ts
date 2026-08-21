/**
 * Shaping usage data for the Usage screen.
 *
 * Pure functions, deliberately: the interesting decisions here are about time
 * boundaries and attribution, and both are the kind of thing that is wrong by
 * an hour for six months before anyone notices. They are testable in isolation
 * and the screen only renders what they return.
 */
import type { SessionRow } from '../api/sessions';
import type { ModelUsage, UsageDay, UsageTotals } from '../api/hub';

export const HOUR = 3600;

/**
 * A window the screen can ask for.
 *
 * `1` is special everywhere below: it is the only window drawn from session
 * rows rather than from the pre-aggregated daily buckets, because the backend
 * cannot group finer than a calendar date.
 */
export type Period = 1 | 7 | 30 | 90;

export const PERIODS: { days: Period; label: string }[] = [
  { days: 1, label: '24h' },
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

export interface HourBucket {
  /** Epoch seconds at the start of the hour. */
  start: number;
  /** Local hour of day, 0-23 — the axis label. */
  hour: number;
  input: number;
  output: number;
  total: number;
  sessions: number;
  api_calls: number;
  tool_calls: number;
  cost: number;
}

/**
 * The last `hours` whole hours, oldest first, ending with the hour we are in.
 *
 * A rolling window rather than a calendar day, and that choice is load-bearing:
 * `/api/analytics/usage?days=1` is itself rolling (`now - 86400`), so the tiles
 * above the chart and the bars in it describe the same span. A calendar day
 * would have put a UTC-bucketed total over a locally-bucketed chart — the
 * backend groups by `date(started_at, 'unixepoch')` with no `'localtime'` — and
 * the two would silently disagree by whatever the device's offset is.
 */
export function hourSlots(now: number, hours = 24): number[] {
  const endOfCurrentHour = Math.floor(now / HOUR) * HOUR + HOUR;
  const start = endOfCurrentHour - hours * HOUR;
  return Array.from({ length: hours }, (_, i) => start + i * HOUR);
}

/**
 * Bucket sessions into hourly slots **by the hour they started**.
 *
 * That rule is a simplification and the UI says so, because sessions here run
 * long — a couple of hours is typical and days happen. All of a session's
 * tokens land in the hour it opened, so a tall bar can mean "a lot happened at
 * 15:00" or "something started at 15:00 and ran until 19:00".
 *
 * The alternative was spreading each session's tokens across the hours it
 * spans, which is worse: it invents a uniform rate nothing measured, and one
 * four-day session would smear a flat carpet across the whole chart. Per
 * *message* attribution would settle it — `messages` carries both `timestamp`
 * and `token_count` — but `token_count` is NULL on every row Hermes writes
 * today, so there is nothing to attribute with.
 *
 * The session count per bucket is carried so the tooltip can distinguish the
 * two readings.
 */
export function hourlyBuckets(rows: SessionRow[], now: number, hours = 24): HourBucket[] {
  const slots = hourSlots(now, hours);
  const start = slots[0]!;
  const buckets: HourBucket[] = slots.map((s) => ({
    start: s,
    hour: new Date(s * 1000).getHours(),
    input: 0,
    output: 0,
    total: 0,
    sessions: 0,
    api_calls: 0,
    tool_calls: 0,
    cost: 0,
  }));

  for (const row of rows) {
    const idx = Math.floor((row.started_at - start) / HOUR);
    if (idx < 0 || idx >= buckets.length) continue;
    const b = buckets[idx]!;
    b.input += row.input_tokens ?? 0;
    b.output += row.output_tokens ?? 0;
    b.total += (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
    b.sessions += 1;
    b.api_calls += row.api_call_count ?? 0;
    b.tool_calls += row.tool_call_count ?? 0;
    b.cost += row.estimated_cost_usd ?? 0;
  }

  return buckets;
}

export interface DailyPoint {
  day: string;
  input: number;
  output: number;
  sessions: number;
}

/**
 * Daily rows with the idle days put back.
 *
 * The API returns only days that saw traffic, and the axis renders each row as
 * one evenly-spaced category — so a week of silence was drawn as a single step
 * and the line lied about when the work happened. Zero-fill makes the spacing a
 * true timeline. (Lifted from `ModelsTab`, which is where this bug was found.)
 */
export function fillDailyGaps(rows: UsageDay[], keepLast = 14): DailyPoint[] {
  if (rows.length === 0) return [];

  const byDay = new Map(rows.map((d) => [d.day, d]));
  const out: DailyPoint[] = [];

  const cursor = new Date(`${rows[0]!.day}T00:00:00Z`);
  const last = new Date(`${rows[rows.length - 1]!.day}T00:00:00Z`);

  while (cursor <= last) {
    const iso = cursor.toISOString().slice(0, 10);
    const hit = byDay.get(iso);
    out.push({
      day: iso.slice(5), // MM-DD
      input: hit?.input_tokens ?? 0,
      output: hit?.output_tokens ?? 0,
      sessions: hit?.sessions ?? 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return out.slice(-keepLast);
}

/**
 * Does this install price anything?
 *
 * Every cost field Hermes reports is zero for a locally-served model — the
 * pricing tables only know hosted providers, so `estimated_cost_usd` stays 0
 * and `cost_status` stays `'unknown'`. A cost-led page would then be a column
 * of `$0.00` claiming to be analytics. The cost tiles and the cost column mount
 * only when this says there is something to show, which for a hosted provider
 * is immediately and for a local one is never.
 */
export function hasCostSignal(totals: UsageTotals | undefined): boolean {
  if (!totals) return false;
  return (totals.total_estimated_cost ?? 0) > 0 || (totals.total_actual_cost ?? 0) > 0;
}

/**
 * Tokens the hourly chart cannot place, as a fraction of the true total.
 *
 * `/api/sessions` is a *conversation* list: it hides sub-agent runs and folds
 * compression continuations into their root (`list_sessions_rich` excludes
 * children and there is no query parameter to open that up). The analytics
 * totals have no such filter — they are a flat sum over the `sessions` table.
 *
 * So the bars are honestly short, and by an amount worth naming: a day of heavy
 * delegation can be a third of the real usage. Reporting the gap costs one
 * subtraction and turns a wrong-looking chart into a chart with a footnote.
 */
export function unattributedShare(barsTotal: number, trueTotal: number): number {
  if (!trueTotal || trueTotal <= barsTotal) return 0;
  return (trueTotal - barsTotal) / trueTotal;
}


/**
 * Collapse `/api/analytics/models` rows to one per model *and* provider.
 *
 * The endpoint emits a row for the model's own work and an extra row per
 * auxiliary task it was used for — and then drops the `aux_task` label while
 * building the response, so those extra rows arrive indistinguishable from the
 * first. Rendered as-is, one model appears four times with no way to tell which
 * row is which, which reads as a bug in this app rather than a breakdown.
 *
 * Summing them gives the true per-model total. The task-level split is not
 * lost: `by_task` in the usage payload keeps its labels, and the Machinery card
 * is where it belongs anyway.
 *
 * `avg_tokens_per_session` is taken from the dominant row rather than
 * recomputed, because session counts cannot be added across these rows — an
 * auxiliary row counts the same session the main row already counted.
 */
export function foldModelRows(rows: ModelUsage[]): ModelUsage[] {
  const acc = new Map<string, ModelUsage>();

  for (const row of rows) {
    const key = `${row.provider}\u0000${row.model}`;
    const seen = acc.get(key);
    if (!seen) {
      acc.set(key, { ...row });
      continue;
    }
    const dominant =
      row.input_tokens + row.output_tokens > seen.input_tokens + seen.output_tokens ? row : seen;

    acc.set(key, {
      ...seen,
      input_tokens: seen.input_tokens + row.input_tokens,
      output_tokens: seen.output_tokens + row.output_tokens,
      cache_read_tokens: (seen.cache_read_tokens ?? 0) + (row.cache_read_tokens ?? 0),
      reasoning_tokens: (seen.reasoning_tokens ?? 0) + (row.reasoning_tokens ?? 0),
      estimated_cost: (seen.estimated_cost ?? 0) + (row.estimated_cost ?? 0),
      actual_cost: (seen.actual_cost ?? 0) + (row.actual_cost ?? 0),
      api_calls: (seen.api_calls ?? 0) + (row.api_calls ?? 0),
      tool_calls: (seen.tool_calls ?? 0) + (row.tool_calls ?? 0),
      sessions: Math.max(seen.sessions ?? 0, row.sessions ?? 0),
      avg_tokens_per_session: dominant.avg_tokens_per_session,
      last_used_at: Math.max(seen.last_used_at ?? 0, row.last_used_at ?? 0) || null,
      capabilities: seen.capabilities ?? row.capabilities,
    });
  }

  return adoptUnattributedProviders([...acc.values()]).sort(
    (a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens),
  );
}

/**
 * Second pass: give a row with no provider to the model's provider, when the
 * model has exactly one.
 *
 * Auxiliary rows carry `billing_provider` only sometimes — an approval call
 * records it, a title-generation call may not — so folding on model+provider
 * alone still leaves a stray `ornith:35b-256k · 701 tokens` row underneath the
 * real one, which is the same duplicate wearing a different hat. Where the
 * model was served exactly one way in this window there is no ambiguity about
 * whose tokens those are. Where it was served two ways, guessing would move
 * usage between providers, so the row is left standing on its own.
 *
 * The backend does the same thing one level up, for session rows that predate
 * their own accounting.
 */
function adoptUnattributedProviders(rows: ModelUsage[]): ModelUsage[] {
  const out: ModelUsage[] = [];

  for (const row of rows) {
    if (row.provider) {
      out.push(row);
      continue;
    }
    // Mutating the host directly rather than looking it up in `out`: it is the
    // same object, and it may not have been pushed yet — the folded rows are in
    // insertion order, not sorted, so the orphan can come first.
    const hosts = rows.filter((r) => r.model === row.model && r.provider);
    const host = hosts.length === 1 ? hosts[0]! : undefined;
    if (!host) {
      out.push(row);
      continue;
    }
    host.input_tokens += row.input_tokens;
    host.output_tokens += row.output_tokens;
    host.api_calls = (host.api_calls ?? 0) + (row.api_calls ?? 0);
    host.tool_calls = (host.tool_calls ?? 0) + (row.tool_calls ?? 0);
    host.estimated_cost = (host.estimated_cost ?? 0) + (row.estimated_cost ?? 0);
    host.actual_cost = (host.actual_cost ?? 0) + (row.actual_cost ?? 0);
    host.last_used_at = Math.max(host.last_used_at ?? 0, row.last_used_at ?? 0) || null;
  }

  return out;
}

/** "1 call" / "2 calls" — pluralisation, applied where a count is user-facing. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Group session rows by a field, summing tokens — used for the surface split. */
export function groupSessions<K extends keyof SessionRow>(
  rows: SessionRow[],
  key: K,
  fallback = 'unknown',
): { name: string; tokens: number; sessions: number }[] {
  const acc = new Map<string, { name: string; tokens: number; sessions: number }>();
  for (const row of rows) {
    const raw = row[key];
    const name = raw == null || raw === '' ? fallback : String(raw);
    const entry = acc.get(name) ?? { name, tokens: 0, sessions: 0 };
    entry.tokens += (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
    entry.sessions += 1;
    acc.set(name, entry);
  }
  return [...acc.values()].sort((a, b) => b.tokens - a.tokens);
}

/**
 * MCP tools arrive as `mcp__<server>__<tool>`, one row per tool. On a phone
 * that is a wall of near-identical strings; the useful unit is the server.
 * Everything else passes through untouched.
 */
export function toolLabel(name: string): { label: string; server: string | null } {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (!m) return { label: name, server: null };
  return { label: m[2]!, server: m[1]! };
}

/** Compact "2h 5m" / "12m" / "40s" for a session duration. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
