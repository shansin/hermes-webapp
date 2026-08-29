import { useState } from 'react';
import { useDefaultModel, useSetDefaultModel } from '../../api/hub';
import { useUi } from '../../store/ui';
import { Sheet } from '../shared/Sheet';
import { ModelPicker } from '../shared/ModelPicker';
import { buzz } from '../../lib/haptics';

/**
 * The model new chats start with, for one profile.
 *
 * `/api/model/set` with `scope: "main"` writes `model.*` into that profile's
 * config, so this is the default everywhere Hermes runs as that agent — the
 * terminal included — not just this app.
 *
 * It used to say "globally" and mean it: no profile travelled with the call,
 * and an omitted one is the *active* profile rather than the one on screen. So
 * setting a model while looking at one agent could write another's config, and
 * the toast said it had worked. The profile is explicit now, and `ModelsTab`
 * owns the choice.
 *
 * Deliberately separate from the model sheet in chat: that one hot-swaps the
 * running session and leaves this untouched, this one writes Hermes' own config
 * and leaves running sessions untouched. It sits directly under the active-model
 * card so the phone shows both answers at once.
 */
export function DefaultModelSection({ profile = null }: { profile?: string | null }) {
  const { data, isLoading } = useDefaultModel(profile);
  const setDefault = useSetDefaultModel();
  const toast = useUi((s) => s.toast);

  const [open, setOpen] = useState(false);
  // Set when Hermes wants a second look at an expensive model. Holds the pick
  // so confirming can resend it without making the user find it again.
  const [confirm, setConfirm] = useState<{ model: string; provider: string; message: string } | null>(
    null,
  );

  const main = data?.main;
  const busy = setDefault.isPending;
  /**
   * `provider: moa` is not a provider and `main.model` is not a model — it is
   * the name of a Mixture of Agents preset, whose real models live under
   * `moa.presets.<name>`. Rendered as-is this card said `default` `via moa`,
   * which reads as a model called "default" served by something called moa,
   * and a profile could sit in that state failing every turn with nothing on
   * the screen suggesting where to look. `MoaSection` below is where the
   * preset itself is read and edited.
   */
  const onMoa = (main?.provider || '').trim().toLowerCase() === 'moa';

  const apply = async (model: string, provider: string, confirmExpensive = false) => {
    try {
      const res = await setDefault.mutateAsync({ model, provider, profile, confirmExpensive });
      if (res.confirm_required) {
        setConfirm({ model, provider, message: res.confirm_message || 'This model is expensive.' });
        return;
      }
      buzz('done');
      toast(
        provider.trim().toLowerCase() === 'moa'
          ? `New chats will route through the "${model}" preset`
          : `New chats will use ${model}`,
        'success',
      );
      setConfirm(null);
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not set the default model', 'error');
    }
  };

  return (
    <>
      <div className="group-head">
        DEFAULT MODEL
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
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 'var(--type-detail)',
                overflowWrap: 'anywhere',
              }}
            >
              {isLoading ? '…' : main?.model || 'Not set'}
            </div>
            <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', marginTop: 2 }}>
              {onMoa
                ? 'Mixture of Agents preset — set up below'
                : main?.provider
                  ? `via ${main.provider}`
                  : 'Hermes picks one automatically'}
            </div>
          </div>
          <span style={{ fontSize: 'var(--type-detail)', color: 'var(--accent)' }}>Change</span>
        </button>
        <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', marginTop: 9, lineHeight: 1.45 }}>
          Used by new chats, everywhere Hermes runs — including the terminal.
          The chat you have open keeps its own model; change that from the model
          button in the composer.
        </div>
      </div>

      <Sheet open={open} onClose={() => setOpen(false)} title="Default model">
        {confirm ? (
          <div>
            <div style={{ fontSize: 'var(--type-detail)', color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 14 }}>
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
            <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', marginBottom: 12, lineHeight: 1.45 }}>
              Saved to Hermes' config and used by every new chat. Running chats
              are unaffected.
            </div>
            <ModelPicker
              profile={profile}
              selected={main?.model}
              onPick={(m, p) => void apply(m, p)}
              busy={busy}
            />
          </>
        )}
      </Sheet>
    </>
  );
}
