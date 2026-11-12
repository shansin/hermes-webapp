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
 *
 * It also carries the "Needs you" count — an approval parked in another
 * profile's session, a blocked card, a pairing request — as a number rather
 * than a dot. That one is a count because it is a to-do list: "2" is the
 * answer to "is there something I have to do", where unread updates only ever
 * need "there is something new". The needs-you badge wins the corner when
 * both apply; the drawer rows carry both numbers.
 *
 * It disappears entirely once the rail docks (`RAIL_QUERY`): `NavDrawer` is
 * part of the layout there, so the menu is already on screen and both counts
 * are already legible on their own rows.
 */
import { IconMenu } from './Icons';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';
import { useUnreadCount } from '../../api/notifications';
import { useNeedsYouCount } from '../../lib/useActivity';

/** The accessible name, naming whichever counts are non-zero. */
export function menuLabel(unread: number, needsYou: number): string {
  const parts = [
    needsYou ? `${needsYou} need${needsYou === 1 ? 's' : ''} you` : null,
    unread ? `${unread} unread update${unread === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return parts.length ? `Open menu — ${parts.join(', ')}` : 'Open menu';
}

export function MenuButton() {
  const setOpen = useUi((s) => s.setNavOpen);
  const unread = useUnreadCount();
  const needsYou = useNeedsYouCount();
  return (
    <button
      /* Hidden once the rail docks, where the drawer is open as part of the
         layout and there is nothing left for this to summon. */
      className="icon-btn menu-btn"
      aria-label={menuLabel(unread, needsYou)}
      style={{ flexShrink: 0, marginLeft: -4, position: 'relative' }}
      onClick={() => {
        buzz('tap');
        setOpen(true);
      }}
    >
      <IconMenu size={22} />
      {/* Needs-you as a number (see the note above); unread updates as a dot,
          because what that has to say from the corner of an eye is only
          "there is something new", and its number is on the drawer row. */}
      {needsYou > 0 ? (
        <span aria-hidden className="menu-btn__count">
          {needsYou > 9 ? '9+' : needsYou}
        </span>
      ) : unread > 0 && (
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
