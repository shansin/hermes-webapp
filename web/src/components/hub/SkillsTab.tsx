/**
 * Skills: toggle what's installed, and search the hub to add more.
 * Grouped by category, since a stock install ships dozens.
 */
import { useMemo, useState } from 'react';
import { IconSearch } from '../shared/Icons';
import { SkeletonList, ErrorNote, Empty } from '../shared/misc';
import { useInstallSkill, useSkillHubSearch, useSkills, useToggleSkill } from '../../api/hub';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => {
        buzz('tap');
        onChange(!on);
      }}
      aria-pressed={on}
      style={{
        width: 42,
        height: 25,
        borderRadius: 999,
        background: on ? 'var(--accent)' : 'var(--border)',
        position: 'relative',
        flexShrink: 0,
        transition: 'background 0.18s',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: on ? 20 : 3,
          width: 19,
          height: 19,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.18s cubic-bezier(0.2,0.8,0.2,1)',
        }}
      />
    </button>
  );
}

export function SkillsTab() {
  const [mode, setMode] = useState<'installed' | 'hub'>('installed');
  const [q, setQ] = useState('');

  const { data, isLoading, error } = useSkills();
  const toggle = useToggleSkill();
  const install = useInstallSkill();
  const hub = useSkillHubSearch(q);
  const toast = useUi((s) => s.toast);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof data>();
    for (const s of data ?? []) {
      const list = map.get(s.category) ?? [];
      list.push(s);
      map.set(s.category, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  const flip = async (name: string, enabled: boolean) => {
    try {
      await toggle.mutateAsync({ name, enabled });
      toast(`${name} ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Toggle failed', 'error');
    }
  };

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', gap: 7, marginBottom: 12 }}>
        <button
          className={`chip${mode === 'installed' ? ' chip--active' : ''}`}
          onClick={() => setMode('installed')}
        >
          Installed {data && `· ${data.length}`}
        </button>
        <button className={`chip${mode === 'hub' ? ' chip--active' : ''}`} onClick={() => setMode('hub')}>
          Hub
        </button>
      </div>

      {mode === 'hub' ? (
        <>
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <IconSearch
              size={16}
              style={{
                position: 'absolute',
                left: 11,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-faint)',
              }}
            />
            <input
              className="field"
              style={{ paddingLeft: 34 }}
              placeholder="Search the skill hub…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          {hub.isLoading && <div style={{ color: 'var(--text-faint)' }}>Searching…</div>}
          {hub.error && <div style={{ color: 'var(--error)', fontSize: 13 }}>Hub search unavailable</div>}

          {(hub.data?.results ?? hub.data?.skills ?? []).map((s) => (
            <div className="card" key={s.name} style={{ marginBottom: 8, display: 'flex', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</div>
                {s.description && (
                  <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 3 }}>
                    {s.description}
                  </div>
                )}
              </div>
              <button
                className="btn btn--sm"
                disabled={install.isPending}
                onClick={async () => {
                  try {
                    await install.mutateAsync({ name: s.name, source: s.source });
                    toast(`Installed ${s.name}`, 'success');
                  } catch (e) {
                    toast(e instanceof Error ? e.message : 'Install failed', 'error');
                  }
                }}
              >
                Install
              </button>
            </div>
          ))}
        </>
      ) : isLoading ? (
        <SkeletonList n={6} h={54} />
      ) : error ? (
        <ErrorNote error={error} />
      ) : grouped.length === 0 ? (
        <Empty icon="⚡" title="No skills installed" />
      ) : (
        grouped.map(([category, skills]) => (
          <div key={category} style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 650,
                color: 'var(--text-faint)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                marginBottom: 7,
              }}
            >
              {category.replace(/-/g, ' ')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {(skills ?? []).map((s) => (
                <div
                  key={s.name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 11,
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border-soft)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '11px 13px',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 550, fontSize: 14, fontFamily: 'var(--mono)' }}>
                      {s.name}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--text-faint)',
                        marginTop: 2,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {s.description}
                    </div>
                    {s.usage > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 3 }}>
                        used {s.usage}×
                      </div>
                    )}
                  </div>
                  <Toggle on={s.enabled} onChange={(v) => void flip(s.name, v)} />
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
