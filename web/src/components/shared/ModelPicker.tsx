/**
 * Provider-grouped, filterable model list.
 *
 * Shared by the two places a model gets chosen, which differ only in what they
 * do with the answer: the chat sheet switches the running session, the Models
 * screen writes the default for new ones. A stock install exposes hundreds of
 * models, so the grouping and the filter are what make this usable on a phone.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconCheck, IconSearch } from './Icons';
import { fetchModelOptions } from '../../api/gateway';

export function ModelPicker({
  selected,
  onPick,
  busy = false,
}: {
  /** Model id to mark as active, if any. */
  selected?: string;
  onPick: (model: string, provider: string) => void;
  busy?: boolean;
}) {
  const [filter, setFilter] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['model-options'],
    queryFn: fetchModelOptions,
    staleTime: 5 * 60_000,
  });

  const groups = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    return data.providers
      .map((p) => ({
        ...p,
        models: q
          ? p.models.filter((m) => m.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
          : p.models,
      }))
      .filter((p) => p.models.length > 0);
  }, [data, filter]);

  return (
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
          placeholder="Filter models…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {isLoading && <div style={{ color: 'var(--text-faint)' }}>Loading models…</div>}
      {error && (
        <div style={{ color: 'var(--error)', fontSize: 13.5 }}>
          {error instanceof Error ? error.message : 'Could not load models'}
        </div>
      )}

      {groups.map((p) => (
        <div key={p.slug} style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: 12,
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
                    fontSize: 14,
                    textAlign: 'left',
                    fontFamily: 'var(--mono)',
                  }}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m}</span>
                  {p.capabilities?.[m]?.reasoning && (
                    <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>reasoning</span>
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
