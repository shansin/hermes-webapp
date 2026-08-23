/**
 * Which bucket a session belongs to on the Sessions screen.
 *
 * The list mixes three kinds of thing that have nothing to do with each other:
 * conversations you started, scheduled runs firing on their own, and workers
 * the kanban dispatcher spawned. On a busy machine the automated two bury the
 * one you came looking for — 15 cron runs and a pair of kanban workers between
 * you and yesterday's chat.
 *
 * `source` already separates them cleanly (`web`, `cli`, `tui`, `telegram`,
 * `discord`, `cron`, `kanban`), so this is only a naming of the groups a
 * person actually thinks in.
 *
 * The one rule worth stating: **an unrecognised source counts as yours.** A
 * filter that hides what it does not recognise loses sessions silently, and a
 * source added by a future Hermes would vanish from the default view with
 * nothing to explain it. Landing in "Mine" is wrong in a way you can see.
 */
import type { SessionRow } from '../api/sessions';

export type SessionKind = 'mine' | 'cron' | 'kanban';
export type SessionFilter = 'all' | SessionKind;

export const SESSION_FILTERS: readonly SessionFilter[] = ['all', 'mine', 'cron', 'kanban'];

export const FILTER_LABEL: Record<SessionFilter, string> = {
  all: 'All',
  mine: 'Mine',
  cron: 'Cron',
  kanban: 'Kanban',
};

export function isSessionFilter(value: string): value is SessionFilter {
  return (SESSION_FILTERS as readonly string[]).includes(value);
}

/** Everything a person started, whichever surface they started it from. */
export function kindOf(source: string | null | undefined): SessionKind {
  const s = (source ?? '').toLowerCase();
  if (s === 'cron') return 'cron';
  if (s === 'kanban') return 'kanban';
  return 'mine';
}

export function matchesFilter(session: SessionRow, filter: SessionFilter): boolean {
  return filter === 'all' || kindOf(session.source) === filter;
}

/**
 * How many sessions fall in each bucket.
 *
 * Drives both the counts on the chips and which chips are worth rendering at
 * all — a machine that has never run a kanban task should not carry a "Kanban
 * 0" chip across the top of its list forever.
 */
export function countByKind(sessions: readonly SessionRow[]): Record<SessionKind, number> {
  const counts: Record<SessionKind, number> = { mine: 0, cron: 0, kanban: 0 };
  for (const s of sessions) counts[kindOf(s.source)]++;
  return counts;
}
