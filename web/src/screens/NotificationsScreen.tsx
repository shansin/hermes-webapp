/**
 * Updates — a read-only channel carrying everything Hermes reports.
 *
 * Three sources write to it, and the chip on each row says which: a scheduled
 * run finishing, the agent announcing something mid-turn, and the proxy's own
 * report on the backend going away and coming back. What they have in common
 * is that all three happen while nobody is looking, which is the whole reason
 * they are written down rather than only pushed.
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
 * is the tap that carries you onward — to the run, the conversation, or the
 * status the row is about.
 *
 * The route is `/notifications` and stays that way despite the rename. Every
 * push payload already sitting on a phone points at it, as does the `url` of
 * every entry written before the rename; `/updates` is an alias for the sake
 * of the address bar. Changing the canonical path would strand both.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MenuButton } from '../components/shared/MenuButton';
import { IconBack, IconTrash } from '../components/shared/Icons';
import { Empty, ErrorNote, SkeletonList, dayGroup, relTime } from '../components/shared/misc';
import {
  useClearNotifications,
  useMarkNotificationsRead,
  useNotifications,
  type NotificationEntry,
} from '../api/notifications';
import { useUi } from '../store/ui';
import { buzz } from '../lib/haptics';
import { Markdown } from '../components/chat/MarkdownAsync';

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

/**
 * How each source announces itself, and how each severity reads.
 *
 * The icons are the vocabulary already used for session sources in
 * `components/sessions/SessionRow.tsx`, so a cron row looks like a cron row
 * wherever you meet one.
 */
const SOURCE_CHIP: Record<NotificationEntry['source'], { icon: string; label: string }> = {
  cron: { icon: '⏰', label: 'Scheduled' },
  agent: { icon: '✻', label: 'Agent' },
  system: { icon: '⚙', label: 'System' },
};

const SEVERITY_COLOR: Record<NotificationEntry['severity'], string> = {
  ok: 'var(--ok)',
  info: 'var(--info)',
  warn: 'var(--warn)',
  error: 'var(--error)',
};

export function NotificationsScreen() {
  const navigate = useNavigate();
  const toast = useUi((s) => s.toast);
  const { data, isLoading, error } = useNotifications();
  const clear = useClearNotifications();
  const markRead = useMarkNotificationsRead();

  const groups = useMemo(() => groupByDay(data ?? []), [data]);

  /**
   * Opening the screen is what clears the badge.
   *
   * Keyed on the newest entry rather than firing once on mount: something
   * landing while the screen is already open has been seen too, and leaving
   * the badge lit behind it would mean tapping into a screen you are looking
   * at to dismiss a count for a row already on it. `mutate` is deliberately
   * fire-and-forget — a failed mark-read costs a stale badge until the next
   * visit, which is not worth a toast.
   */
  const newest = data?.[0]?.at ?? 0;
  useEffect(() => {
    if (newest) markRead.mutate();
    // `markRead` is a fresh object each render; the newest entry is the signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newest]);

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
        <div className="header__title">Updates</div>
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
            icon="📣"
            title="Nothing to report yet"
            hint="Scheduled runs, anything the agent wants to tell you, and the backend going up or down all post here — even if the app was closed at the time."
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
        Everything Hermes reports posts here. Tap a row to open what it is about.
      </div>
    </div>
  );
}

/**
 * How many lines of a reply the card shows before it clamps.
 *
 * The feed stores the whole thing now, and a nightly digest runs to several
 * thousand characters — enough to bury every other row in the list. Ten lines
 * is more than a lock screen ever showed and still leaves the feed scannable;
 * the rest is one tap away, and nothing is unreachable.
 */
const CLAMP_LINES = 10;

/**
 * Whether this click was someone reading rather than navigating.
 *
 * The card opens its conversation when tapped, but the body is real markdown
 * now: links, code blocks and their copy buttons all live inside it, and a tap
 * on any of those means what it says, not "leave this screen". Dragging out a
 * selection then releasing is the same — it ends in a click the card would
 * otherwise answer by navigating away from the text just selected.
 */
function isReadingGesture(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (el?.closest('a, button, pre, code, .code')) return true;
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed;
}

function Entry({ entry, onOpen }: { entry: NotificationEntry; onOpen: () => void }) {
  const chip = SOURCE_CHIP[entry.source] ?? SOURCE_CHIP.cron;
  // Old rows predate `severity`; the server fills it in from `failed` on read,
  // and this is the belt for a response that somehow arrives without it.
  const accent = SEVERITY_COLOR[entry.severity] ?? (entry.failed ? 'var(--error)' : 'var(--ok)');

  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  /**
   * Whether there is anything hidden to reveal.
   *
   * Measured rather than guessed from the character count: what overflows ten
   * lines depends on the font, the viewport and where the words break — and
   * with markdown it also depends on how tall the headings and lists render.
   * A "Show more" that reveals nothing is worse than no button at all. Sticky
   * once true, because an expanded element no longer overflows and would
   * otherwise remove the control needed to collapse it again.
   */
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    if (expanded) return;
    const el = bodyRef.current;
    if (!el) return;

    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();

    /**
     * Markdown arrives in two stages — raw text while the renderer chunk is in
     * flight, then the real thing — and the two are different heights. Without
     * re-measuring, a card whose plain-text fallback happened to fit keeps no
     * "Show more" once the rendered version overflows.
     */
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [entry.body, expanded]);

  const openHint = entry.sessionId
    ? 'Open the conversation'
    : entry.source === 'system'
      ? 'Open status'
      : 'Open scheduled jobs';

  return (
    <div className="msg msg--assistant">
      {/*
        A div rather than a button, unlike every other tappable bubble in the
        app. The body renders markdown, so it contains links and the code
        blocks' own copy buttons — interactive elements a button may not
        legally hold, and whose taps must not be swallowed by the card. The
        keyboard path is the real button in the footer.
      */}
      <div
        className="msg__bubble feed-card"
        style={{
          background: 'var(--bg-elev-2)',
          borderRadius: '18px 18px 18px 5px',
          borderLeft: `3px solid ${accent}`,
          width: '100%',
          maxWidth: '100%',
        }}
        onClick={(e) => {
          if (isReadingGesture(e.target)) return;
          buzz('tap');
          onOpen();
        }}
      >
        {/* The source chip, then the title, then the words. The chip is what
            makes a mixed feed legible: "Hermes" heading a row means something
            different when the agent said it than when the proxy did. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            fontWeight: 600,
            fontSize: 13,
            color: 'var(--text-dim)',
          }}
        >
          <span aria-label={chip.label} title={chip.label} style={{ fontSize: 12 }}>
            {chip.icon}
          </span>
          <span>{entry.title}</span>
        </div>
        <div
          ref={bodyRef}
          className={`feed-body${expanded ? ' feed-body--open' : ''}${
            !expanded && overflows ? ' feed-body--faded' : ''
          }`}
          style={{ ['--feed-clamp' as string]: CLAMP_LINES }}
        >
          <Markdown>{entry.body}</Markdown>
        </div>
        <button type="button" className="feed-open" onClick={onOpen}>
          {openHint}
        </button>
      </div>
      <div className="msg__meta">
        <span>{relTime(entry.at / 1000)}</span>
        {overflows && (
          <button
            type="button"
            className="feed-more"
            aria-expanded={expanded}
            onClick={() => {
              buzz('tap');
              setExpanded((v) => !v);
            }}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        {entry.failed && entry.status && <span style={{ color: 'var(--error)' }}>{entry.status}</span>}
      </div>
    </div>
  );
}
