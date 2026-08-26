/**
 * Navigation drawer — the app's primary navigation, opened by the hamburger in
 * each screen's header.
 *
 * This replaced a bottom tab bar. The trade is deliberate: a tab bar is one tap
 * to anywhere, but it costs ~64px of permanent height on every screen and stops
 * scaling past four or five destinations. A drawer gives the chat transcript
 * that height back and leaves room to grow.
 *
 * `NavLink` handles the active state; the drawer closes on navigate, backdrop
 * tap, Escape, a leftward drag on the panel itself, or the system back button.
 *
 * ## Two modes
 *
 * Past `WIDE_QUERY` the same list is *docked*: a permanent rail, no backdrop,
 * nothing to open or close. A modal drawer is the right answer when the panel
 * would cover most of the screen; on a 1400px window it covers a fifth of it,
 * and every navigation costs a tap to summon a menu there was always room to
 * show — while the screen it hides behind is mostly the empty space the phone
 * layout's single column leaves at that width.
 *
 * The mode is a render-time branch rather than a stylesheet rule because the
 * differences are behavioural, not visual: the docked rail must not lock body
 * scroll, must not trap Escape, must not track drags, and above all must not
 * push a history sentinel — a permanently-open overlay registering itself as
 * dismissable would eat the back button on every screen, for ever.
 */
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { NavLink } from 'react-router-dom';
import {
  IconBell,
  IconChat,
  IconClose,
  IconCron,
  IconFolder,
  IconKanban,
  IconPlay,
  IconMemory,
  IconModels,
  IconPlug,
  IconProfiles,
  IconSessions,
  IconSettings,
  IconSkills,
} from './Icons';
import { useUi } from '../../store/ui';
import { useUnreadCount } from '../../api/notifications';
import { useActiveProfile } from '../../api/profiles';
import { useActivity } from '../../lib/useActivity';
import { buzz } from '../../lib/haptics';
import { useHistoryDismiss } from '../../lib/useHistoryDismiss';
import { useWideLayout } from '../../lib/useMediaQuery';

/**
 * The Hub's six tabs used to hide behind a single "Hub" entry, which cost two
 * taps and a segmented control to reach any of them. They are top-level
 * destinations now — the drawer is the one surface with room for twelve.
 *
 * Split into two groups so the configuration destinations read as a set rather
 * than as more peers of Chat. Both groups carry a hint — twelve of them run
 * past the fold on a short phone, which the list scrolls for.
 *
 * Updates sits in the working group rather than under SYSTEM, next to Files:
 * what Hermes reported — a scheduled run, an announcement mid-turn, the
 * backend going away — is something you read, like a transcript, not something
 * you configure. The cron job list stays under SYSTEM, which is where the
 * schedules are actually managed.
 */
const WORK = [
  { to: '/chat', label: 'Chat', hint: 'Talk to the agent', Icon: IconChat },
  { to: '/sessions', label: 'Sessions', hint: 'History and search', Icon: IconSessions },
  { to: '/kanban', label: 'Kanban', hint: 'The task board', Icon: IconKanban },
  {
    to: '/activity',
    label: 'Activity',
    hint: 'What is running now',
    Icon: IconPlay,
    live: true,
  },
  { to: '/files', label: 'Files', hint: 'Browse the workspace', Icon: IconFolder },
  {
    to: '/notifications',
    label: 'Updates',
    hint: 'What happened while you were away',
    Icon: IconBell,
    badge: true,
  },
];

const SYSTEM = [
  { to: '/memory', label: 'Memory', hint: 'What the agent remembers', Icon: IconMemory },
  { to: '/skills', label: 'Skills', hint: 'Toggle, search, install', Icon: IconSkills },
  { to: '/cron', label: 'Cron', hint: 'Scheduled jobs', Icon: IconCron },
  { to: '/models', label: 'Models', hint: 'Defaults, and where the tokens went', Icon: IconModels },
  {
    to: '/tools',
    label: 'Capabilities',
    hint: 'Toolsets, MCP servers and config',
    Icon: IconPlug,
  },
  { to: '/profiles', label: 'Profiles', hint: 'Named configurations', Icon: IconProfiles },
  { to: '/settings', label: 'App settings', hint: 'Theme, notifications, status', Icon: IconSettings },
];

/** How far the panel must be dragged left before it closes. */
const DISMISS_PX = 60;

