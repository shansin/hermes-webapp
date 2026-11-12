/**
 * Per-session model, reasoning-effort and approval picker.
 *
 * Everything here is scoped to the running chat — switching the model does not
 * touch the default new sessions start with, which lives on the Models screen —
 * with one exception, labelled as such: the approval mode is a single global
 * setting in Hermes, so its row says it applies to all chats. The per-chat
 * escape hatch is the bypass switch under it. This is the only place either is
 * set; see `lib/approvalModes.ts`.
 */
import { useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { ModelPicker } from '../shared/ModelPicker';
import { Switch } from '../shared/misc';
import {
  setApprovalMode,
  setModel,
  setReasoning,
  setSessionYolo,
  REASONING_LEVELS,
} from '../../api/gateway';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';
import { APPROVAL_MODES, approvalLabel, normalizeApprovalMode } from '../../lib/approvalModes';

export function ModelSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  const sessionId = useSession((s) => s.sessionId);
  const info = useSession((s) => s.info);
  const toast = useUi((s) => s.toast);
  const approval = normalizeApprovalMode(info?.approval_mode);

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
        <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', marginBottom: 7, fontWeight: 600 }}>
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

      {/* Approval mode — global, unlike everything else in this sheet */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', marginBottom: 7, fontWeight: 600 }}>
          TOOL APPROVALS · ALL CHATS
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {APPROVAL_MODES.map(({ mode, label }) => (
            <button
              key={mode}
              className={`chip${approval === mode ? ' chip--active' : ''}`}
              aria-pressed={approval === mode}
              onClick={async () => {
                if (!sessionId) return;
                buzz('tap');
                try {
                  await setApprovalMode(sessionId, mode);
                  toast(`Approvals: ${label}, in every chat`, 'success');
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Failed', 'error');
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {approval && (
          <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', marginTop: 6 }}>
            {APPROVAL_MODES.find((m) => m.mode === approval)?.hint}
          </div>
        )}
        {/* The per-chat override. Moot under a global Off, where `info.yolo`
            is already true and switching this chat's flag would change nothing. */}
        {approval !== 'off' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <div style={{ flex: 1, fontSize: 'var(--type-body-sm)' }}>
              Skip approvals in this chat
            </div>
            <Switch
              label="Skip approvals in this chat"
              checked={Boolean(info?.yolo)}
              onChange={async (on) => {
                if (!sessionId) return;
                buzz('tap');
                try {
                  await setSessionYolo(sessionId, on);
                  toast(
                    on
                      ? 'This chat runs commands without asking'
                      : `This chat follows the global mode (${approvalLabel(approval ?? 'manual')})`,
                    'success',
                  );
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Failed', 'error');
                }
              }}
            />
          </div>
        )}
      </div>

      {/* Models */}
      <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', marginBottom: 7, fontWeight: 600 }}>
        MODEL
      </div>

      <ModelPicker selected={info?.model} onPick={(m, p) => void pick(m, p)} busy={busy} />
    </Sheet>
  );
}
