/**
 * Hub — everything that isn't chat, sessions or the board, behind a segmented
 * control. Tabs mount lazily so opening the Hub doesn't fetch five domains.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MemoryTab } from '../components/hub/MemoryTab';
import { SkillsTab } from '../components/hub/SkillsTab';
import { CronTab } from '../components/hub/CronTab';
import { ModelsTab } from '../components/hub/ModelsTab';
import { SettingsTab } from '../components/hub/SettingsTab';
import { ProfilesTab } from '../components/hub/ProfilesTab';
import { buzz } from '../lib/haptics';

const TABS = [
  { id: 'memory', label: 'Memory' },
  { id: 'skills', label: 'Skills' },
  { id: 'cron', label: 'Cron' },
  { id: 'models', label: 'Models' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'settings', label: 'Settings' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const isTabId = (value: string | null): value is TabId =>
  TABS.some((t) => t.id === value);

export function HubScreen() {
  // `/skills`, `/cron`, … arrive as `/hub?tab=<id>` from the slash runner.
  const [params] = useSearchParams();
  const requested = params.get('tab');
  const [tab, setTab] = useState<TabId>(isTabId(requested) ? requested : 'memory');

  // A second `/cron` while the Hub is already open changes the URL without
  // remounting, so follow the param rather than only seeding from it.
  useEffect(() => {
    if (isTabId(requested)) setTab(requested);
  }, [requested]);

  return (
    <div className="screen">
      <div className="header">
        <div className="header__title">Hub</div>
      </div>

      <div
        className="btn-group"
        role="tablist"
        aria-label="Hub sections"
        style={{ borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`btn-group__item${tab === t.id ? ' btn-group__item--active' : ''}`}
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
        {tab === 'profiles' && <ProfilesTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}
