import { NavLink, useLocation } from 'react-router-dom';
import { IconChat, IconHub, IconKanban, IconSessions } from './Icons';
import { buzz } from '../../lib/haptics';

const TABS = [
  { to: '/chat', label: 'Chat', Icon: IconChat },
  { to: '/sessions', label: 'Sessions', Icon: IconSessions },
  { to: '/kanban', label: 'Kanban', Icon: IconKanban },
  { to: '/hub', label: 'Hub', Icon: IconHub },
];

export function TabBar() {
  const { pathname } = useLocation();

  return (
    <nav className="tabbar">
      {TABS.map(({ to, label, Icon }) => {
        const active = pathname.startsWith(to);
        return (
          <NavLink
            key={to}
            to={to}
            className={`tabbar__item${active ? ' tabbar__item--active' : ''}`}
            onClick={() => buzz('tap')}
          >
            <Icon size={21} />
            <span>{label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
