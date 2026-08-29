/**
 * Provider-grouped, filterable model list.
 *
 * Shared by every place a model gets chosen — the chat sheet switches the
 * running session, the Models screen writes the default for new ones, the cron
 * sheet pins a job, the profile editor pins a profile. A stock install exposes
 * hundreds of models, so the grouping and the filter are what make this usable
 * on a phone.
 *
 * ## Why there is a Refresh button
 *
 * A saved **custom** provider that is not the current one is served from a
 * catalogue cached in `config.yaml`, because Hermes deliberately probes only
 * the current custom endpoint on a normal open — otherwise one unreachable
 * saved host hangs the picker for everyone. The cost is a list that silently
 * goes stale the moment a model is pulled on that machine.
 *
 * That failure is quiet in the worst way: the provider still appears, still
 * lists models, and simply omits the new ones. An Ollama host here had been
 * serving two `ornith-1.5` builds that never showed, while the older `ornith`
 * entries kept the list looking healthy. Nothing about the picker suggested it
 * was out of date.
 *
 * So refresh is offered, and offered as a button rather than done on open: the
 * hang it guards against is real, and only the person looking at the screen
 * knows whether the box they are waiting on is switched on.
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconSearch } from './Icons';
import { fetchModelOptions } from '../../api/gateway';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

export function ModelPicker({
  selected,
  profile = null,
  onPick,
  busy = false,
  exclude = [],
}: {
  /** Model id to mark as active, if any. */
  selected?: string;
  /**
   * Whose catalogue to offer. Null is the active profile — the right default
   * for the three callers that pin something inside the profile they are
   * already in. It matters because `custom_providers` is profile config: two
   * profiles can have different endpoints saved, so the list of models that
   * exist is genuinely not the same list.
   */
  profile?: string | null;
  onPick: (model: string, provider: string) => void;
  busy?: boolean;
  /**
   * Provider slugs to leave out. Only one caller needs it: a Mixture of Agents
   * slot cannot itself be MoA — the backend refuses to save a recursive preset
   * and the runtime only notices mid-turn — so offering the row there would be
   * offering a choice that cannot be taken.
   */
  exclude?: string[];
}) {
  const [filter, setFilter] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);

  const { data, isLoading, error } = useQuery({
    // The profile is part of the key, not just the request: one shared entry
    // would hand the second profile the first one's models.
    queryKey: ['model-options', profile ?? null],
    queryFn: () => fetchModelOptions({ profile }),
    staleTime: 5 * 60_000,
  });

  /**
   * Re-probe every saved custom endpoint and write the result into the same
   * cache entry, so every other picker in the app sees the fresh catalogue
   * too — this component is mounted in four places.
   *
   * A failure leaves the existing list alone. A stale list is far better than
   * an empty one: the models in it still work, and blanking the picker because
   * a probe timed out would take away the ability to pick anything at all.
   */
  const refresh = async () => {
    buzz('tap');
    setRefreshing(true);
    try {
      const fresh = await fetchModelOptions({ refresh: true, profile });
      qc.setQueryData(['model-options', profile ?? null], fresh);
      const n = fresh.providers.reduce((sum, p) => sum + p.models.length, 0);
      toast(`${n} models across ${fresh.providers.length} providers`, 'success');
    } catch (e) {
      toast(
        e instanceof Error ? `Refresh failed: ${e.message}` : 'Could not refresh models',
        'error',
      );
    } finally {
      setRefreshing(false);
    }
  };

  // A default `[]` prop is a new array each render, so the memo is keyed on
  // the contents rather than the identity.
  const hiddenKey = exclude.map((s) => s.trim().toLowerCase()).filter(Boolean).join(',');

  const groups = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    const hidden = new Set(hiddenKey.split(',').filter(Boolean));
    return data.providers
      .filter((p) => !hidden.has(p.slug.trim().toLowerCase()))
      .map((p) => ({
        ...p,
        models: q
          ? p.models.filter((m) => m.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
          : p.models,
      }))
      .filter((p) => p.models.length > 0);
  }, [data, filter, hiddenKey]);

  return (
    <>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
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
            style={{ paddingLeft: 34, width: '100%' }}
            placeholder="Filter models…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <button
          className="btn btn--sm"
          onClick={() => void refresh()}
          disabled={refreshing || busy}
          title="Re-probe saved custom endpoints for newly pulled models"
        >
          {refreshing ? 'Probing…' : 'Refresh'}
        </button>
      </div>
      <p style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', margin: '0 2px 12px', lineHeight: 1.45 }}>
        A custom endpoint that is not the current provider is listed from cache. Refresh to
        re-probe it — takes a moment, and waits on hosts that may be asleep.
      </p>

      {isLoading && <div style={{ color: 'var(--text-faint)' }}>Loading models…</div>}
      {error && (
        <div style={{ color: 'var(--error)', fontSize: 'var(--type-detail)' }}>
          {error instanceof Error ? error.message : 'Could not load models'}
        </div>
      )}

      {groups.map((p) => (
        <div key={p.slug} style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: 'var(--type-body-sm)',
              color: 'var(--text-dim)',
              fontWeight: 600,
              marginBottom: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {p.name}
            {p.authenticated === false && (
              <span style={{ color: 'var(--warn)', fontWeight: 400 }}>· no key</span>
            )}
          </div>
          {/*
            * Providers can ship a caveat with the row, and exactly one does
            * something this list cannot express on its own: the Mixture of
            * Agents row's "models" are preset *names*, and picking one
            * switches the profile into a routing mode whose real models are
            * configured elsewhere. Rendered as a whole sentence because that
            * is the only thing separating it from a list of models.
            */}
          {p.warning && (
            <div
              style={{
                fontSize: 'var(--type-label-sm)',
                color: 'var(--text-faint)',
                lineHeight: 1.4,
                margin: '-2px 2px 7px',
              }}
            >
              {p.warning}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {p.models.map((m) => {
              const active = selected === m;
              return (
                <button
                  key={`${p.slug}/${m}`}
                  onClick={() => onPick(m, p.slug)}
                  disabled={busy}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background: active ? 'var(--accent-soft)' : 'var(--bg-elev-2)',
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border-soft)'}`,
                    color: active ? 'var(--accent)' : 'var(--text)',
                    fontSize: 'var(--type-body-md)',
                    textAlign: 'left',
                    fontFamily: 'var(--mono)',
                  }}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m}</span>
                  {p.capabilities?.[m]?.reasoning && (
                    <span style={{ fontSize: 'var(--type-micro)', color: 'var(--text-faint)' }}>reasoning</span>
                  )}
                  {active && <IconCheck size={15} />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
