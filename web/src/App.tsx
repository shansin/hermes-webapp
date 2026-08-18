/**
 * App shell: routes, the navigation drawer, the connection banner, and the
 * single place the gateway socket is opened.
 */
import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ChatScreen } from './screens/ChatScreen';
import { SessionsScreen } from './screens/SessionsScreen';
import { KanbanScreen } from './screens/KanbanScreen';
import { FilesScreen } from './screens/FilesScreen';
import { HubPage, HubRedirect } from './screens/HubPage';
import { MemoryTab } from './components/hub/MemoryTab';
import { SkillsTab } from './components/hub/SkillsTab';
import { CronTab } from './components/hub/CronTab';
import { ModelsTab } from './components/hub/ModelsTab';
import { ProfilesTab } from './components/hub/ProfilesTab';
import { SettingsTab } from './components/hub/SettingsTab';
import { NavDrawer } from './components/shared/NavDrawer';
import { Toasts } from './components/shared/misc';
import { useUi } from './store/ui';
import { hermes, defaultWsUrl } from './ws/client';
import { useEventToasts } from './lib/useEventToasts';

export function App() {
  const connection = useUi((s) => s.connection);
  const setConnection = useUi((s) => s.setConnection);
  const token = useUi((s) => s.token);

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
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') hermes.connect();
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
      </div>

      <NavDrawer />
      <Toasts />
    </div>
  );
}
