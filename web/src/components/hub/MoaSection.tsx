/**
 * Mixture of Agents, for one profile.
 *
 * MoA is a routing mode, not a model: a preset fans each turn out to a set of
 * **advisors** (Hermes calls them reference models), then hands their answers
 * to an **aggregator**, which is the model that actually acts and writes the
 * reply you read. `provider: moa` with `default: <name>` in a profile's config
 * therefore names a preset, not a model.
 *
 * ## Why this screen exists
 *
 * `ModelPicker` already listed "Mixture of Agents" as a provider, because
 * `/api/model/options` returns it as one. Its rows are preset names and its
 * `authenticated` flag is hardcoded true — accurate for the virtual row, which
 * needs no credential, and silent about the models inside the preset. So a
 * profile could be moved into MoA with one tap and then run every turn against
 * Hermes' **factory preset**: advisors on `openai-codex` and `openrouter`, the
 * aggregator on `openrouter`, none of them holding a key on this machine.
 *
 * That failure is quiet on the way in and loud only at the end. Advisors
 * failing is survivable — the run logs `all references failed — acting
 * aggregator-alone` and carries on — but the aggregator failing ends the turn
 * with `No LLM provider configured for task=moa_aggregator`. A cron job here
 * failed exactly that way, and the state was visible in nothing except the
 * run's own error text: the Models screen said `default` `via moa`, which
 * reads as a model named default.
 *
 * So the section leads with the two facts that were missing — which models the
 * preset actually points at, and whether this machine has credentials for them
 * — and only then offers the editor. The credential check is
 * `slotCredentialGaps`, phrased as a suspicion because a key can reach Hermes
 * by a route the picker does not enumerate. The asymmetry is the point: an
 * advisor without one degrades a turn, the aggregator without one ends it.
 *
 * ## Two things the read cannot tell you
 *
 * `load_config()` merges Hermes' `DEFAULT_CONFIG`, so a profile that has never
 * saved a `moa:` block answers with the factory preset fully populated and
 * indistinguishable from a chosen one. There is no flag for it, which is why
 * the copy says where an unsaved preset comes from rather than pretending the
 * response settles it — and why the warning is driven by credentials, which
 * are true either way.
 *
 * And a save through `PUT /api/model/moa` drops a **per-slot** `max_tokens`,
 * because `MoaModelSlot` does not declare one; Hermes' own desktop GUI loses it
 * too. The preset-level cap survives. Nothing here writes such a value, so the
 * only way to lose one is to have set it by hand — hence the note on the sheet.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  EMPTY_SLOT,
  moaPayloadProblems,
  slotCredentialGaps,
  useMoaConfig,
  useSaveMoaConfig,
  type MoaPreset,
  type MoaSlot,
} from '../../api/moa';
import { useDefaultModel } from '../../api/hub';
import { fetchModelOptions } from '../../api/gateway';
import { useUi } from '../../store/ui';
import { Sheet } from '../shared/Sheet';
import { ModelPicker } from '../shared/ModelPicker';
import { buzz } from '../../lib/haptics';

/** How often the advisors run. `every_n:<N>` is a third, left as read-only. */
const FANOUTS = [
  { id: 'user_turn', label: 'Once per message', hint: 'Cheapest. Advisors weigh in up front, then the aggregator works alone.' },
  { id: 'per_iteration', label: 'Every tool step', hint: 'Advice tracks live task state, and multiplies advisor spend by the length of the tool loop.' },
] as const;

