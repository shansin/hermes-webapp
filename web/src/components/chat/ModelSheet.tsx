/**
 * Per-session model, reasoning-effort and approval-mode picker.
 *
 * Everything here is scoped to the running chat — switching the model does not
 * touch the default new sessions start with, which lives on the Models screen.
 */
import { useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { ModelPicker } from '../shared/ModelPicker';
import { setApprovalMode, setModel, setReasoning, REASONING_LEVELS } from '../../api/gateway';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

const APPROVAL_MODES = ['smart', 'always', 'never', 'yolo'];

export function ModelSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  const sessionId = useSession((s) => s.sessionId);
  const info = useSession((s) => s.info);
  const toast = useUi((s) => s.toast);

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

      <ModelPicker selected={info?.model} onPick={(m, p) => void pick(m, p)} busy={busy} />
    </Sheet>
  );
}
