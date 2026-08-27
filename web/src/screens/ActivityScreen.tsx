/**
 * Activity — what Hermes is doing right now, and what is queued behind it.
 *
 * The screen you open when a session kicked off a `delegate_task` and you have
 * no idea how it is going. Four lanes land here: sessions with a turn in
 * flight (carrying their own progress line), the delegated children those
 * turns dispatched — one row each, since a session running three researchers
 * is four things working — kanban workers, and cron. See `lib/activity.ts` for
 * why most of the data comes over REST rather than off the socket, and
 * `api/delegation.ts` for why the delegation lane is the exception.
 *
 * Read-only by design, like the Updates feed: every row is a way *into* the
 * thing it describes, not a control for it. Stopping a run belongs in the
 * conversation or on the board, where the context to decide is.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProfiles } from '../api/profiles';
import { ACTIVITY_PROFILE_CAP } from '../api/sessions';
import { DELEGATION_KEY } from '../api/delegation';

import { MenuButton } from '../components/shared/MenuButton';
import { BackButton } from '../components/shared/BackButton';
import { PullToRefresh } from '../components/shared/PullToRefresh';
import { Empty, ErrorNote, SkeletonList, relTime } from '../components/shared/misc';
import { useActivity } from '../lib/useActivity';
import { isQuiet, quietFor, type ActivityItem } from '../lib/activity';
import { buzz } from '../lib/haptics';
import { useQueryClient } from '@tanstack/react-query';

const KIND_ICON: Record<ActivityItem['kind'], string> = {
  session: '✻',
  subagent: '⑃',
  kanban: '▤',
  cron: '⏰',
};

/**
 * "in 6h" for something due later.
 *
 * `relTime` measures into the past and collapses anything under a minute to
 * "now" — which for a future timestamp means a cron job due at nine tonight
 * reads as due this instant. Queued rows need the other direction.
 */
function untilTime(epochSeconds: number | null): string {
  if (epochSeconds == null) return 'queued';
  const diff = epochSeconds - Date.now() / 1000;
  if (diff <= 0) return 'due now';
  if (diff < 60) return 'in under a minute';
  if (diff < 3600) return `in ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `in ${Math.floor(diff / 3600)}h`;
  return `in ${Math.floor(diff / 86400)}d`;
}

/**
 * A clock that ticks while the screen is open.
 *
 * The rows say how long something has been quiet, which is only true at the
 * moment it renders — without this a row frozen at "no update in 2m" while the
 * agent has actually been silent for ten is worse than saying nothing.
 */
function useNowSeconds(active: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 5_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function ActivityScreen() {
  const navigate = useNavigate();
  /* One profile means every row has the same owner, and a pill repeating it on
     each line is furniture. */
  const showOwner = (useProfiles().data?.profiles?.length ?? 1) > 1;
  const qc = useQueryClient();
  const { items, running, isLoading, error, truncated } = useActivity(true);
  const nowS = useNowSeconds(items.length > 0);

  const live = items.filter((i) => i.state !== 'queued');
  const queued = items.filter((i) => i.state === 'queued');

  return (
    <div className="screen">
      <div className="header">
        <MenuButton />
        <BackButton />
        <div className="header__title">
          Activity
          {running > 0 && <span className="header__sub"> · {running} running</span>}
        </div>
      </div>

      {/* Said out loud rather than left as a quiet omission: a pane whose whole
          job is "everything in flight" must not silently stop covering some of
          it as profiles accumulate. */}
      {truncated > 0 && (
        <div
          role="status"
          style={{
            padding: '8px 14px',
            fontSize: 'var(--type-body-sm)',
            color: 'var(--warn)',
            borderBottom: '1px solid var(--border-soft)',
          }}
        >
          {truncated} more profile{truncated === 1 ? '' : 's'} not polled — this pane covers the
          first {ACTIVITY_PROFILE_CAP}.
        </div>
      )}

      {isLoading && items.length === 0 ? (
        <SkeletonList n={4} h={58} />
      ) : error ? (
        <ErrorNote error={error} />
      ) : (
        <PullToRefresh
          onRefresh={async () => {
            await Promise.all([
              qc.invalidateQueries({ queryKey: ['sessions', 'recent'] }),
              qc.invalidateQueries({ queryKey: DELEGATION_KEY }),
              qc.invalidateQueries({ queryKey: ['kanban', 'board'] }),
              qc.invalidateQueries({ queryKey: ['cron'] }),
            ]);
          }}
        >
          {items.length === 0 ? (
            <Empty
              icon="😴"
              title="Nothing running"
              hint="Delegated tasks, kanban workers and cron jobs show up here while they work — including ones that started while the app was closed."
            />
          ) : (
            <div className="chat__list">
              {live.length > 0 && <div className="msg-divider">Now</div>}
              {live.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  nowS={nowS}
                  showOwner={showOwner}
                  onOpen={() => {
                    buzz('tap');
                    navigate(item.url);
                  }}
                />
              ))}

              {queued.length > 0 && <div className="msg-divider">Next</div>}
              {queued.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  nowS={nowS}
                  showOwner={showOwner}
                  onOpen={() => {
                    buzz('tap');
                    navigate(item.url);
                  }}
                />
              ))}
            </div>
          )}
        </PullToRefresh>
      )}
    </div>
  );
}

function Row({
  item,
  nowS,
  onOpen,
  showOwner,
}: {
  item: ActivityItem;
  nowS: number;
  onOpen: () => void;
  /** Only once there is more than one profile to tell apart. */
  showOwner: boolean;
}) {
  const quiet = item.state === 'running' && isQuiet(item, nowS);
  const seconds = quietFor(item, nowS);

  return (
    <button className="activity" onClick={onOpen}>
      <span className="activity__icon" aria-hidden>
        {item.state === 'running' && !quiet ? (
          <span className="tool__pulse" />
        ) : (
          KIND_ICON[item.kind]
        )}
      </span>
      <span className="activity__main">
        <span className="activity__title">{item.title}</span>
        {item.detail && <span className="activity__detail">{item.detail}</span>}
        <span className="activity__meta">
          {/* Which agent this is. All three sources here span profiles, so a
              row saying "running" is close to useless when it could equally be
              the research agent or the one you are talking to. */}
          {showOwner && item.owner && (
            <span className="tool-pill" style={{ marginRight: 7 }}>
              {item.owner}
            </span>
          )}
          {item.state === 'queued'
            ? untilTime(item.since)
            : /* Running rows say when they last moved rather than how long
                 they have run: "started 40m ago" is reassuring about a job
                 that died 39 minutes in. A delegated child is the one source
                 with no last-activity clock at all, so it says the honest
                 thing instead of dressing a start time up as a heartbeat. */
              item.sinceIsStart
              ? `running ${relTime(item.since)}`
              : (item.note ??
                (seconds == null
                  ? 'running'
                  : quiet
                    ? `no update in ${relTime(item.since)}`
                    : `updated ${relTime(item.since)}`))}
        </span>
      </span>
    </button>
  );
}
