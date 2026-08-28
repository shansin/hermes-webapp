/**
 * Pinning a model, a provider and a thinking depth to one card.
 *
 * The dispatcher passes these to the worker as `-m <model> --provider <name>
 * --reasoning <level>`, overriding the *profile's* config for this task alone.
 * That is the whole point: "run this one card on the big model" otherwise means
 * editing the agent's own defaults, running the card, and remembering to put
 * them back — three steps, the third of which is the one people forget.
 *
 * Two shapes in the API drive how this is built:
 *
 * - **`provider_override` requires `model_override`.** Hermes rejects a
 *   provider on its own, so the picker is one list of provider+model pairs
 *   rather than two independent dropdowns that can be left in an invalid
 *   combination.
 * - **`null` means "unchanged", not "clear".** A partial PATCH cannot express
 *   "go back to the profile's setting" by omission — that is what
 *   `clear_model_override` and `clear_reasoning_effort` are for. So "Inherit"
 *   has to be an explicit option in both lists, and choosing it sends the flag
 *   rather than an empty string.
 *
 * Reasoning is independent of the model: a card can run the profile's own model
 * at a different depth, which is the cheaper half of this control and the one
 * more often wanted.
 */
import { useState } from 'react';
import { SelectChip, SelectSheet, type SelectOption } from '../shared/SelectSheet';
import { useKanbanModelOptions } from '../../api/kanbanAdmin';
import { REASONING_LEVELS, type Task, type TaskPatch } from '../../api/kanban';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

/** The value standing for "use whatever the profile is configured with". */
const INHERIT = '';

/** `provider::model`, so one list can carry a pair the API needs together. */
function pairValue(provider: string, model: string) {
  return `${provider}::${model}`;
}

export function TaskOverrides({
  task,
  onPatch,
  busy,
}: {
  task: Task;
  onPatch: (patch: TaskPatch) => Promise<unknown>;
  busy: boolean;
}) {
  const [pickingModel, setPickingModel] = useState(false);
  const [pickingReasoning, setPickingReasoning] = useState(false);
  const toast = useUi((s) => s.toast);

  // Only fetched once the picker is opened: the catalogue dials every provider
  // and a card sheet should not pay for it just by being opened.
  const options = useKanbanModelOptions(pickingModel);

  const modelOptions: SelectOption[] = [
    { value: INHERIT, label: 'Inherit', hint: "Use the assigned agent's own model" },
    ...(options.data?.providers ?? []).flatMap((p) =>
      p.models.map((m) => ({
        value: pairValue(p.slug, m),
        label: m,
        hint: p.label,
      })),
    ),
  ];

  /**
   * Which option is currently selected.
   *
   * A card can carry a `model_override` with **no** provider — that is a legal
   * state, and it is what a model pinned before the provider was recorded looks
   * like. The exact pair would then match nothing in the catalogue and the
   * sheet would show nothing selected on a card that is very much pinned, so
   * the model name alone is the fallback match.
   */
  const currentModel = !task.model_override
    ? INHERIT
    : (modelOptions.find((o) => o.value === pairValue(task.provider_override ?? '', task.model_override!))
        ?.value ??
      modelOptions.find((o) => o.label === task.model_override)?.value ??
      INHERIT);

  const setModel = async (value: string) => {
    buzz('tap');
    const [provider, model] = value.split('::');
    try {
      await onPatch(
        value === INHERIT
          ? { clear_model_override: true }
          : /* The provider is only sent when there is one. A pair whose
               provider half is empty is a model from a catalogue that did not
               name one, and sending `provider: ""` alongside a model is how you
               get a 400 for a combination the user never made. */
            { model_override: model!, ...(provider ? { provider_override: provider } : {}) },
      );
      toast(value === INHERIT ? 'Model reset to the profile default' : `Pinned to ${model}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not set the model', 'error');
    }
  };

  const setReasoning = async (value: string) => {
    buzz('tap');
    try {
      await onPatch(value === INHERIT ? { clear_reasoning_effort: true } : { reasoning_effort: value });
      toast(value === INHERIT ? 'Reasoning reset' : `Reasoning set to ${value}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not set reasoning', 'error');
    }
  };

  return (
    <>
      <div className="group-head">THIS CARD RUNS WITH</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        <SelectChip
          label="Model"
          value={task.model_override ?? 'Agent default'}
          active={Boolean(task.model_override)}
          onOpen={() => setPickingModel(true)}
        />
        <SelectChip
          label="Thinking"
          value={task.reasoning_effort ?? 'Agent default'}
          active={Boolean(task.reasoning_effort)}
          onOpen={() => setPickingReasoning(true)}
        />
      </div>
      <div
        style={{
          fontSize: 'var(--type-label-sm)',
          color: 'var(--text-faint)',
          marginBottom: 14,
          lineHeight: 1.45,
        }}
      >
        {busy ? 'Saving…' : 'Applies to the next run of this card only — the agent’s own settings are untouched.'}
      </div>

      <SelectSheet
        open={pickingModel}
        title="Model for this card"
        options={modelOptions}
        value={currentModel}
        onChange={(v) => void setModel(v)}
        onClose={() => setPickingModel(false)}
        empty={options.isLoading ? 'Loading the catalogue…' : 'No providers are configured.'}
      />
      <SelectSheet
        open={pickingReasoning}
        title="Thinking depth"
        options={[
          { value: INHERIT, label: 'Inherit', hint: "Use the assigned agent's own setting" },
          ...REASONING_LEVELS.map((level) => ({
            value: level,
            label: level,
            hint: level === 'none' ? 'Turn thinking off entirely' : undefined,
          })),
        ]}
        value={task.reasoning_effort ?? INHERIT}
        onChange={(v) => void setReasoning(v)}
        onClose={() => setPickingReasoning(false)}
      />
    </>
  );
}
