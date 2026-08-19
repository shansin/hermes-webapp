/**
 * App shell: routes, the navigation drawer, the connection banner, and the
 * single place the gateway socket is opened.
 */
import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ChatScreen } from './screens/ChatScreen';
import { HubPage, HubRedirect } from './screens/HubPage';

/**
 * Everything except chat is split out of the initial download.
 *
 * The app opens on `/chat`, and a phone on Wi-Fi pays for every byte before
 * first paint. Statically importing all of these put the whole app — including
 * recharts, which only the Models tab uses, and which is one of the largest
 * things we ship — into the boot graph. Each of these now arrives on the
 * navigation that needs it.
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
const FilesScreen = lazy(() =>
  import('./screens/FilesScreen').then((m) => ({ default: m.FilesScreen })),
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
const SettingsTab = lazy(() =>
  import('./components/hub/SettingsTab').then((m) => ({ default: m.SettingsTab })),
);
import { NavDrawer } from './components/shared/NavDrawer';
import { Toasts } from './components/shared/misc';
import { useUi } from './store/ui';
import { preloadMarkdown } from './components/chat/MarkdownAsync';
import { hermes, defaultWsUrl } from './ws/client';
import { useEventToasts } from './lib/useEventToasts';

export function App() {
  const connection = useUi((s) => s.connection);
  const setConnection = useUi((s) => s.setConnection);
  const token = useUi((s) => s.token);

  // Warm the markdown chunk while the socket is still connecting, so the first
  // assistant message doesn't wait on it.
  useEffect(preloadMarkdown, []);

  // Open the socket once for the app's lifetime and mirror its state into the
  // UI store so any screen can react to a drop.
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

  useEventToasts();

  return (
    <div className="app">
      {connection !== 'open' && (
        <div
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
      )}

      <div className="app__body">
        <Suspense fallback={<div className="route-pending" aria-busy="true" />}>
          <Routes>
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/chat" element={<ChatScreen />} />
            <Route path="/sessions" element={<SessionsScreen />} />
            <Route path="/kanban" element={<KanbanScreen />} />
            <Route path="/files" element={<FilesScreen />} />
            <Route path="/memory" element={<HubPage title="Memory"><MemoryTab /></HubPage>} />
            <Route path="/skills" element={<HubPage title="Skills"><SkillsTab /></HubPage>} />
            <Route path="/cron" element={<HubPage title="Cron"><CronTab /></HubPage>} />
            <Route path="/models" element={<HubPage title="Models"><ModelsTab /></HubPage>} />
            <Route path="/profiles" element={<HubPage title="Profiles"><ProfilesTab /></HubPage>} />
            <Route path="/settings" element={<HubPage title="Settings"><SettingsTab /></HubPage>} />
            <Route path="/hub" element={<HubRedirect />} />
            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Routes>
        </Suspense>
      </div>

      <NavDrawer />
      <Toasts />
    </div>
  );
}