const faint = { fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', lineHeight: 1.45 } as const;

/** `openai-codex` / `gpt-5.5` as one line, or a prompt when nothing is set. */
function slotLabel(slot: MoaSlot | undefined): string {
  const model = (slot?.model || '').trim();
  const provider = (slot?.provider || '').trim();
  if (!model) return 'Not set';
  return provider ? `${model} · ${provider}` : model;
}

export function MoaSection({ profile = null }: { profile?: string | null }) {
  const { data: config, isLoading, error } = useMoaConfig(profile);
  const { data: models } = useDefaultModel(profile);
  const save = useSaveMoaConfig();
  const toast = useUi((s) => s.toast);
  const [open, setOpen] = useState(false);

  /**
   * The authenticated providers, for the credential check only. Shares the key
   * `ModelPicker` uses, so opening the editor does not fetch this twice and a
   * refresh in the picker updates the warning here.
   */
  const { data: options } = useQuery({
    queryKey: ['model-options', profile ?? null],
    queryFn: () => fetchModelOptions({ profile }),
    staleTime: 5 * 60_000,
  });

  const onMoa = (models?.main?.provider || '').trim().toLowerCase() === 'moa';
  /**
   * Which preset to show. The one the profile is pointed at when it is on MoA
   * — that is the one whose failure would be felt — otherwise the default.
   */
  const presetName =
    (onMoa && models?.main?.model && config?.presets?.[models.main.model]
      ? models.main.model
      : config?.default_preset) || 'default';
  const preset = config?.presets?.[presetName];
  const gaps = useMemo(() => slotCredentialGaps(preset, options?.providers), [preset, options]);
  const presetNames = useMemo(() => Object.keys(config?.presets ?? {}), [config]);

  return (
    <>
      <div className="group-head">MIXTURE OF AGENTS</div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--type-detail)' }}>
              {onMoa ? `In use — preset "${presetName}"` : 'Not in use'}
            </div>
            <div style={{ ...faint, marginTop: 2 }}>
              {onMoa
                ? 'Every turn on this profile is routed through the preset below.'
                : 'New chats go straight to the default model. Pick "Mixture of Agents" there to route them through a preset instead.'}
            </div>
          </div>
          <button
            className="btn btn--sm"
            /*
             * No preset means the response carried none — `normalize_moa_config`
             * always returns at least one, so this is version drift rather than
             * a state worth building an editor for. A live button opening
             * nothing is worse than a dead one.
             */
            disabled={!config || !preset}
            onClick={() => {
              buzz('tap');
              setOpen(true);
            }}
          >
            Configure
          </button>
        </div>

        {isLoading && <div style={faint}>Loading…</div>}
        {error && (
          <div style={{ color: 'var(--error)', fontSize: 'var(--type-detail)' }}>
            {error instanceof Error ? error.message : 'Could not read the MoA config'}
          </div>
        )}

        {preset && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <SlotLine
              label="Aggregator"
              value={slotLabel(preset.aggregator)}
              note="acts and writes the reply"
              warn={gaps.aggregator}
            />
            {preset.reference_models.map((slot, i) => (
              <SlotLine
                key={`${slot.provider}/${slot.model}/${i}`}
                label={`Advisor ${i + 1}`}
                value={slotLabel(slot)}
                note={slot.enabled === false ? 'disabled' : undefined}
                warn={slot.enabled !== false && slotCredentialGaps(
                  { ...preset, reference_models: [slot] },
                  options?.providers,
                ).references > 0}
              />
            ))}
          </div>
        )}

        {/*
          * The two failure modes, said in the order they bite. Only shown when
          * the profile is actually on MoA: a warning about a preset nothing
          * runs is noise, and this section is visible on every install.
          */}
        {onMoa && gaps.aggregator && (
          <div style={{ color: 'var(--error)', fontSize: 'var(--type-body-sm)', lineHeight: 1.45, marginTop: 10 }}>
            No credentials found here for the aggregator's provider. Every turn on
            this profile will fail — the aggregator is the model that answers.
          </div>
        )}
        {onMoa && !gaps.aggregator && gaps.references > 0 && (
          <div style={{ color: 'var(--warn)', fontSize: 'var(--type-body-sm)', lineHeight: 1.45, marginTop: 10 }}>
            No credentials found here for {gaps.references} of the advisors. Turns
            still run — the aggregator acts alone when advisors fail.
          </div>
        )}
      </div>

      {config && preset && (
        <MoaSheet
          open={open}
          onClose={() => setOpen(false)}
          profile={profile}
          presetName={presetName}
          presetNames={presetNames}
          preset={preset}
          busy={save.isPending}
          onSave={async (next) => {
            try {
              await save.mutateAsync({ config, name: presetName, preset: next, profile });
              buzz('done');
              toast(`Saved preset "${presetName}"`, 'success');
              setOpen(false);
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Could not save the preset', 'error');
            }
          }}
        />
      )}
    </>
  );
}