export function NavDrawer() {
  const docked = useWideLayout();
  const open = useUi((s) => s.navOpen);
  const setOpen = useUi((s) => s.setNavOpen);
  const connection = useUi((s) => s.connection);
  const unread = useUnreadCount();
  // Sessions only — the drawer must not make every screen poll the kanban
  // board and the cron list just to show a number.
  const { running } = useActivity(false);
  /**
   * Which profile is live.
   *
   * Switching one swaps the model, the skills, the memory and the cron jobs
   * together — `useSwitchProfile` invalidates the entire query cache for that
   * reason — and until now nothing outside the Profiles screen said which one
   * you were on. Already cached with a 30s staleTime, so this costs no request
   * on a normal open.
   */
  const activeProfile = useActiveProfile();

  const [dragX, setDragX] = useState(0);
  const startX = useRef<number | null>(null);

  useHistoryDismiss(open && !docked, () => setOpen(false));

  useEffect(() => {
    if (!open || docked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, docked, setOpen]);

  // Drop any leftover drag offset so the panel reopens square.
  useEffect(() => {
    if (open) setDragX(0);
  }, [open]);

  if (!open && !docked) return null;

  const close = () => {
    buzz('tap');
    setOpen(false);
  };

  /**
   * Closing is a no-op while docked, but the rail still calls it on navigate:
   * a window narrowed back to phone width must not reveal a drawer left open
   * from three navigations ago.
   */
  const onNavigate = docked ? () => setOpen(false) : close;

  return (
    <>
      {!docked && <div className="drawer-backdrop" onClick={close} />}
      <nav
        className={`drawer${docked ? ' drawer--docked' : ''}`}
        style={!docked && dragX ? { transform: `translateX(${dragX}px)` } : undefined}
        aria-label="Main navigation"
        onTouchStart={(e) => {
          if (docked) return;
          startX.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchMove={(e) => {
          if (docked) return;
          const x = e.touches[0]?.clientX;
          if (x == null || startX.current == null) return;
          // Only tracks leftward: dragging right would pull the panel off its
          // own edge, which has nowhere to go.
          setDragX(Math.min(0, x - startX.current));
        }}
        onTouchEnd={() => {
          if (docked) return;
          if (dragX < -DISMISS_PX) close();
          else setDragX(0);
          startX.current = null;
        }}
      >
        <div className="drawer__head">
          <div>
            <div className="drawer__title">Hem</div>
            <div className={`drawer__conn drawer__conn--${connection === 'open' ? 'on' : 'off'}`}>
              {connection === 'open' ? 'Connected' : 'Disconnected'}
              {/* Only when it is not the stock profile: naming `default` on
                  every open is noise for anyone who never made a second one. */}
              {activeProfile.data?.active && activeProfile.data.active !== 'default' && (
                <span className="drawer__profile"> · {activeProfile.data.active}</span>
              )}
            </div>
          </div>
          {/* Nothing to close when the rail is part of the layout. */}
          {!docked && (
            <button className="icon-btn" onClick={close} aria-label="Close menu">
              <IconClose size={19} />
            </button>
          )}
        </div>

        <div className="drawer__list">
          {WORK.map(({ to, label, hint, Icon, badge, live }) => (
            <Item
              key={to}
              to={to}
              label={label}
              hint={hint}
              Icon={Icon}
              count={badge ? unread : live ? running : 0}
              onNavigate={onNavigate}
              replaceEntry={!docked}
            />
          ))}

          <div className="drawer__section">SYSTEM</div>

          {SYSTEM.map(({ to, label, hint, Icon }) => (
            <Item key={to} to={to} label={label} hint={hint} Icon={Icon} compact onNavigate={onNavigate} replaceEntry={!docked} />
          ))}
        </div>
      </nav>
    </>
  );
}

function Item({
  to,
  label,
  hint,
  Icon,
  compact = false,
  count = 0,
  onNavigate,
  replaceEntry,
}: {
  to: string;
  label: string;
  hint?: string;
  Icon: ComponentType<{ size?: number }>;
  compact?: boolean;
  /** Unread badge. Zero renders nothing rather than a "0" pill. */
  count?: number;
  onNavigate: () => void;
  /** See the note on `replace` below. False for the docked rail. */
  replaceEntry: boolean;
}) {
  return (
    <NavLink
      to={to}
      /* `replace` lands the new route *on* the drawer's sentinel entry rather
         than after it. Pushing would strand the sentinel mid-stack, costing an
         extra, invisible back press to get out of wherever you just went.

         The docked rail pushes instead, because it has no sentinel to land on:
         replacing there would mean navigating the whole app without ever
         growing the history stack, and the header's back button — which reads
         that stack — would be dead on every screen. */
      replace={replaceEntry}
      className={({ isActive }) =>
        `drawer__item${compact ? ' drawer__item--compact' : ''}${
          isActive ? ' drawer__item--active' : ''
        }`
      }
      onClick={() => {
        buzz('tap');
        onNavigate();
      }}
    >
      <span className="drawer__icon">
        <Icon size={21} />
      </span>
      <span className="drawer__main">
        <span className="drawer__label">{label}</span>
        {hint && <span className="drawer__hint">{hint}</span>}
      </span>
      {/* The number lives here, where there is room to read it — the dot on
          the hamburger only says that there is one. Capped so a feed left
          unread for a month does not widen the row. */}
      {count > 0 && (
        <span className="drawer__badge" aria-label={`${count} unread`}>
          {count > 99 ? '99+' : count}
        </span>
      )}
    </NavLink>
  );
}
