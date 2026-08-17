/**
 * The hamburger that opens the navigation drawer.
 *
 * Goes first in every screen's header. It lives in the header rather than
 * floating over the content so it can't cover a message, and so each screen
 * keeps one row of chrome instead of two.
 */
import { IconMenu } from './Icons';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

export function MenuButton() {
  const setOpen = useUi((s) => s.setNavOpen);
  return (
    <button
      className="icon-btn"
      aria-label="Open menu"
      style={{ flexShrink: 0, marginLeft: -4 }}
      onClick={() => {
        buzz('tap');
        setOpen(true);
      }}
    >
      <IconMenu size={22} />
    </button>
  );
}
