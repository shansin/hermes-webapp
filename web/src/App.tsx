/**
 * App shell: routes, the navigation drawer, the connection banner, and the
 * single place the gateway socket is opened.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ChatScreen } from './screens/ChatScreen';
import { HubPage, HubRedirect } from './screens/HubPage';
import {
  onAccessExpired,
  isAccessExpired,
  goToAccessLogin,
  onHostReachabilityChange,
  isHostUnreachable,
  stripLoginMarker,
} from './lib/accessSession';

/**
 * Everything except chat is split out of the initial download.
 *
 * The app opens on `/chat`, and a phone on Wi-Fi pays for every byte before
 * first paint. Statically importing all of these put the whole app — including
 * recharts, which only the usage section of Models uses, and which is one of
 * the largest things we ship — into the boot graph. Each of these now arrives
 * on the navigation that needs it.
 *
 * `ChatScreen` stays eager on purpose: it is the landing route, so deferring
 * it would only add a round trip to the one screen that must be instant.
 */
const SessionsScreen = lazy(() =>
  import('./screens/SessionsScreen').then((m) => ({ default: m.SessionsScreen })),
);
const KanbanScreen = lazy(() =>
  import('./screens/KanbanScreen').then((m) => ({ default: m.KanbanScreen })),
);
const ActivityScreen = lazy(() =>
  import('./screens/ActivityScreen').then((m) => ({ default: m.ActivityScreen })),
);
const FilesScreen = lazy(() =>
  import('./screens/FilesScreen').then((m) => ({ default: m.FilesScreen })),
);
const NotificationsScreen = lazy(() =>
  import('./screens/NotificationsScreen').then((m) => ({ default: m.NotificationsScreen })),
);
const MemoryTab = lazy(() =>
  import('./components/hub/MemoryTab').then((m) => ({ default: m.MemoryTab })),
);
const SkillsTab = lazy(() =>
  import('./components/hub/SkillsTab').then((m) => ({ default: m.SkillsTab })),
);
const CronTab = lazy(() => import('./components/hub/CronTab').then((m) => ({ default: m.CronTab })));
const ModelsTab = lazy(() =>
  import('./components/hub/ModelsTab').then((m) => ({ default: m.ModelsTab })),
);
const ProfilesTab = lazy(() =>
  import('./components/hub/ProfilesTab').then((m) => ({ default: m.ProfilesTab })),
);
const CapabilitiesTab = lazy(() =>
  import('./components/tools/CapabilitiesTab').then((m) => ({ default: m.CapabilitiesTab })),
);
const SettingsTab = lazy(() =>
  import('./components/hub/SettingsTab').then((m) => ({ default: m.SettingsTab })),
);
import { NavDrawer } from './components/shared/NavDrawer';
import { ApprovalSheet } from './components/chat/ApprovalSheet';
import { ClarifySheet } from './components/chat/ClarifySheet';
import { SkeletonList, Toasts } from './components/shared/misc';
import { MenuButton } from './components/shared/MenuButton';
import { useUi } from './store/ui';
import { preloadMarkdown } from './components/chat/MarkdownAsync';
import { hermes, defaultWsUrl } from './ws/client';
import { useCronFeedToasts, useEventToasts } from './lib/useEventToasts';
import { flushUndoables } from './lib/undo';

/**
 * How long a connection may be down before the banner says so.
 *
 * Every cold start passes through `connecting`, and reconnects after a
 * backgrounded phone wakes are usually over in well under a second — so
 * showing the banner the instant state leaves `open` meant a red bar flashing
 * on launch and on every return to the app. The delay costs nothing: a drop
 * that matters lasts longer than this, and one that doesn't never needed
 * reporting.
 */
const BANNER_DELAY_MS = 700;

