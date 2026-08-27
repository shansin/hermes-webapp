/**
 * The Activity pane's data: four sources, one list, kept fresh two ways.
 *
 * Polling is the backbone rather than the socket, for the reason given at the
 * top of `activity.ts` — work that started while the app was closed has to
 * show up too. But a poll alone feels dead: a delegation that finishes two
 * seconds after a refetch would sit there looking busy for the rest of the
 * interval. So the gateway socket is subscribed **unfiltered** and used purely
 * to invalidate early.
 *
 * Unfiltered is the unusual part. `store/session.ts` deliberately drops events
 * for any session other than the one on screen; this hook wants exactly the
 * ones it drops, because the whole point is work happening somewhere else.
 * `hermes.onEvent` hands over every event with its `session_id` intact, so no
 * server change is needed — the frames were always arriving.
 *
 * The delegation lane is the exception to both halves. It has no REST route
 * and no events of its own — a background child emits nothing until the batch
 * finishes — so there it really is only the poll, and `api/delegation.ts` sets
 * its own rate accordingly.
 */
import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useActiveSessionsAcrossProfiles } from '../api/sessions';
import { DELEGATION_KEY, useDelegations } from '../api/delegation';
import { useProfiles } from '../api/profiles';
import { useUi } from '../store/ui';
import { useBoard } from '../api/kanban';
import { useCronJobs } from '../api/hub';
import { hermes } from '../ws/client';
import {
  countRunning,
  fromCron,
  fromDelegations,
  fromKanban,
  fromSessions,
  mergeActivity,
  type ActivityItem,
} from './activity';

/**
 * Events that mean the picture just changed.
 *
 * `subagent.*` is the delegation case this pane exists for. The message
 * boundaries catch a turn starting or ending anywhere. `cron.changed` is the
 * gateway's "go and look" nudge, exactly as `push/cron.ts` treats it.
 */
const WATCHED = [
  'subagent.start',
  'subagent.complete',
  'message.start',
  'message.complete',
  'background.complete',
  'cron.changed',
];

/**
 * Everything in flight, plus what is queued.
 *
 * `full` is what separates the screen from the header pill. The pill needs a
 * count and should not make every screen in the app poll the kanban board and
 * the cron list, so it takes sessions only — which is the lane it exists for.
 * The screen takes all three.
 */
export function useActivity(full = true): {
  items: ActivityItem[];
  running: number;
  isLoading: boolean;
  error: unknown;
  /** Profiles beyond the fan-out cap, which are not being polled. */
  truncated: number;
} {
  const qc = useQueryClient();

  /**
   * Sessions come from every profile, because the other two sources already
   * do. The kanban board is one shared store and the cron list defaults to
   * `profile=all`, so leaving sessions on the active profile meant this pane
   * would show a card assigned to `research` while hiding the conversation it
   * was running in.
   *
   * Until the profile list arrives the fan-out queries once with no profile,
   * which addresses the active one — so the pane paints immediately rather
   * than waiting on a second request to say anything at all.
   */
  const profileList = useProfiles().data?.profiles;
  const names = useMemo(() => (profileList ?? []).map((p) => p.name), [profileList]);
  /**
   * Whether the early-invalidation half of this hook is actually working.
   *
   * The poll below slows down when it is, and only when it is: with the
   * socket down nothing invalidates these queries and the poll is the sole
   * source of liveness, which is what the fast rate was chosen for.
   */
  const socketLive = useUi((s) => s.connection) === 'open';
  const sessions = useActiveSessionsAcrossProfiles(names, 25, true, socketLive);
  const board = useBoard(full);
  const cron = useCronJobs();
  /* Not gated on `full`: a delegated child is the case the header pill is
     most often asked about, and it is one small socket call rather than the
     two REST lanes the pill deliberately skips. */
  const delegations = useDelegations();

  useEffect(
    () =>
      hermes.onEvent(({ type }) => {
        if (!WATCHED.includes(type)) return;
        void qc.invalidateQueries({ queryKey: ['sessions', 'recent'] });
        /* `background.complete` is the one event a background delegation ever
           emits, and it means every child in the batch has just stopped —
           exactly when leaving stale rows up would be most misleading. */
        void qc.invalidateQueries({ queryKey: DELEGATION_KEY });
        if (full) {
          void qc.invalidateQueries({ queryKey: ['kanban', 'board'] });
          if (type === 'cron.changed') void qc.invalidateQueries({ queryKey: ['cron'] });
        }
      }),
    [qc, full],
  );

  const items = useMemo(() => {
    // One clock for the whole pass, so two rows cannot disagree about now.
    const nowS = Date.now() / 1000;
    const groups = [fromSessions(sessions.sessions), fromDelegations(delegations.data?.active)];
    if (full) {
      groups.push(fromKanban(board.data?.columns, nowS));
      groups.push(fromCron(cron.data));
    }
    return mergeActivity(...groups);
  }, [sessions.sessions, delegations.data, board.data, cron.data, full]);

  return {
    items,
    running: countRunning(items),
    // Only the sessions query gates the first paint: the pane is useful the
    // moment it can say what the agent is doing, and waiting on the board and
    // the cron list to say so would be slower for no gain.
    isLoading: sessions.isLoading,
    error: sessions.error,
    truncated: sessions.truncated,
  };
}
