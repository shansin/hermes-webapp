/**
 * Context-window breakdown: where the tokens actually went.
 *
 * Also the place to compact a conversation, since running out of context is
 * the problem this sheet is opened to diagnose.
 */
import { useEffect, useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { compressSession } from '../../api/gateway';
import { formatTokens } from '../shared/misc';
import { buzz } from '../../lib/haptics';

/** The gateway returns CSS variables the dashboard defines; map to our tokens. */
const CATEGORY_COLOR: Record<string, string> = {
  system_prompt: '#8b7fd4',
  tool_definitions: '#4dabf7',
  subagent_definitions: '#63c5b0',
  memory: '#ffbf00',
  conversation: '#4caf50',
  files: '#ff8c69',
};

export function ContextSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const usage = useSession((s) => s.usage);
  const breakdown = useSession((s) => s.contextBreakdown);
  const sessionId = useSession((s) => s.sessionId);
  const refreshUsage = useSession((s) => s.refreshUsage);
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) void refreshUsage();
  }, [open, refreshUsage]);

  const max = breakdown?.context_max ?? usage?.context_max ?? 0;
  const used = breakdown?.context_used ?? usage?.context_used ?? 0;
  const pct = max ? Math.min(100, (used / max) * 100) : 0;

  const compact = async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    buzz('tap');
    try {
      await compressSession(sessionId);
      toast('Conversation compacted', 'success');
      void refreshUsage();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Compaction failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Context window">
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7, fontSize: 'var(--type-body-md)' }}>
          <span style={{ color: 'var(--text-dim)' }}>
            {used.toLocaleString()} / {max.toLocaleString()} tokens
          </span>
          <strong style={{ color: pct > 85 ? 'var(--warn)' : 'var(--text)' }}>
            {Math.round(pct)}%
          </strong>
        </div>

        {/* Stacked bar of the categories, in the order Hermes reports them. */}
        <div
          style={{
            height: 12,
            borderRadius: 999,
            background: 'var(--bg-elev-2)',
            overflow: 'hidden',
            display: 'flex',
          }}
        >
          {breakdown?.categories.map((c) => (
            <div
              key={c.id}
              style={{
                width: `${max ? (c.tokens / max) * 100 : 0}%`,
                background: CATEGORY_COLOR[c.id] ?? 'var(--text-faint)',
              }}
              title={`${c.label}: ${c.tokens.toLocaleString()}`}
            />
          ))}
        </div>
      </div>

      {breakdown?.categories.map((c) => (
        <div
          key={c.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '8px 0',
            borderBottom: '1px solid var(--border-soft)',
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              background: CATEGORY_COLOR[c.id] ?? 'var(--text-faint)',
              flexShrink: 0,
            }}
          />
          <span style={{ flex: 1, fontSize: 'var(--type-body-md)' }}>{c.label}</span>
          <span style={{ color: 'var(--text-dim)', fontSize: 'var(--type-detail)', fontFamily: 'var(--mono)' }}>
            {formatTokens(c.tokens)}
          </span>
        </div>
      ))}

      {usage && (
        <div style={{ marginTop: 14, fontSize: 'var(--type-detail)', color: 'var(--text-faint)' }}>
          {usage.calls != null && <div>API calls this session: {usage.calls}</div>}
          {usage.compressions ? <div>Compactions: {usage.compressions}</div> : null}
          {usage.model && <div>Model: {usage.model}</div>}
        </div>
      )}

      <button className="btn" style={{ width: '100%', marginTop: 16 }} onClick={compact} disabled={busy}>
        {busy ? 'Compacting…' : 'Compact conversation'}
      </button>
    </Sheet>
  );
}
