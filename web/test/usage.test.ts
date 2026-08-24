/**
 * The Usage screen's arithmetic.
 *
 * Everything here is a decision about a time boundary or about what a number
 * is allowed to claim, and both fail quietly: an hourly chart that is off by
 * one bucket, or a total that silently drops a third of the day's work, looks
 * exactly like a correct one. The screen renders only what these return, so
 * they are checked directly.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HOUR,
  fillDailyGaps,
  foldModelRows,
  plural,
  formatDuration,
  groupSessions,
  hasCostSignal,
  hourSlots,
  hourlyBuckets,
  toolLabel,
  unattributedShare,
} from '../src/lib/usage';
import { MAX_WINDOW_PAGES, fetchSessionsSince, type SessionRow } from '../src/api/sessions';
import type { ModelUsage, UsageDay, UsageTotals } from '../src/api/hub';

/** 2026-08-20 15:30 local, i.e. deliberately mid-hour. */
const NOW = new Date(2026, 7, 20, 15, 30, 0).getTime() / 1000;

const session = (over: Partial<SessionRow>): SessionRow => ({
  id: 's',
  title: null,
  source: 'web',
  model: 'ornith:35b',
  started_at: NOW,
  ended_at: null,
  message_count: 0,
  tool_call_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  estimated_cost_usd: 0,
  cwd: null,
  parent_session_id: null,
  pinned: false,
  archived: false,
  ...over,
});

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  total_input: 0,
  total_output: 0,
  total_cache_read: 0,
  total_reasoning: 0,
  total_estimated_cost: 0,
  total_actual_cost: 0,
  total_sessions: 0,
  total_api_calls: 0,
  ...over,
});

describe('the 24-hour window', () => {
  it('is 24 whole hours ending with the hour we are in', () => {
    const slots = hourSlots(NOW);
    expect(slots).toHaveLength(24);
    // Every slot sits on an hour boundary.
    expect(slots.every((s) => s % HOUR === 0)).toBe(true);
    // The last one contains `now` rather than starting after it.
    expect(slots.at(-1)!).toBeLessThanOrEqual(NOW);
    expect(slots.at(-1)! + HOUR).toBeGreaterThan(NOW);
  });

  /**
   * The window is hour-aligned so the query key derived from it is stable —
   * recomputed from a raw `Date.now()` it would change every render and refetch
   * the day on each one.
   */
  it('does not move within an hour', () => {
    expect(hourSlots(NOW)[0]).toBe(hourSlots(NOW + 900)[0]);
    expect(hourSlots(NOW)[0]).not.toBe(hourSlots(NOW + HOUR)[0]);
  });
});

describe('hourly buckets', () => {
  it('files a session under the hour it started, not the hour it ended', () => {
    const rows = [
      session({ started_at: NOW - 4 * HOUR, ended_at: NOW, input_tokens: 900, output_tokens: 100 }),
    ];
    const buckets = hourlyBuckets(rows, NOW);

    const filled = buckets.filter((b) => b.total > 0);
    expect(filled).toHaveLength(1);
    expect(filled[0]!.total).toBe(1000);
    expect(filled[0]!.start).toBe(hourSlots(NOW).at(-5));
  });

  it('sums several sessions into one bucket and counts them', () => {
    const rows = [
      session({ id: 'a', started_at: NOW - 60, input_tokens: 10, api_call_count: 2 }),
      session({ id: 'b', started_at: NOW - 120, input_tokens: 5, api_call_count: 3 }),
    ];
    const last = hourlyBuckets(rows, NOW).at(-1)!;
    expect(last.total).toBe(15);
    expect(last.sessions).toBe(2);
    expect(last.api_calls).toBe(5);
  });

  it('drops anything older than the window instead of piling it on bucket zero', () => {
    const rows = [session({ started_at: NOW - 40 * HOUR, input_tokens: 1_000_000 })];
    expect(hourlyBuckets(rows, NOW).every((b) => b.total === 0)).toBe(true);
  });

  it('labels buckets by local hour of day', () => {
    const buckets = hourlyBuckets([], NOW);
    expect(buckets.at(-1)!.hour).toBe(new Date(NOW * 1000).getHours());
    expect(buckets.every((b) => b.hour >= 0 && b.hour <= 23)).toBe(true);
  });

  it('always returns 24 buckets, so an idle day still draws an axis', () => {
    expect(hourlyBuckets([], NOW)).toHaveLength(24);
  });
});