export function App() {
  const connection = useUi((s) => s.connection);
  const setConnection = useUi((s) => s.setConnection);
  const token = useUi((s) => s.token);
  const [showBanner, setShowBanner] = useState(false);

  // Warm the markdown chunk while the socket is still connecting, so the first
  // assistant message doesn't wait on it.
  useEffect(preloadMarkdown, []);

  // Open the socket once for the app's lifetime and mirror its state into the
  // UI store so any screen can react to a drop.
  const [accessExpired, setAccessExpired] = useState(isAccessExpired);

  /**
   * A returning login leaves `?cf_login=` in the address bar — it exists only
   * to get the navigation past the service worker. Clear it once we are back,
   * so it does not end up bookmarked or shared.
   */
  useEffect(() => {
    stripLoginMarker();
    return onAccessExpired(() => setAccessExpired(true));
  }, []);

  const [hostUnreachable, setHostUnreachable] = useState(isHostUnreachable);
  useEffect(() => onHostReachabilityChange(setHostUnreachable), []);

  useEffect(() => {
    const off = hermes.onState(setConnection);
    hermes.setUrl(defaultWsUrl(token || undefined));
    hermes.connect();
    return () => {
      off();
    };
  }, [token, setConnection]);

  // A phone suspends the socket when the app is backgrounded; nudge it awake.
  // `resume` restarts the backoff — the delay computed while the app sat in a
  // pocket says nothing about the network it just came back to.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') hermes.connect({ resume: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, []);

  // Hold the banner back until a drop has lasted long enough to be worth
  // reporting. Restoring the connection clears it immediately — good news does
  // not need a delay.
  useEffect(() => {
    if (connection === 'open') {
      setShowBanner(false);
      return;
    }
    const t = setTimeout(() => setShowBanner(true), BANNER_DELAY_MS);
    return () => clearTimeout(t);
  }, [connection]);

  /**
   * Commit anything still inside its undo window before the page goes away.
   *
   * A delete the user has already watched happen should not be quietly
   * cancelled by them closing the tab or switching apps. `pagehide` is the
   * event that actually fires on iOS, where `beforeunload` does not.
   */
  useEffect(() => {
    const flush = () => flushUndoables();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  useEventToasts();
  useCronFeedToasts();

  return (
    <div className="app">
      {accessExpired ? (
        /* An expired Access session looks exactly like a dead network from in
           here, and the reconnect banner would keep insisting it is one. Say
           what actually happened and offer the only thing that fixes it. */
        <div role="alert" className="conn-banner conn-banner--closed">
          Signed out.{' '}
          <button type="button" className="conn-banner__action" onClick={goToAccessLogin}>
            Sign in again
          </button>
        </div>
      ) : hostUnreachable && connection !== 'open' ? (
        /* Not the same thing as a dead agent, and saying "Reconnecting…" for it
           implies Hermes is at fault when the fault is on this device. Traced
           from four separate outages where the client's own DNS resolver
           returned empty answers: every request died before leaving the
           machine, `navigator.onLine` stayed `true` throughout, and the app had
           nothing true to say. No action offered because none helps — the
           retry loop is already running and picks up by itself.

           Gated on the socket being down as well as the flag being set. The
           two cannot honestly disagree — an open gateway socket *is* the host
           being reachable — so if they ever do, the socket is the one telling
           the truth and this banner must not contradict it on screen. */
        <div role="alert" className="conn-banner conn-banner--closed">
          This device can’t reach {window.location.host} — check its network. Retrying…
        </div>
      ) : (
        connection !== 'open' && showBanner && (
        <div
          role="status"
          aria-live="polite"
          className={`conn-banner conn-banner--${
            connection === 'reconnecting' || connection === 'connecting' ? 'reconnecting' : 'closed'
          }`}
        >
          {connection === 'connecting'
            ? 'Connecting to Hermes…'
            : connection === 'reconnecting'
              ? 'Reconnecting…'
              : 'Disconnected'}
        </div>
        )
      )}

      <div className="app__body">
        <Suspense fallback={<RoutePending />}>
          <Routes>
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/chat" element={<ChatScreen />} />
            <Route path="/sessions" element={<SessionsScreen />} />
            <Route path="/kanban" element={<KanbanScreen />} />
            <Route path="/activity" element={<ActivityScreen />} />
            <Route path="/files" element={<FilesScreen />} />
            <Route path="/notifications" element={<NotificationsScreen />} />
            {/* The screen is called Updates now, but `/notifications` stays the
                canonical path — see the note at the top of the screen. This is
                the alias for anyone who types what they see. */}
            <Route path="/updates" element={<Navigate to="/notifications" replace />} />
            <Route path="/memory" element={<HubPage title="Memory"><MemoryTab /></HubPage>} />
            <Route path="/skills" element={<HubPage title="Skills"><SkillsTab /></HubPage>} />
            <Route path="/cron" element={<HubPage title="Cron"><CronTab /></HubPage>} />
            <Route path="/models" element={<HubPage title="Models"><ModelsTab /></HubPage>} />
            {/* The usage report is a section of Models now. This stays a real
                route because it is in the slash-command table, in `HubRedirect`,
                and in anything anyone bookmarked. */}
            <Route path="/usage" element={<Navigate to="/models?tab=usage" replace />} />
            <Route path="/tools" element={<HubPage title="Capabilities"><CapabilitiesTab /></HubPage>} />
            <Route path="/profiles" element={<HubPage title="Profiles"><ProfilesTab /></HubPage>} />
            <Route path="/settings" element={<HubPage title="App settings"><SettingsTab /></HubPage>} />
            <Route path="/hub" element={<HubRedirect />} />
            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Routes>
        </Suspense>
      </div>

      <NavDrawer />
      {/**
       * Deliberately here rather than on the chat screen.
       *
       * An approval blocks the agent's turn until it is answered, and it was
       * only rendered inside `ChatScreen` — so one raised while you were on
       * Kanban, Files or Settings produced nothing at all. The turn sat
       * stopped and the app said nothing, because `useEventToasts` does not
       * handle `approval.request` either. Push covers it only when the app is
       * backgrounded and only over HTTPS, which is dormant on plain HTTP.
       *
       * At the shell it can be answered from wherever you happen to be, which
       * is the whole point of a prompt that blocks.
       */}
      <ApprovalSheet />
      {/* Same argument, same blocking semantics: a `clarify.request` parks the
          agent thread until it is answered, so the question has to be reachable
          from whatever screen you wandered off to. */}
      <ClarifySheet />
      <Toasts />
    </div>
  );
}

/**
 * What a route looks like while its chunk is in flight.
 *
 * Blank, then a skeleton. Over the LAN a lazy chunk arrives in a few
 * milliseconds and anything drawn in that window is a flash — which is why
 * this was a blank div. But the app is also reached over Tailscale and through
 * a Cloudflare tunnel, where the same chunk can take a second or more, and
 * there a blank div is a dead screen: no header, no title, nothing that says
 * the tap registered. So the blank is kept for exactly as long as it is
 * honest, and after that the screen admits it is loading.
 *
 * The header bar is drawn empty rather than skipped, because it is the part
 * that makes the shape read as a screen rather than as a crash.
 */
const ROUTE_SKELETON_DELAY_MS = 300;

function RoutePending() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShow(true), ROUTE_SKELETON_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  if (!show) return <div className="route-pending" aria-busy="true" />;

  return (
    <div className="screen route-pending" aria-busy="true">
      <div className="header">
        <MenuButton />
        <div className="header__title">
          <span className="skeleton" style={{ display: 'block', width: 120, height: '0.9em', borderRadius: 4 }} />
        </div>
      </div>
      <SkeletonList n={5} h={54} />
    </div>
  );
}
