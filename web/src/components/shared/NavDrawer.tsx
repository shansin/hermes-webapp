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
 * Past `RAIL_QUERY` (portrait tablets up) the same list is *docked*: a permanent rail, no backdrop,
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
  IconAgent,
  IconBell,
  IconChat,
  IconClose,
  IconFolder,
  IconKanban,
  IconPlay,
  IconServer,
  IconSessions,
  IconSettings,
  IconUsage,
} from './Icons';
import { useUi } from '../../store/ui';
import { useUnreadCount } from '../../api/notifications';
import { useActiveProfile, useProfiles, useSwitchProfile } from '../../api/profiles';
import { useActivity, useNeedsYouCount } from '../../lib/useActivity';
import { SelectSheet } from './SelectSheet';
import { buzz } from '../../lib/haptics';
import { useHistoryDismiss } from '../../lib/useHistoryDismiss';
import { useRailLayout } from '../../lib/useMediaQuery';

/**
 * Ten destinations, down from thirteen.
 *
 * The Hub's tabs were promoted to top-level rows once, which cost nothing at
 * six and became the problem at thirteen: seven configuration rows under
 * SYSTEM, more than the working group above them, and the list ran past the
 * fold on every phone. They are grouped by *what they configure* now:
 *
 * - **Agent** is the agent itself — what it remembers, what it can do and
 *   reach, which named setup it runs as, which model. One screen, five tabs,
 *   the tab in `?tab=` (`screens/AgentScreen.tsx`).
 * - **Machine** is the box it runs on — health, messaging platforms and
 *   pairing, backups, logs.
 * - **Usage** and **Settings** stay their own rows: one is read rather than
 *   configured, the other is this app, not Hermes.
 *
 * Every old path still resolves — `/memory`, `/skills`, `/tools`, `/profiles`
 * and `/models` redirect into Agent, because slash commands, push payloads and
 * bookmarks hold them. Cron keeps its route and is reached from Updates
 * ("Schedules"): what Hermes reported and what it is going to do next are
 * read in the same place.
 *
 * Activity carries the needs-you count, not the running one: a running turn
 * needs nothing from you, and the badge is the one place an approval parked on
 * another profile can make itself seen.
 */
type Entry = {
  to: string;
  label: string;
  hint: string;
  Icon: ComponentType<{ size?: number }>;
  badge?: 'unread' | 'needs';
};

const WORK: Entry[] = [
  { to: '/chat', label: 'Chat', hint: 'Talk to the agent', Icon: IconChat },
  { to: '/sessions', label: 'Sessions', hint: 'History and search', Icon: IconSessions },
  {
    to: '/activity',
    label: 'Activity',
    hint: 'What needs you, and what is running',
    Icon: IconPlay,
    badge: 'needs',
  },
  { to: '/kanban', label: 'Kanban', hint: 'The task board', Icon: IconKanban },
  { to: '/files', label: 'Files', hint: 'Browse the workspace', Icon: IconFolder },
  {
    to: '/notifications',
    label: 'Updates',
    hint: 'What happened, and the schedules',
    Icon: IconBell,
    badge: 'unread',
  },
];

const SYSTEM: Entry[] = [
  { to: '/agent', label: 'Agent', hint: 'Memory, skills, tools, profiles, models', Icon: IconAgent },
  { to: '/machine', label: 'Machine', hint: 'Health, messaging, backups, logs', Icon: IconServer },
  { to: '/usage', label: 'Usage', hint: 'Where the tokens went', Icon: IconUsage },
  { to: '/settings', label: 'Settings', hint: 'Theme, notifications, status', Icon: IconSettings },
];

/** How far the panel must be dragged left before it closes. */
const DISMISS_PX = 60;

export function NavDrawer() {
  const docked = useRailLayout();
  const open = useUi((s) => s.navOpen);
  const setOpen = useUi((s) => s.setNavOpen);
  const connection = useUi((s) => s.connection);
  const unread = useUnreadCount();
  // Sessions only — the drawer must not make every screen poll the kanban
  // board and the cron list just to show a number. The needs-you count reads
  // the board's `/stats` instead, for the same reason.
  const { running } = useActivity(false);
  const needsYou = useNeedsYouCount();
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
  const profiles = useProfiles().data?.profiles ?? [];
  const switchProfile = useSwitchProfile();
  const toast = useUi((s) => s.toast);
  const [profileOpen, setProfileOpen] = useState(false);

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
            {/*
              The agent switcher. Switching swaps model, skills, memory and
              cron together, and until now nothing outside Profiles said which
              one was live — while Memory, Capabilities and Usage silently
              followed it. One row, only on multi-profile installs.
            */}
            {profiles.length > 1 && (
              <button
                type="button"
                className="chip"
                style={{ marginTop: 8 }}
                onClick={() => {
                  buzz('tap');
                  setProfileOpen(true);
                }}
                aria-label={`Switch agent, currently ${activeProfile.data?.active ?? 'active'}`}
              >
                ✻ {activeProfile.data?.active ?? '…'} · switch
              </button>
            )}
          </div>
          {/* Nothing to close when the rail is part of the layout. */}
          {!docked && (
            <button className="icon-btn" onClick={close} aria-label="Close menu">
              <IconClose size={19} />
            </button>
          )}
        </div>

        <div className="drawer__list">
          {WORK.map(({ to, label, hint, Icon, badge }) => (
            <Item
              key={to}
              to={to}
              label={label}
              /* The running count moves into the hint, where it stays true
                 without competing with the badge for "look at me". */
              hint={badge === 'needs' && running > 0 ? `${running} running` : hint}
              Icon={Icon}
              count={badge === 'unread' ? unread : badge === 'needs' ? needsYou : 0}
              countLabel={badge === 'needs' ? 'need you' : 'unread'}
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
      <SelectSheet
        open={profileOpen}
        title="Agent"
        options={profiles.map((p) => ({
          value: p.name,
          label: p.name,
          hint: p.name === activeProfile.data?.active ? 'The profile Hem is running as' : undefined,
          meta: p.name === activeProfile.data?.active ? 'active' : undefined,
        }))}
        value={activeProfile.data?.active ?? null}
        onChange={(name) => {
          if (name === activeProfile.data?.active) return;
          void switchProfile
            .mutateAsync(name)
            .then(() => toast(`Now running as ${name}`, 'success'))
            .catch((e) => toast(e instanceof Error ? e.message : 'Could not switch profile', 'error'));
        }}
        onClose={() => setProfileOpen(false)}
        empty="No profiles found."
      />
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
  countLabel = 'unread',
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
  /** What the count is of, for the screen reader: "3 unread", "2 need you". */
  countLabel?: string;
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
        <span className="drawer__badge">
          {/* Spoken in words: an `aria-label` on a plain span is ignored by
              most screen readers, which then read "3" with no noun. */}
          <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
          <span className="visually-hidden">
            {count} {countLabel}
          </span>
        </span>
      )}
    </NavLink>
  );
}
