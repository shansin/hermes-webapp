/**
 * Skills: toggle what's installed, and search the hub to add more.
 * Grouped by category, since a stock install ships dozens.
 *
 * ## Skills belong to a profile
 *
 * Every skill lives in one profile's `skills/` directory and is enabled or
 * disabled in that profile's own config, so this screen always shows exactly
 * one profile's set — it just used to be silent about *which*, because an
 * omitted `?profile=` means "the active one" and nothing on screen said so.
 * That is fine until a second profile exists, at which point narrowing the
 * research agent's skills from here quietly narrowed the default agent's
 * instead, and the only way to see it was to switch profiles and look.
 *
 * The picker is the same one the Sessions screen carries — `ProfileFilter`,
 * a dropdown rather than a chip per profile — with the same rule: null is the
 * active profile rather than its name (pinning the name goes wrong the moment
 * the profile is switched elsewhere in the app), and it is not rendered at all
 * on a single-profile install, where it would offer the only answer there is.
 *
 * The profile has to travel with every write, not just the read. `flip` and
 * the hub install both carry it; without that the list shows one profile while
 * the switches edit another, which is worse than not having the picker.
 */
import { useMemo, useState } from 'react';
import { IconSearch } from '../shared/Icons';
import { SkeletonList, ErrorNote, Empty, Loader, Switch } from '../shared/misc';
import { useInstallSkill, useSkillHubSearch, useSkills, useToggleSkill } from '../../api/hub';
import type { Skill } from '../../api/hub';
import { ProfileFilter } from '../shared/ProfileSelect';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

/**
 * Where a skill with no category of its own goes.
 *
 * Hermes fills `category` in for its bundled skills and leaves it null on the
 * ones the agent wrote itself. Grouping straight on that key put a literal
 * `null` in the map and then called `null.replace(…)` on it while rendering
 * the group heading — a throw with no error boundary above it, so the crash
 * took down the whole tree: Skills looked empty and no other screen would
 * render until the app was reloaded.
 */
const UNCATEGORIZED = 'uncategorized';

/** Exported so the null-category case can be tested without a screen. */
export function groupSkills(skills: Skill[] | undefined): [string, Skill[]][] {
  const map = new Map<string, Skill[]>();
  for (const s of skills ?? []) {
    const category = s.category || UNCATEGORIZED;
    const list = map.get(category) ?? [];
    list.push(s);
    map.set(category, list);
  }
  // Uncategorized last: it is a leftovers bin, not a subject.
  return [...map.entries()].sort(([a], [b]) =>
    a === UNCATEGORIZED ? 1 : b === UNCATEGORIZED ? -1 : a.localeCompare(b),
  );
}

export function SkillsTab() {
  const [mode, setMode] = useState<'installed' | 'hub'>('installed');
  const [q, setQ] = useState('');
  /** Null is the active profile — see the note at the top. */
  const [profile, setProfile] = useState<string | null>(null);

  const { data, isLoading, error } = useSkills(profile);
  const toggle = useToggleSkill();
  const install = useInstallSkill();
  const hub = useSkillHubSearch(q, profile);
  const toast = useUi((s) => s.toast);

  const grouped = useMemo(() => groupSkills(data), [data]);

  const flip = async (name: string, enabled: boolean) => {
    try {
      await toggle.mutateAsync({ name, enabled, profile });
      // Naming the profile only when it is not the active one: on a
      // single-profile install the suffix would be on every toast and mean
      // nothing, and while you are editing another profile it is the whole
      // point of the message.
      toast(`${name} ${enabled ? 'enabled' : 'disabled'}${profile ? ` in ${profile}` : ''}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Toggle failed', 'error');
    }
  };

  return (
    <div style={{ padding: 12 }}>
      {/* Coarser than the Installed/Hub cut beside it: that chooses what this
          screen is doing, this chooses whose skills it is doing it to. Renders
          nothing on a single-profile install. */}
      <div style={{ display: 'flex', gap: 7, marginBottom: 12, flexWrap: 'wrap' }}>
        <ProfileFilter value={profile} onChange={setProfile} />
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

          {hub.isLoading && (
            <div style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
              <Loader muted />
            </div>
          )}
          {/* The hub is a network away and the search can simply fail. It used
              to say so in a line of red text with nothing to do about it —
              every other screen in the app offers the same failure as
              `ErrorNote` plus the button that retries it. */}
          {hub.error && (
            <>
              <ErrorNote error={hub.error} />
              <div style={{ display: 'grid', placeItems: 'center' }}>
                <button
                  className="btn btn--sm"
                  onClick={() => {
                    buzz('tap');
                    void hub.refetch();
                  }}
                >
                  Try again
                </button>
              </div>
            </>
          )}

          {/* Keyed on the identifier: one search for `pdf` comes back as the
              same name from three different repos, so the name is not unique
              and React was reconciling three rows as one. */}
          {(hub.data?.results ?? hub.data?.skills ?? []).map((s) => (
            <div
              className="card"
              key={s.identifier ?? s.name}
              style={{ marginBottom: 8, display: 'flex', gap: 10 }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 'var(--type-body-md)' }}>{s.name}</div>
                {s.description && (
                  <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-dim)', marginTop: 3 }}>
                    {s.description}
                  </div>
                )}
              </div>
              <button
                className="btn btn--sm"
                disabled={install.isPending || !s.identifier}
                onClick={async () => {
                  if (!s.identifier) return;
                  try {
                    await install.mutateAsync({ identifier: s.identifier, profile });
                    toast(`Installed ${s.name}${profile ? ` in ${profile}` : ''}`, 'success');
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
            <div className="group-head">{category.replace(/-/g, ' ')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {skills.map((s) => (
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
                    <div style={{ fontWeight: 550, fontSize: 'var(--type-body-md)', fontFamily: 'var(--mono)' }}>
                      {s.name}
                    </div>
                    <div
                      style={{
                        fontSize: 'var(--type-body-sm)',
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
                      <div style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', marginTop: 3 }}>
                        used {s.usage}×
                      </div>
                    )}
                  </div>
                  <Switch
                    checked={s.enabled}
                    onChange={(v) => {
                      buzz('tap');
                      void flip(s.name, v);
                    }}
                    label={`Enable ${s.name}`}
                  />
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
