import { useState } from 'react';
import { useDefaultModel, useSetAuxiliaryModel } from '../../api/hub';
import { useUi } from '../../store/ui';
import { Sheet } from '../shared/Sheet';
import { ModelPicker } from '../shared/ModelPicker';
import { buzz } from '../../lib/haptics';

/**
 * What the eleven per-task assignments add up to, as one line.
 *
 * Pure and exported so it can be tested: the states are easy to get subtly
 * wrong and all of them look plausible on screen. Tasks can genuinely disagree
 * — the API allows per-task assignment and Hermes' config is also edited by
 * hand — and reporting the first task's model as if it spoke for the rest
 * would be a quiet lie about where the money is going.
 */
export function summariseAuxiliary(
  tasks: { model: string }[],
): { label: string; detail: string; uniform: string | null } {
  const distinct = [...new Set(tasks.map((t) => t.model || ''))];
  // No tasks at all is "auto" in effect, and must not read as "Mixed".
  const uniform = distinct.length <= 1 ? (distinct[0] ?? '') : null;
  if (uniform === null) {
    const named = distinct.filter(Boolean).length;
    return {
      label: 'Mixed',
      detail: `${named} different models across ${tasks.length} tasks`,
      uniform,
    };
  }
  if (uniform === '') {
    return { label: 'Auto', detail: 'Follows the main model for every task', uniform };
  }
  return { label: uniform, detail: `Used for all ${tasks.length} auxiliary tasks`, uniform };
}

/**
 * The model Hermes uses for the work you never asked it to do.
 *
 * Every turn drags a tail of side calls behind it — naming the session,
 * describing an image, deciding whether a command needs approval, compressing
 * a context that grew too long, rewriting a memory query. Hermes calls these
 * *auxiliary tasks* and gives each one its own slot in `auxiliary.*`. Left at
 * `provider: "auto"` they follow whatever the main model is, so a turn on an
 * expensive model quietly bills a title generation to it too — visible in the
 * Usage tab as auxiliary spend against a model you thought you were using for
 * real work.
 *
 * `/api/model/set` with `scope: "auxiliary"` and no `task` sets all eleven at
 * once, which is what this writes. Per-task control exists in the API and is
 * deliberately not exposed: eleven pickers is a configuration screen, not a
 * setting, and the reason anyone wants this is "send the small stuff
 * somewhere cheap".
 */
export function AuxiliaryModelSection() {
  const { data, isLoading } = useDefaultModel();
  const setAux = useSetAuxiliaryModel();
  const toast = useUi((s) => s.toast);

  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ model: string; provider: string; message: string } | null>(
    null,
  );

  const tasks = data?.tasks ?? [];
  const busy = setAux.isPending;

  const { label, detail, uniform } = summariseAuxiliary(tasks);
  const summary = isLoading ? '…' : label;

  const apply = async (model: string, provider: string, confirmExpensive = false) => {
    try {
      const res = await setAux.mutateAsync({ model, provider, confirmExpensive });
      if (res.confirm_required) {
        setConfirm({ model, provider, message: res.confirm_message || 'This model is expensive.' });
        return;
      }
      buzz('done');
      toast(model ? `Auxiliary work will use ${model}` : 'Auxiliary work follows the main model', 'success');
      setConfirm(null);
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not set the auxiliary model', 'error');
    }
  };

  return (
    <>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', fontWeight: 650, marginBottom: 8 }}>
        AUXILIARY MODEL
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <button
          onClick={() => {
            buzz('tap');
            setOpen(true);
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            background: 'none',
            border: 'none',
            padding: 0,
            textAlign: 'left',
            color: 'var(--text)',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 13.5, overflowWrap: 'anywhere' }}>
              {summary}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>
              {isLoading ? '' : detail}
            </div>
          </div>
          <span style={{ fontSize: 13, color: 'var(--accent)' }}>Change</span>
        </button>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 9, lineHeight: 1.45 }}>
          Titles, image reading, approval checks, context compression and the
          rest. Pointing these at a small model keeps them off your main one —
          the Usage tab shows what they cost.
        </div>
      </div>

      <Sheet open={open} onClose={() => setOpen(false)} title="Auxiliary model">
        {confirm ? (
          <div>
            <div style={{ fontSize: 13.5, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 14 }}>
              {confirm.message}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" style={{ flex: 1 }} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn--primary"
                style={{ flex: 1 }}
                disabled={busy}
                onClick={() => void apply(confirm.model, confirm.provider, true)}
              >
                Use it anyway
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginBottom: 12, lineHeight: 1.45 }}>
              Applies to all {tasks.length || 'the'} auxiliary tasks at once, and
              is saved to Hermes' config.
            </div>
            {/* The only route back to the factory state, since "auto" is not a
                model the picker can list. Without it, choosing once would be a
                one-way door. */}
            <button
              className="btn"
              style={{ width: '100%', marginBottom: 12 }}
              disabled={busy || uniform === ''}
              onClick={() => void apply('', 'auto')}
            >
              {uniform === '' ? 'Following the main model' : 'Follow the main model (auto)'}
            </button>
            <ModelPicker
              selected={uniform || undefined}
              onPick={(m, p) => void apply(m, p)}
              busy={busy}
            />
          </>
        )}
      </Sheet>
    </>
  );
}
