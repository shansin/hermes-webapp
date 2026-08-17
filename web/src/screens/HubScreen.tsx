/**
 * Hub — everything that isn't chat, sessions or the board, behind a segmented
 * control. Tabs mount lazily so opening the Hub doesn't fetch five domains.
 */
import { useState } from 'react';
import { MemoryTab } from '../components/hub/MemoryTab';
import { SkillsTab } from '../components/hub/SkillsTab';
import { CronTab } from '../components/hub/CronTab';
import { ModelsTab } from '../components/hub/ModelsTab';
import { SettingsTab } from '../components/hub/SettingsTab';
import { buzz } from '../lib/haptics';

const TABS = [
  { id: 'memory', label: 'Memory' },
  { id: 'skills', label: 'Skills' },
  { id: 'cron', label: 'Cron' },
  { id: 'models', label: 'Models' },
  { id: 'settings', label: 'Settings' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function HubScreen() {
  const [tab, setTab] = useState<TabId>('memory');

  return (
    <div className="screen">
      <div className="header">
        <div className="header__title">Hub</div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 7,
          overflowX: 'auto',
          padding: '10px 12px',
          borderBottom: '1px solid var(--border-soft)',
          flexShrink: 0,
          scrollbarWidth: 'none',
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`chip${tab === t.id ? ' chip--active' : ''}`}
            onClick={() => {
              buzz('tap');
              setTab(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="scroll">
        {tab === 'memory' && <MemoryTab />}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'cron' && <CronTab />}
        {tab === 'models' && <ModelsTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}
