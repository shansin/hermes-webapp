/**
 * Model, reasoning-effort and approval-mode picker.
 *
 * Models are grouped by provider and filtered live — a stock install exposes
 * hundreds, which is unusable as a flat list on a phone.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sheet } from '../shared/Sheet';
import { IconCheck, IconSearch } from '../shared/Icons';
import { fetchModelOptions, setApprovalMode, setModel, setReasoning, REASONING_LEVELS } from '../../api/gateway';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

const APPROVAL_MODES = ['smart', 'always', 'never', 'yolo'];

export function ModelSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);

  const sessionId = useSession((s) => s.sessionId);
  const info = useSession((s) => s.info);
  const toast = useUi((s) => s.toast);

  const { data, isLoading, error } = useQuery({
    queryKey: ['model-options'],
    queryFn: fetchModelOptions,
    enabled: open,
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

  const pick = async (model: string, provider: string) => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      await setModel(sessionId, model, { provider, sessionOnly: true });
      buzz('done');
      toast(`Switched to ${model}`, 'success');
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not switch model', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Model & behavior">
      {/* Reasoning effort */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginBottom: 7, fontWeight: 600 }}>
          REASONING EFFORT
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {REASONING_LEVELS.map((lvl) => (
            <button
              key={lvl}
              className={`chip${info?.reasoning_effort === lvl ? ' chip--active' : ''}`}
              onClick={async () => {
                if (!sessionId) return;
                buzz('tap');
                try {
                  await setReasoning(sessionId, lvl);
                  toast(`Reasoning: ${lvl}`, 'success');
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Failed', 'error');
                }
              }}
            >
              {lvl}
            </button>
          ))}
        </div>
      </div>

      {/* Approval mode */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginBottom: 7, fontWeight: 600 }}>
          TOOL APPROVALS
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {APPROVAL_MODES.map((mode) => (
            <button
              key={mode}
              className={`chip${info?.approval_mode === mode ? ' chip--active' : ''}`}
              onClick={async () => {
                if (!sessionId) return;
                buzz('tap');
                try {
                  await setApprovalMode(sessionId, mode);
                  toast(`Approvals: ${mode}`, 'success');
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Failed', 'error');
                }
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Models */}
      <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginBottom: 7, fontWeight: 600 }}>
        MODEL
      </div>

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
              const active = info?.model === m;
              return (
                <button
                  key={`${p.slug}/${m}`}
                  onClick={() => void pick(m, p.slug)}
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
    </Sheet>
  );
}
