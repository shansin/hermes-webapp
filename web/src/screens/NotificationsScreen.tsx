/**
 * Cron Notifications — a read-only transcript of every scheduled run.
 *
 * This reads like a conversation and is deliberately not one. Hermes owns
 * sessions and exposes no way to append a message to one, so there is nothing
 * upstream a feed like this could be written into; the entries come from the
 * proxy's own record (`server/src/push/feed.ts`), which is what stays awake
 * while the phone is asleep.
 *
 * That turns out to be the stronger way to build "a session you cannot send
 * to": there is no composer on this screen and no gateway session behind it,
 * so sending is not refused, it is absent. The one affordance each entry has
 * is the tap that carries you onward to the run itself.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MenuButton } from '../components/shared/MenuButton';
import { IconBack, IconTrash } from '../components/shared/Icons';
import { Empty, ErrorNote, SkeletonList, dayGroup, relTime } from '../components/shared/misc';
import { useClearNotifications, useNotifications, type NotificationEntry } from '../api/notifications';
import { useUi } from '../store/ui';
import { buzz } from '../lib/haptics';

/**
 * Group by day, newest first.
 *
 * The feed arrives newest-first and stays that way: unlike a chat, the thing
 * you want is the most recent run, and a transcript that has to be scrolled to
 * the bottom to be read is the wrong shape for a list nobody replies to.
 */
function groupByDay(entries: NotificationEntry[]): [string, NotificationEntry[]][] {
  const out: [string, NotificationEntry[]][] = [];
  for (const entry of entries) {
    // `dayGroup` counts in seconds; the feed stores milliseconds.
    const label = dayGroup(entry.at / 1000);
    const last = out[out.length - 1];
    if (last && last[0] === label) last[1].push(entry);
    else out.push([label, [entry]]);
  }
  return out;
}

export function NotificationsScreen() {
  const navigate = useNavigate();
  const toast = useUi((s) => s.toast);
  const { data, isLoading, error } = useNotifications();
  const clear = useClearNotifications();

  const groups = useMemo(() => groupByDay(data ?? []), [data]);

  return (
    <div className="screen">
      <div className="header">
        <MenuButton />
        {/* Same reasoning as `HubPage`: installed as a PWA there is no browser
            back gesture, and a push notification lands here with nothing
            behind it in the history stack. */}
        <button
          className="icon-btn"
          onClick={() => {
            buzz('tap');
            navigate('/chat');
          }}
          aria-label="Back to chat"
        >
          <IconBack size={19} />
        </button>
        <div className="header__title">Cron Notifications</div>
        {data && data.length > 0 && (
          <button
            className="icon-btn"
            onClick={async () => {
              buzz('tap');
              try {
                const { removed } = await clear.mutateAsync();
                toast(`Cleared ${removed} notification${removed === 1 ? '' : 's'}`, 'success');
              } catch (e) {
                toast(e instanceof Error ? e.message : 'Could not clear', 'error');
              }
            }}
            aria-label="Clear all notifications"
          >
            <IconTrash size={17} />
          </button>
        )}
      </div>

      <div className="chat__list">
        {isLoading ? (
          <SkeletonList n={4} h={54} />
        ) : error ? (
          <ErrorNote error={error} />
        ) : !data || data.length === 0 ? (
          <Empty
            icon="⏰"
            title="No scheduled runs yet"
            hint="When a cron job finishes, its reply posts here — even if the app was closed at the time."
          />
        ) : (
          groups.map(([label, entries]) => (
            <div key={label} style={{ display: 'contents' }}>
              <div className="msg-divider">{label}</div>
              {entries.map((entry) => (
                <Entry key={entry.id} entry={entry} onOpen={() => navigate(entry.url)} />
              ))}
            </div>
          ))
        )}
      </div>

      {/* Where the composer would be. Saying so is worth the strip of height:
          without it, a chat-shaped screen with nothing to type into reads as a
          bug rather than as a design. */}
      <div
        style={{
          padding: '10px 14px calc(10px + env(safe-area-inset-bottom))',
          borderTop: '1px solid var(--border-soft)',
          color: 'var(--text-faint)',
          fontSize: 12.5,
          textAlign: 'center',
        }}
      >
        Scheduled runs post here. Tap one to open its conversation.
      </div>
    </div>
  );
}

function Entry({ entry, onOpen }: { entry: NotificationEntry; onOpen: () => void }) {
  return (
    <div className="msg msg--assistant">
      <button
        className="msg__bubble msg__bubble--tappable"
        style={{
          background: 'var(--bg-elev-2)',
          borderRadius: '18px 18px 18px 5px',
          borderLeft: entry.failed ? '3px solid var(--error)' : '3px solid var(--ok)',
          width: '100%',
          maxWidth: '100%',
        }}
        onClick={() => {
          buzz('tap');
          onOpen();
        }}
      >
        {/* The job name heads the entry; the agent's own reply is the body.
            That ordering is the point of the screen — "Nightly digest" tells
            you which job, the reply tells you what it found. */}
        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-dim)' }}>{entry.title}</div>
        <div style={{ fontSize: 14.5, marginTop: 3, whiteSpace: 'pre-wrap' }}>{entry.body}</div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 6 }}>
          {entry.sessionId ? 'Tap to open the conversation' : 'Tap to open scheduled jobs'}
        </div>
      </button>
      <div className="msg__meta">
        <span>{relTime(entry.at / 1000)}</span>
        {entry.failed && entry.status && <span style={{ color: 'var(--error)' }}>{entry.status}</span>}
      </div>
    </div>
  );
}