describe('daily gap filling', () => {
  const day = (d: string, input: number): UsageDay => ({
    day: d,
    input_tokens: input,
    output_tokens: 1,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    estimated_cost: 0,
    actual_cost: 0,
    sessions: 1,
    api_calls: 1,
  });

  /**
   * The API returns only days that saw traffic. Rendered as evenly-spaced
   * categories, a four-day silence became a single step and the line claimed
   * usage on days nothing happened.
   */
  it('puts idle days back as zeroes', () => {
    const out = fillDailyGaps([day('2026-08-10', 5), day('2026-08-14', 7)]);
    expect(out.map((d) => d.day)).toEqual(['08-10', '08-11', '08-12', '08-13', '08-14']);
    expect(out.map((d) => d.input)).toEqual([5, 0, 0, 0, 7]);
  });

  it('keeps only the last N points, which is what fits on a phone', () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      day(`2026-07-${String(i + 1).padStart(2, '0')}`, i),
    ).slice(0, 31);
    expect(fillDailyGaps(rows, 14)).toHaveLength(14);
    expect(fillDailyGaps(rows, 7)).toHaveLength(7);
  });

  it('has nothing to draw for an empty history', () => {
    expect(fillDailyGaps([])).toEqual([]);
  });
});

describe('whether cost means anything', () => {
  /**
   * The case that shaped the screen: a locally served model. Hermes has no
   * rate card for it, so it records tokens and leaves every cost field at
   * zero. Leading with money there produces a page of `$0.00` presented as
   * analytics.
   */
  it('is false when the provider is unpriced', () => {
    expect(hasCostSignal(totals({ total_input: 6_196_055, total_api_calls: 186 }))).toBe(false);
  });

  it('is true as soon as anything is estimated or billed', () => {
    expect(hasCostSignal(totals({ total_estimated_cost: 0.02 }))).toBe(true);
    expect(hasCostSignal(totals({ total_actual_cost: 1.5 }))).toBe(true);
  });

  it('is false before the totals arrive', () => {
    expect(hasCostSignal(undefined)).toBe(false);
  });
});

describe('what the bars leave out', () => {
  /**
   * `/api/sessions` is a conversation list: sub-agent runs are filtered out
   * upstream and compaction continuations are folded into their parent, with
   * no query parameter to open that up. The analytics totals have no such
   * filter, so the difference is real and worth naming.
   */
  it('reports the share the session list could not account for', () => {
    expect(unattributedShare(750, 1000)).toBeCloseTo(0.25);
  });

  it('claims nothing when the bars already cover the total', () => {
    expect(unattributedShare(1000, 1000)).toBe(0);
    expect(unattributedShare(1200, 1000)).toBe(0);
    expect(unattributedShare(0, 0)).toBe(0);
  });
});

