/**
 * The hamburger that opens the navigation drawer.
 *
 * Goes first in every screen's header. It lives in the header rather than
 * floating over the content so it can't cover a message, and so each screen
 * keeps one row of chrome instead of two.
 *
 * It also carries the unread dot for the Updates feed. That is here rather
 * than only on the drawer row because the drawer is closed almost all of the
 * time: a badge you have to open the menu to discover cannot tell you there is
 * something to discover. This button is the one piece of chrome on every
 * screen, so it is the only honest place for it.
 */
import { IconMenu } from './Icons';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';
import { useUnreadCount } from '../../api/notifications';

export function MenuButton() {
  const setOpen = useUi((s) => s.setNavOpen);
  const unread = useUnreadCount();
  return (
    <button
      className="icon-btn"
      aria-label={unread ? `Open menu — ${unread} unread update${unread === 1 ? '' : 's'}` : 'Open menu'}
      style={{ flexShrink: 0, marginLeft: -4, position: 'relative' }}
      onClick={() => {
        buzz('tap');
        setOpen(true);
      }}
    >
      <IconMenu size={22} />
      {/* A dot, not a count: the number belongs on the drawer row where there
          is room to read it, and what this has to say from the corner of an
          eye is only "there is something new". */}
      {unread > 0 && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 9,
            right: 9,
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--accent)',
            boxShadow: '0 0 0 2px var(--bg)',
          }}
        />
      )}
    </button>
  );
}