function SlotLine({
  label,
  value,
  note,
  warn = false,
}: {
  label: string;
  value: string;
  note?: string;
  warn?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', width: 76, flexShrink: 0 }}>
        {label}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 'var(--type-body-sm)',
            overflowWrap: 'anywhere',
            color: warn ? 'var(--warn)' : 'var(--text)',
          }}
        >
          {value}
        </span>
        {note && (
          <span style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)' }}> · {note}</span>
        )}
      </div>
    </div>
  );
}

/**
 * The editor, holding a draft.
 *
 * Every edit is local until Save, for the reason the backend answers 422
 * instead of repairing: a preset is only valid as a whole, and writing each
 * change as it is made would mean saving a half-filled slot on the way to a
 * complete one. `moaPayloadProblems` runs the backend's own rules over the
 * draft so Save can say what is wrong instead of the API doing it afterwards.
 */
function MoaSheet({
  open,
  onClose,
  profile,
  presetName,
  presetNames,
  preset,
  busy,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  profile: string | null;
  presetName: string;
  presetNames: string[];
  preset: MoaPreset;
  busy: boolean;
  onSave: (preset: MoaPreset) => void;
}) {
  const [draft, setDraft] = useState<MoaPreset>(preset);
  /** Which slot the picker is filling: the aggregator, or a reference index. */
  const [picking, setPicking] = useState<'aggregator' | number | null>(null);

  // Re-seed when the sheet opens, and when a save elsewhere changes what is
  // stored — an editor holding a stale draft would write it back on Save.
  useEffect(() => {
    if (open) setDraft(preset);
  }, [open, preset]);

  const problems = moaPayloadProblems(draft);
  const setSlot = (where: 'aggregator' | number, slot: MoaSlot) =>
    setDraft((d) =>
      where === 'aggregator'
        ? { ...d, aggregator: slot }
        : { ...d, reference_models: d.reference_models.map((s, i) => (i === where ? slot : s)) },
    );

  return (
    <>
      <Sheet open={open} onClose={onClose} title={`Preset "${presetName}"`}>
        <div style={{ ...faint, marginBottom: 14 }}>
          The aggregator is the model that acts and writes the reply. Advisors
          answer first and their analysis is handed to it — they never speak to
          you directly, and a turn survives all of them failing.
          {presetNames.length > 1 && ` This profile has ${presetNames.length} presets; only this one is edited here.`}
        </div>

        <div className="group-head" style={{ paddingLeft: 0 }}>AGGREGATOR</div>
        <SlotRow
          value={slotLabel(draft.aggregator)}
          onPick={() => setPicking('aggregator')}
          busy={busy}
        />

        <div className="group-head" style={{ paddingLeft: 0, marginTop: 16 }}>ADVISORS</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {draft.reference_models.map((slot, i) => (
            <SlotRow
              key={i}
              value={slotLabel(slot)}
              onPick={() => setPicking(i)}
              busy={busy}
              enabled={slot.enabled !== false}
              onToggle={() => setSlot(i, { ...slot, enabled: slot.enabled === false })}
              onRemove={() =>
                setDraft((d) => ({
                  ...d,
                  reference_models: d.reference_models.filter((_, j) => j !== i),
                }))
              }
            />
          ))}
          <button
            className="btn btn--sm"
            disabled={busy}
            onClick={() => {
              buzz('tap');
              setDraft((d) => ({ ...d, reference_models: [...d.reference_models, { ...EMPTY_SLOT }] }));
            }}
          >
            Add advisor
          </button>
        </div>

        <div className="group-head" style={{ paddingLeft: 0, marginTop: 16 }}>WHEN ADVISORS RUN</div>
        <div className="btn-group" role="radiogroup" aria-label="Advisor cadence">
          {FANOUTS.map((f) => {
            const active = (draft.fanout || 'user_turn') === f.id;
            return (
              <button
                key={f.id}
                role="radio"
                aria-checked={active}
                className={`btn-group__item${active ? ' btn-group__item--active' : ''}`}
                disabled={busy}
                onClick={() => {
                  buzz('tap');
                  setDraft((d) => ({ ...d, fanout: f.id }));
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <div style={{ ...faint, marginTop: 6 }}>
          {/*
            * `every_n:<N>` is the third cadence and has no control here — two
            * buttons and a number field is a config screen. A preset already
            * set to it keeps it: the draft's own value is only overwritten by
            * pressing one of these.
            */}
          {(draft.fanout || 'user_turn').startsWith('every_n')
            ? `Currently set to "${draft.fanout}" — advisors run every few tool steps. Picking one of the above replaces that.`
            : FANOUTS.find((f) => f.id === (draft.fanout || 'user_turn'))?.hint}
        </div>

        {problems.length > 0 && (
          <ul style={{ color: 'var(--warn)', fontSize: 'var(--type-body-sm)', lineHeight: 1.5, margin: '14px 0 0', paddingLeft: 18 }}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            style={{ flex: 1 }}
            disabled={busy || problems.length > 0}
            onClick={() => onSave(draft)}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div style={{ ...faint, marginTop: 10 }}>
          Saved to this profile's config, for new chats. A per-advisor token cap
          set by hand in `config.yaml` is not carried through this form.
        </div>
      </Sheet>

      {/*
        * Stacked on the editor rather than replacing it, so back closes the
        * picker and leaves the half-made preset alone — `useHistoryDismiss`
        * nests, which is the whole reason a sheet may open another.
        */}
      <Sheet
        open={picking !== null}
        onClose={() => setPicking(null)}
        title={picking === 'aggregator' ? 'Aggregator model' : 'Advisor model'}
      >
        <ModelPicker
          profile={profile}
          exclude={['moa']}
          selected={
            picking === 'aggregator'
              ? draft.aggregator.model
              : typeof picking === 'number'
                ? draft.reference_models[picking]?.model
                : undefined
          }
          onPick={(model, provider) => {
            if (picking === null) return;
            const current =
              picking === 'aggregator' ? draft.aggregator : draft.reference_models[picking];
            setSlot(picking, { ...(current ?? EMPTY_SLOT), provider, model });
            setPicking(null);
          }}
        />
      </Sheet>
    </>
  );
}

/**
 * One editable slot: what it is set to, a tap to change it, and — for an
 * advisor — the two things an advisor can have done to it.
 *
 * Disabling rather than removing is offered because they are different
 * intentions: a removed advisor has to be found again in a list of hundreds,
 * a disabled one is a configured choice sitting the next turns out.
 */
function SlotRow({
  value,
  onPick,
  busy,
  enabled,
  onToggle,
  onRemove,
}: {
  value: string;
  onPick: () => void;
  busy: boolean;
  enabled?: boolean;
  onToggle?: () => void;
  onRemove?: () => void;
}) {
  const off = enabled === false;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        className="btn btn--sm"
        style={{
          flex: 1,
          minWidth: 0,
          justifyContent: 'flex-start',
          fontFamily: 'var(--mono)',
          textAlign: 'left',
          opacity: off ? 0.55 : 1,
        }}
        disabled={busy}
        onClick={() => {
          buzz('tap');
          onPick();
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value}
        </span>
      </button>
      {onToggle && (
        <button
          className="btn btn--sm"
          disabled={busy}
          aria-pressed={!off}
          onClick={() => {
            buzz('tap');
            onToggle();
          }}
        >
          {off ? 'Off' : 'On'}
        </button>
      )}
      {onRemove && (
        <button
          className="btn btn--sm"
          disabled={busy}
          aria-label="Remove advisor"
          onClick={() => {
            buzz('tap');
            onRemove();
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
