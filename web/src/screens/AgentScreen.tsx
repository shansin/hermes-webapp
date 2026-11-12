/**
 * Agent — the agent itself: what it remembers, what it can do, what it can
 * reach, which named setup it runs as, and which model.
 *
 * Five screens that were five drawer rows, gathered because the drawer had
 * grown to thirteen and seven of them were configuration. They are one
 * question — what is this agent? — and the drawer is the scarce surface, not
 * this screen. The tab components are mounted as they are; this file is only
 * the chrome and the switch.
 *
 * **The tab is in the URL** (`?tab=`), the way `/hub?tab=` used to work, so a
 * slash command, a redirect from an old path (`legacyTarget` in `HubPage.tsx`)
 * or a bookmark lands on the right one, and back leaves the screen rather than
 * stepping through every tab you looked at — switching *replaces* the entry.
 * Switching also drops the other parameters: `?profile=` belongs to the tab
 * that read it, and carrying Models' profile into Skills would scope a screen
 * you did not ask to scope.
 *
 * Two tabs had their own sections in `?tab=` before they lived here.
 * Capabilities moved its to `?section=`; Models lost its Usage half, which is
 * its own destination (`/usage`) again.
 *
 * **Each tab is its own chunk.** Memory and Skills are not what the Models
 * picker should have to download, and the first paint of this screen should
 * cost the one tab it opens on.
 */
import { Suspense, lazy, type ComponentType } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MenuButton } from '../components/shared/MenuButton';
import { BackButton } from '../components/shared/BackButton';
import { IconCron } from '../components/shared/Icons';
import { buzz } from '../lib/haptics';
import { AGENT_TABS, isAgentTab, type AgentTab } from './HubPage';

const MemoryTab = lazy(() =>
  import('../components/hub/MemoryTab').then((m) => ({ default: m.MemoryTab })),
);
const SkillsTab = lazy(() =>
  import('../components/hub/SkillsTab').then((m) => ({ default: m.SkillsTab })),
);
const CapabilitiesTab = lazy(() =>
  import('../components/tools/CapabilitiesTab').then((m) => ({ default: m.CapabilitiesTab })),
);
const ProfilesTab = lazy(() =>
  import('../components/hub/ProfilesTab').then((m) => ({ default: m.ProfilesTab })),
);
const ModelsTab = lazy(() =>
  import('../components/hub/ModelsTab').then((m) => ({ default: m.ModelsTab })),
);

const PANELS: Record<AgentTab, ComponentType> = {
  memory: MemoryTab,
  skills: SkillsTab,
  capabilities: CapabilitiesTab,
  profiles: ProfilesTab,
  models: ModelsTab,
};

export function AgentScreen() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  // Anything unrecognised opens the first tab rather than a blank screen — a
  // hand-typed or stale `?tab=` must not strand anyone.
  const tab: AgentTab = isAgentTab(raw) ? raw : 'memory';
  const Panel = PANELS[tab];

  return (
    <div className="screen">
      <div className="header">
        <MenuButton />
        <BackButton />
        <div className="header__title">Agent</div>
        {/* Scheduled jobs run as an agent, against a profile's own config and
            memory, so this is a natural place to look for them — but they are
            read alongside what they reported, which is why their home is
            Updates. The route is unchanged. */}
        <button
          type="button"
          className="icon-btn"
          aria-label="Schedules"
          title="Schedules"
          onClick={() => {
            buzz('tap');
            navigate('/cron');
          }}
        >
          <IconCron size={19} />
        </button>
      </div>

      <div
        className="btn-group"
        role="tablist"
        aria-label="Agent section"
        style={{ borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}
      >
        {AGENT_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`agent-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="agent-panel"
            className={`btn-group__item${tab === t.id ? ' btn-group__item--active' : ''}`}
            onClick={() => {
              if (t.id === tab) return;
              buzz('tap');
              // `replace`: moving between sections of one screen is not
              // something you should have to press back through to leave.
              setParams({ tab: t.id }, { replace: true });
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="scroll" id="agent-panel" role="tabpanel" aria-labelledby={`agent-tab-${tab}`}>
        {/* Keyed on the tab so one tab's local state (a search box, an open
            row) does not leak into the next one's first render. */}
        <Suspense key={tab} fallback={<div className="route-pending" aria-busy="true" />}>
          <Panel />
        </Suspense>
      </div>
    </div>
  );
}
