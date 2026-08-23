/**
 * Bucketing sessions into lanes.
 *
 * The property that matters is the one that fails quietly: a filter must never
 * make a session unreachable. An unrecognised `source` therefore lands in
 * "Mine" rather than nowhere — a wrong lane is visible, a missing row is not.
 */
import { describe, expect, it } from 'vitest';
import {
  FILTER_LABEL,
  SESSION_FILTERS,
  countByKind,
  isSessionFilter,
  kindOf,
  matchesFilter,
} from '../src/lib/sessionKinds';
import type { SessionRow } from '../src/api/sessions';

const row = (source: string | null): SessionRow =>
  ({ id: `s-${source}`, source, title: 't' }) as unknown as SessionRow;

describe('kindOf', () => {
  it('separates the two automated sources', () => {
    expect(kindOf('cron')).toBe('cron');
    expect(kindOf('kanban')).toBe('kanban');
  });

  it.each(['web', 'cli', 'tui', 'telegram', 'discord'])(
    '%s is a session you started',
    (source) => {
      expect(kindOf(source)).toBe('mine');
    },
  );

  /**
   * The rule this module exists for. A source Hermes adds later must not
   * disappear from the default view with nothing to explain where it went.
   */
  it('puts an unknown source in Mine rather than losing it', () => {
    expect(kindOf('slack')).toBe('mine');
    expect(kindOf('')).toBe('mine');
    expect(kindOf(null)).toBe('mine');
    expect(kindOf(undefined)).toBe('mine');
  });

  it('does not care about case', () => {
    expect(kindOf('CRON')).toBe('cron');
    expect(kindOf('Kanban')).toBe('kanban');
  });
});

describe('matchesFilter', () => {
  it('all keeps everything, including sources it has never heard of', () => {
    for (const source of ['web', 'cron', 'kanban', 'wormhole', null]) {
      expect(matchesFilter(row(source), 'all')).toBe(true);
    }
  });

  it('a lane keeps only its own', () => {
    expect(matchesFilter(row('cron'), 'cron')).toBe(true);
    expect(matchesFilter(row('web'), 'cron')).toBe(false);
    expect(matchesFilter(row('kanban'), 'mine')).toBe(false);
  });

  /** Every session is reachable from exactly one lane, or the rail lies. */
  it('sorts each session into exactly one lane', () => {
    const lanes = SESSION_FILTERS.filter((f) => f !== 'all');
    for (const source of ['web', 'cron', 'kanban', 'tui', 'mystery', null]) {
      const hits = lanes.filter((f) => matchesFilter(row(source), f));
      expect(hits, `source ${source}`).toHaveLength(1);
    }
  });
});

describe('countByKind', () => {
  it('counts each lane', () => {
    const counts = countByKind([
      row('web'),
      row('web'),
      row('cron'),
      row('kanban'),
      row('tui'),
      row(null),
    ]);
    expect(counts).toEqual({ mine: 4, cron: 1, kanban: 1 });
  });

  it('reports zeroes rather than gaps on an empty list', () => {
    expect(countByKind([])).toEqual({ mine: 0, cron: 0, kanban: 0 });
  });
});

describe('isSessionFilter', () => {
  it('accepts what the rail can render', () => {
    for (const f of SESSION_FILTERS) expect(isSessionFilter(f)).toBe(true);
  });

  /**
   * The guard on the stored preference. A stale or hand-edited value must not
   * leave the list filtered by a bucket no chip can turn off.
   */
  it('rejects anything else', () => {
    for (const v of ['', 'ALL', 'archived', 'mine ', 'cron;drop']) {
      expect(isSessionFilter(v)).toBe(false);
    }
  });

  it('has a label for every filter, so no chip renders blank', () => {
    for (const f of SESSION_FILTERS) expect(FILTER_LABEL[f]).toBeTruthy();
  });
});
