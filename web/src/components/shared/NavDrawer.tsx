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
 */
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { NavLink } from 'react-router-dom';
import {
  IconChat,
  IconClose,
  IconCron,
  IconFolder,
  IconKanban,
  IconMemory,
  IconModels,
  IconProfiles,
  IconSessions,
  IconSettings,
  IconSkills,
} from './Icons';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';
import { useHistoryDismiss } from '../../lib/useHistoryDismiss';

/**
 * The Hub's six tabs used to hide behind a single "Hub" entry, which cost two
 * taps and a segmented control to reach any of them. They are top-level
 * destinations now — the drawer is the one surface with room for ten.
 *
 * Split into two groups so the configuration destinations read as a set rather
 * than as four more peers of Chat. Both groups carry a hint — ten of them run
 * past the fold on a short phone, which the list scrolls for.
 */
const WORK = [
  { to: '/chat', label: 'Chat', hint: 'Talk to the agent', Icon: IconChat },
  { to: '/sessions', label: 'Sessions', hint: 'History and search', Icon: IconSessions },
  { to: '/kanban', label: 'Kanban', hint: 'The task board', Icon: IconKanban },
  { to: '/files', label: 'Files', hint: 'Browse the workspace', Icon: IconFolder },
];

const SYSTEM = [
  { to: '/memory', label: 'Memory', hint: 'What the agent remembers', Icon: IconMemory },
  { to: '/skills', label: 'Skills', hint: 'Toggle, search, install', Icon: IconSkills },
  { to: '/cron', label: 'Cron', hint: 'Scheduled jobs', Icon: IconCron },
  { to: '/models', label: 'Models', hint: 'Active model and usage', Icon: IconModels },
  { to: '/profiles', label: 'Profiles', hint: 'Named configurations', Icon: IconProfiles },
  { to: '/settings', label: 'Settings', hint: 'Default model, theme, status', Icon: IconSettings },
];

/** How far the panel must be dragged left before it closes. */
const DISMISS_PX = 60;

export function NavDrawer() {
  const open = useUi((s) => s.navOpen);
  const setOpen = useUi((s) => s.setNavOpen);
  const connection = useUi((s) => s.connection);

  const [dragX, setDragX] = useState(0);
  const startX = useRef<number | null>(null);

  useHistoryDismiss(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
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
  }, [open, setOpen]);

  // Drop any leftover drag offset so the panel reopens square.
  useEffect(() => {
    if (open) setDragX(0);
  }, [open]);

  if (!open) return null;

  const close = () => {
    buzz('tap');
    setOpen(false);
  };

  return (
    <>
      <div className="drawer-backdrop" onClick={close} />
      <nav
        className="drawer"
        style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
        aria-label="Main navigation"
        onTouchStart={(e) => {
          startX.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchMove={(e) => {
          const x = e.touches[0]?.clientX;
          if (x == null || startX.current == null) return;
          // Only tracks leftward: dragging right would pull the panel off its
          // own edge, which has nowhere to go.
          setDragX(Math.min(0, x - startX.current));
        }}
        onTouchEnd={() => {
          if (dragX < -DISMISS_PX) close();
          else setDragX(0);
          startX.current = null;
        }}
      >
        <div className="drawer__head">
          <div>
            <div className="drawer__title">Hermes</div>
            <div className={`drawer__conn drawer__conn--${connection === 'open' ? 'on' : 'off'}`}>
              {connection === 'open' ? 'Connected' : 'Disconnected'}
            </div>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close menu">
            <IconClose size={19} />
          </button>
        </div>

        <div className="drawer__list">
          {WORK.map(({ to, label, hint, Icon }) => (
            <Item key={to} to={to} label={label} hint={hint} Icon={Icon} onNavigate={close} />
          ))}

          <div className="drawer__section">SYSTEM</div>

          {SYSTEM.map(({ to, label, hint, Icon }) => (
            <Item key={to} to={to} label={label} hint={hint} Icon={Icon} compact onNavigate={close} />
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
  onNavigate,
}: {
  to: string;
  label: string;
  hint?: string;
  Icon: ComponentType<{ size?: number }>;
  compact?: boolean;
  onNavigate: () => void;
}) {
  return (
    <NavLink
      to={to}
      // `replace` lands the new route *on* the drawer's sentinel entry rather
      // than after it. Pushing would strand the sentinel mid-stack, costing an
      // extra, invisible back press to get out of wherever you just went.
      replace
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
    </NavLink>
  );
}
