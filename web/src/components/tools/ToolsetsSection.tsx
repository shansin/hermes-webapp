/**
 * Toolsets — what the agent is allowed to reach.
 *
 * Grouped by platform, because that is the axis that actually separates them:
 * a stock install has twenty-six CLI sets and a couple that only mean anything
 * when Discord is driving the session, and mixing the two reads as one long
 * undifferentiated list.
 *
 * Three booleans arrive per set and they are not the same question.
 * `enabled` is the switch. `available` is whether Hermes could run it at all.
 * `configured` is whether it has the credentials it needs. They agree on a
 * stock install, which is exactly why the difference has to be shown rather
 * than collapsed — a set that is off because it was never given an API key
 * looks identical to one somebody turned off, and only one of those is fixed
 * by pressing the switch.
 */
import { useMemo, useState } from 'react';
import { Switch, SkeletonList, ErrorNote, Empty } from '../shared/misc';
import { Sheet } from '../shared/Sheet';
import { useToggleToolset, useToolsets, type Toolset } from '../../api/tools';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

export function ToolsetsSection() {
  const { data, isLoading, error } = useToolsets();
  const toggle = useToggleToolset();
  const toast = useUi((s) => s.toast);
  const [detail, setDetail] = useState<Toolset | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; items: Toolset[] }>();
    for (const t of data ?? []) {
      const g = map.get(t.platform) ?? { label: t.platform_label || t.platform, items: [] };
      g.items.push(t);
      map.set(t.platform, g);
    }
    for (const g of map.values()) g.items.sort((a, b) => a.label.localeCompare(b.label));
    // CLI first — it is where all but two of them live.
    return [...map.entries()].sort(([a], [b]) => (a === 'cli' ? -1 : b === 'cli' ? 1 : a.localeCompare(b)));
  }, [data]);

  const flip = async (t: Toolset, enabled: boolean) => {
    buzz('tap');
    try {
      await toggle.mutateAsync({ name: t.name, enabled });
      toast(`${t.label} ${enabled ? 'on' : 'off'}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change that toolset', 'error');
    }
  };

  if (isLoading) return <div style={{ padding: 12 }}><SkeletonList n={7} h={56} /></div>;
  if (error) return <div style={{ padding: 12 }}><ErrorNote error={error} /></div>;
  if (!data?.length) return <Empty icon="🧰" title="No toolsets reported" />;

  const on = data.filter((t) => t.enabled).length;

  return (
    <div style={{ padding: 12 }}>
      <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', marginBottom: 12, lineHeight: 1.45 }}>
        {on} of {data.length} on. Turning one off takes its tools away from every new
        turn — the agent stops being able to do that thing, rather than being asked not to.
      </div>

      {grouped.map(([platform, group]) => (
        <div key={platform} style={{ marginBottom: 16 }}>
          <div className="tool-group__head">{group.label}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {group.items.map((t) => (
              <div key={t.name} className="tool-row">
                <button
                  className="tool-row__main"
                  onClick={() => {
                    buzz('tap');
                    setDetail(t);
                  }}
                  aria-label={`${t.label} details`}
                >
                  <span className="tool-row__title">{t.label}</span>
                  <span className="tool-row__desc">{t.description}</span>
                  {!t.configured && (
                    <span className="tool-row__warn">Needs credentials it doesn’t have</span>
                  )}
                </button>
                <Switch
                  checked={t.enabled}
                  onChange={(v) => void flip(t, v)}
                  label={`${t.label} enabled`}
                />
              </div>
            ))}
          </div>
        </div>
      ))}

      <Sheet open={detail != null} title={detail?.label} onClose={() => setDetail(null)}>
        {detail && (
          <>
            <div style={{ fontSize: 'var(--type-detail)', color: 'var(--text-dim)', lineHeight: 1.5 }}>
              <code>{detail.name}</code> · {detail.platform_label}
            </div>
            <div className="tool-group__head" style={{ marginTop: 14 }}>
              {detail.tools.length} tool{detail.tools.length === 1 ? '' : 's'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {detail.tools.map((name) => (
                <span key={name} className="tool-pill">
                  {name}
                </span>
              ))}
            </div>
            {!detail.configured && (
              <p style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', marginTop: 14, lineHeight: 1.5 }}>
                This set is missing configuration — usually an API key in the environment.
                The switch will not fix that; set the value where Hermes reads its
                environment and it becomes available.
              </p>
            )}
          </>
        )}
      </Sheet>
    </div>
  );
}
