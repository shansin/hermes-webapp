/**
 * Chrome for the former Hub tabs, now that each is its own destination.
 *
 * They were a segmented control inside one screen; the drawer replaced that
 * control, so all they need is the standard header and a scroll container. The
 * tab components themselves are unchanged.
 */
import type { ReactNode } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { MenuButton } from '../components/shared/MenuButton';
import { IconBack } from '../components/shared/Icons';
import { buzz } from '../lib/haptics';

export function HubPage({ title, children }: { title: string; children: ReactNode }) {
  const navigate = useNavigate();
  /**
   * React Router names the first entry of a session `default`. Landing here
   * directly — a bookmark, a home-screen shortcut, a push notification — means
   * there is nothing behind us, and `navigate(-1)` would walk out of the app.
   */
  const isEntryPoint = useLocation().key === 'default';

  return (
    <div className="screen">
      <div className="header">
        <MenuButton />
        {/* Installed as a PWA the app runs in `display: standalone`, where iOS
            shows no browser chrome and offers no back gesture at all. The
            drawer still reaches everything, so these screens were never
            stranded — but without this there was no way to simply go back to
            wherever you came from. */}
        <button
          className="icon-btn"
          onClick={() => {
            buzz('tap');
            if (isEntryPoint) navigate('/chat');
            else navigate(-1);
          }}
          aria-label="Back"
        >
          <IconBack size={19} />
        </button>
        <div className="header__title">{title}</div>
      </div>
      <div className="scroll">{children}</div>
    </div>
  );
}

/**
 * `/hub?tab=cron` → `/cron`.
 *
 * Kept because those URLs outlive the change: they are in the slash-command
 * table, in anything the user bookmarked, and in the share/shortcut targets a
 * home-screen install may already hold.
 */
export function HubRedirect() {
  const [params] = useSearchParams();
  const tab = params.get('tab');
  const known = ['memory', 'skills', 'cron', 'models', 'usage', 'profiles', 'settings'];
  return <Navigate to={tab && known.includes(tab) ? `/${tab}` : '/memory'} replace />;
}