describe('folding model rows', () => {
  const model = (over: Partial<ModelUsage>): ModelUsage => ({
    model: 'qwen3.8:27b-128k',
    provider: 'custom',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    sessions: 0,
    api_calls: 0,
    tool_calls: 0,
    last_used_at: null,
    estimated_cost: 0,
    actual_cost: 0,
    avg_tokens_per_session: 0,
    ...over,
  });

  /**
   * The endpoint appends one row per auxiliary task and then builds the
   * response without the `aux_task` key, so a model that also generated titles
   * and judged approvals arrives as three identical-looking rows. Four copies
   * of `qwen3.8:27b-128k` in the list read as a bug in this app.
   */
  it('sums the unlabelled auxiliary rows back into their model', () => {
    const out = foldModelRows([
      model({ input_tokens: 2_562_987, api_calls: 77, sessions: 8, avg_tokens_per_session: 320_000 }),
      model({ input_tokens: 13_080, api_calls: 13, sessions: 5 }),
      model({ input_tokens: 11_008, api_calls: 1, sessions: 1 }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]!.input_tokens).toBe(2_587_075);
    expect(out[0]!.api_calls).toBe(91);
  });

  /**
   * Auxiliary rows record a billing provider only sometimes, so folding on
   * model+provider alone leaves a second copy underneath the real one wearing
   * an empty provider string.
   */
  it('gives a providerless row to the model\'s only provider', () => {
    const out = foldModelRows([
      model({ model: 'ornith:35b', provider: 'custom', input_tokens: 1_500_000, api_calls: 49 }),
      model({ model: 'ornith:35b', provider: '', input_tokens: 701, api_calls: 1 }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]!.input_tokens).toBe(1_500_701);
    expect(out[0]!.api_calls).toBe(50);
  });

  it('folds a providerless row that arrives before its host', () => {
    const out = foldModelRows([
      model({ model: 'ornith:35b', provider: '', input_tokens: 701 }),
      model({ model: 'ornith:35b', provider: 'custom', input_tokens: 1000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.input_tokens).toBe(1701);
  });

  /**
   * Two providers means guessing would move usage from one to the other, so
   * the row stays where it is and the screen labels it.
   */
  it('leaves a providerless row alone when the model was served two ways', () => {
    const out = foldModelRows([
      model({ model: 'ornith:35b', provider: 'custom', input_tokens: 1000 }),
      model({ model: 'ornith:35b', provider: 'custom:remote', input_tokens: 500 }),
      model({ model: 'ornith:35b', provider: '', input_tokens: 9 }),
    ]);
    expect(out).toHaveLength(3);
    expect(out.find((m) => m.provider === '')!.input_tokens).toBe(9);
  });

  it('keeps the same model under two providers apart', () => {
    const out = foldModelRows([
      model({ input_tokens: 100, provider: 'custom' }),
      model({ input_tokens: 40, provider: 'custom:bigrig:11434' }),
    ]);
    expect(out.map((m) => m.provider)).toEqual(['custom', 'custom:bigrig:11434']);
  });

  /**
   * Session counts cannot be added across these rows: an auxiliary row counts
   * a session the main row already counted, so summing would halve the average
   * and make a model look like it uses far less of its window than it does.
   */
  it('does not add session counts, and keeps the dominant row\'s average', () => {
    const out = foldModelRows([
      model({ input_tokens: 900, sessions: 8, avg_tokens_per_session: 112 }),
      model({ input_tokens: 10, sessions: 5, avg_tokens_per_session: 2 }),
    ]);
    expect(out[0]!.sessions).toBe(8);
    expect(out[0]!.avg_tokens_per_session).toBe(112);
  });

  it('takes the most recent use across the rows', () => {
    const out = foldModelRows([
      model({ last_used_at: 100 }),
      model({ last_used_at: 500 }),
    ]);
    expect(out[0]!.last_used_at).toBe(500);
  });

  it('ranks by total tokens', () => {
    const out = foldModelRows([
      model({ model: 'small', input_tokens: 10 }),
      model({ model: 'big', input_tokens: 1000 }),
    ]);
    expect(out.map((m) => m.model)).toEqual(['big', 'small']);
  });
});

describe('plural', () => {
  it('counts one thing as singular', () => {
    expect(plural(1, 'call')).toBe('1 call');
    expect(plural(0, 'call')).toBe('0 calls');
    expect(plural(2, 'call')).toBe('2 calls');
  });
});

describe('grouping sessions', () => {
  it('ranks surfaces by tokens and counts conversations', () => {
    const rows = [
      session({ source: 'web', input_tokens: 100 }),
      session({ source: 'cron', input_tokens: 500 }),
      session({ source: 'web', input_tokens: 50, output_tokens: 10 }),
    ];
    expect(groupSessions(rows, 'source')).toEqual([
      { name: 'cron', tokens: 500, sessions: 1 },
      { name: 'web', tokens: 160, sessions: 2 },
    ]);
  });

  it('names the missing case rather than dropping it', () => {
    expect(groupSessions([session({ source: null, input_tokens: 3 })], 'source')).toEqual([
      { name: 'unknown', tokens: 3, sessions: 1 },
    ]);
  });
});

describe('tool names', () => {
  it('splits an MCP tool into server and tool', () => {
    expect(toolLabel('mcp__garmin__get_vo2max_trend')).toEqual({
      label: 'get_vo2max_trend',
      server: 'garmin',
    });
  });

  it('handles a server whose own name has underscores', () => {
    expect(toolLabel('mcp__google_calendar__list_events')).toEqual({
      label: 'list_events',
      server: 'google_calendar',
    });
  });

  it('leaves an ordinary tool alone', () => {
    expect(toolLabel('terminal')).toEqual({ label: 'terminal', server: null });
  });
});

describe('durations', () => {
  it.each([
    [42, '42s'],
    [60, '1m'],
    [3600, '1h'],
    [3660, '1h 1m'],
    [86_400 * 2 + 3600 * 3, '2d 3h'],
  ])('%i seconds reads as %s', (secs, want) => {
    expect(formatDuration(secs)).toBe(want);
  });

  it('says nothing for a session that has not ended', () => {
    expect(formatDuration(null)).toBe('');
  });
});

/**
 * Structural checks. The screen's value depends on Usage being the only place
 * these numbers are drawn — a chart that reappears on Models is a chart that
 * will disagree with this one the first time either changes.
 */
describe('where the screen lives', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

  /**
   * The screen is a section of Models now, not a destination of its own. The
   * route has to survive that: it is in the slash-command table, in
   * `HubRedirect`, and in whatever anyone bookmarked before the merge.
   */
  it('keeps /usage reachable, as a redirect rather than a drawer row', () => {
    expect(read('../src/App.tsx')).toContain('path="/usage"');
    expect(read('../src/App.tsx')).toContain('/models?tab=usage');
    expect(read('../src/components/shared/NavDrawer.tsx')).not.toContain("to: '/usage'");
    expect(read('../src/components/shared/NavDrawer.tsx')).toContain("to: '/models'");
  });

  /**
   * The charts weigh ~356 KB built, and Models is the screen you open to change
   * a model. A static import here would inline all of it into that navigation
   * without anything on screen looking different — so this checks the source
   * for the dynamic boundary, and for the two things that would mean the
   * report had been copied back in rather than mounted.
   */
  it('mounts the charts behind a dynamic import rather than inlining them', () => {
    const models = read('../src/components/hub/ModelsTab.tsx');
    expect(models).toContain("import('./UsageTab')");
    // Matched as an import rather than as the bare word: the file header names
    // recharts as the whole reason the boundary is there, and a check that
    // forbids saying so would be traded for a vaguer comment.
    expect(models).not.toMatch(/from 'recharts'/);
    expect(models).not.toMatch(/from '\.\.\/\.\.\/api\/hub'/);
  });

  it('still answers the old /hub?tab= links, including the new tab', () => {
    expect(read('../src/screens/HubPage.tsx')).toContain("'usage'");
  });
});

/**
 * The window fetch. Paging is where this goes wrong invisibly: stop too early
 * and the day is short by however much sat on page two; never stop and a phone
 * walks the entire history one hundred rows at a time.
 */
describe('fetching the window', () => {
  const since = NOW - 24 * HOUR;

  /** A page of `n` sessions, all inside the window unless `old` is set. */
  const page = (n: number, old = false) => ({
    sessions: Array.from({ length: n }, (_, i) =>
      session({ id: `s${i}`, started_at: old ? since - HOUR : NOW - i * 60 }),
    ),
    total: n,
    limit: 100,
    offset: 0,
  });

  it('stops at the first short page', async () => {
    const get = vi.fn().mockResolvedValue(page(3));
    const out = await fetchSessionsSince(since, get);

    expect(get).toHaveBeenCalledTimes(1);
    expect(out.rows).toHaveLength(3);
    expect(out.truncated).toBe(false);
  });

  it('asks for archived sessions, which still burned tokens', async () => {
    const get = vi.fn().mockResolvedValue(page(1));
    await fetchSessionsSince(since, get);
    expect(get.mock.calls[0]![0]).toContain('archived=include');
  });

  it('pages until a row falls out of the window, and keeps only what is inside', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(page(100))
      .mockResolvedValueOnce({ ...page(100), sessions: [...page(2).sessions, ...page(98, true).sessions] });

    const out = await fetchSessionsSince(since, get);

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1]![0]).toContain('offset=100');
    expect(out.rows).toHaveLength(102);
    expect(out.truncated).toBe(false);
  });

  /**
   * The ceiling matters more than the number: five round trips is already more
   * than a chart is worth on a phone, and the screen says so rather than
   * drawing a partial day as if it were whole.
   */
  it('gives up after the page ceiling and admits it', async () => {
    const get = vi.fn().mockResolvedValue(page(100));
    const out = await fetchSessionsSince(since, get);

    expect(get).toHaveBeenCalledTimes(MAX_WINDOW_PAGES);
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(100 * MAX_WINDOW_PAGES);
  });
});
