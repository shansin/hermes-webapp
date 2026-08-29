/**
 * Mixture of Agents — the routing mode a profile can be switched into, and the
 * one model setting this app could offer without being able to configure.
 *
 * ## Why this exists
 *
 * `provider: moa` is not a provider. It is a virtual one whose "models" are
 * **preset names**: a preset fans a turn out to a set of *reference* models
 * (advisors), then hands their answers to an *aggregator*, which is the model
 * that actually acts and whose output the user reads. `model.default` under
 * `provider: moa` therefore holds a preset name — a profile pinned to
 * `default` is not on a model called "default".
 *
 * `ModelPicker` has always listed that virtual provider, because
 * `/api/model/options` returns it like any other row (`_moa_provider_row` in
 * `hermes_cli/inventory.py`) with `authenticated: true` hardcoded — true of the
 * *row*, which needs no credential of its own, and says nothing about the
 * models inside the preset. So one tap moved a profile into MoA, and every
 * subsequent turn ran against Hermes' **factory preset** — advisors on
 * `openai-codex` and `openrouter`, aggregator on `openrouter` — none of which
 * had a key on this machine. Advisors failing is survivable (the run degrades
 * to aggregator-alone); the aggregator failing is not, and the turn dies with
 * `No LLM provider configured for task=moa_aggregator`. A scheduled job did
 * exactly that here on 2026-08-29 and the only place the state was visible was
 * the run's error text.
 *
 * Hence two jobs for this module: read what a profile's preset actually points
 * at, and write a new one — plus `slotCredentialGaps`, which is what turns
 * that runtime failure into something the screen can say before a turn spends
 * a minute discovering it.
 *
 * ## What a save must carry
 *
 * `PUT /api/model/moa` merges at the **`moa` key**, not per preset:
 * `cfg.setdefault("moa", {}).update(normalized)` replaces `presets` wholesale,
 * so a payload naming one preset deletes every other. `saveMoaConfig` therefore
 * always sends the whole map, and every per-preset field is round-tripped from
 * the GET — a field left out does not stay as it was, it lands on
 * `MoaPresetPayload`'s own default (`max_tokens: 4096`,
 * `degraded_reference_policy: "loud"`, `fanout: null`).
 *
 * One field cannot be round-tripped and is lost by any write through this
 * route, this app's or Hermes' own desktop GUI's: a **per-slot** `max_tokens`.
 * `MoaModelSlot` (`hermes_cli/web_models.py`) does not declare it, so pydantic
 * drops it on parse and `_slot_dict` never sees it. Preset-level
 * `reference_max_tokens` survives; a cap written by hand onto one advisor does
 * not.
 *
 * The backend validates before saving and answers **422 rather than repairing**
 * — deliberately, because `normalize_moa_config` is tolerant at read time and
 * that same tolerance at write time silently swaps a half-filled preset for
 * the hardcoded defaults. `moaPayloadProblems` mirrors that validator so the
 * sheet can refuse locally with the same wording, and the 422 detail is still
 * surfaced if the two ever disagree.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from './client';
import { withProfile } from './hub';

/**
 * One model in a preset. `provider` + `model` are the only required halves and
 * both must be non-empty for the slot to count — an incomplete one is what the
 * backend refuses rather than repairs.
 *
 * `enabled` is meaningful on a reference (a disabled advisor stays configured
 * but sits the turn out) and ignored on the aggregator, which always runs.
 */
export const MoaSlotSchema = z
  .object({
    provider: z.string().default(''),
    model: z.string().default(''),
    /** Per-slot thinking level; null means the provider's own default. */
    reasoning_effort: z.string().nullish(),
    enabled: z.boolean().default(true),
  })
  .passthrough();
export type MoaSlot = z.infer<typeof MoaSlotSchema>;

export const MoaPresetSchema = z
  .object({
    reference_models: z.array(MoaSlotSchema).default([]),
    aggregator: MoaSlotSchema.default({ provider: '', model: '' }),
    /** null = the parameter is omitted from the call, i.e. provider default. */
    reference_temperature: z.number().nullish(),
    aggregator_temperature: z.number().nullish(),
    /** null = inherit `auxiliary.moa_reference.timeout` (900s). */
    reference_timeout: z.number().nullish(),
    /** Whether a failed advisor is disclosed in the answer. */
    degraded_reference_policy: z.string().default('loud'),
    max_tokens: z.number().default(4096),
    /** null = advisors are uncapped. */
    reference_max_tokens: z.number().nullish(),
    /** `user_turn` | `per_iteration` | `every_n:<N>`. */
    fanout: z.string().nullish(),
    enabled: z.boolean().default(true),
  })
  .passthrough();
export type MoaPreset = z.infer<typeof MoaPresetSchema>;

/**
 * The `moa` config block, normalized.
 *
 * The response also carries a flattened copy of the default preset at the top
 * level (`reference_models`, `aggregator`, …) for older callers. It is ignored
 * here: two shapes for one fact is how they drift, and `presets` is the one
 * that can express more than a single preset.
 */
export const MoaConfigSchema = z
  .object({
    default_preset: z.string().default('default'),
    active_preset: z.string().default(''),
    presets: z.record(MoaPresetSchema).default({}),
  })
  .passthrough();
export type MoaConfig = z.infer<typeof MoaConfigSchema>;

/** An empty slot, for a reference being added before anything is picked. */
export const EMPTY_SLOT: MoaSlot = { provider: '', model: '', enabled: true };

/**
 * One profile's MoA presets.
 *
 * An omitted `?profile=` reads the **active** profile rather than the one on
 * screen, the same trap the rest of the Models screen had — so the profile is
 * always explicit and null is a choice, not an omission.
 *
 * Note what this cannot tell you: `load_config()` merges `DEFAULT_CONFIG`, so a
 * profile that has never saved a `moa:` block still answers with the factory
 * preset, fully populated and indistinguishable from a chosen one. That is
 * precisely the state that fails at runtime, which is why the screen leans on
 * `slotCredentialGaps` rather than on the config looking configured.
 */
export function useMoaConfig(profile?: string | null, enabled = true) {
  return useQuery({
    queryKey: ['moa', profile ?? null],
    queryFn: async () =>
      MoaConfigSchema.parse(await api.get<unknown>(withProfile('/api/model/moa', profile))),
    staleTime: 60_000,
    enabled,
  });
}

/** Field-for-field what `MoaPresetPayload` declares — see the header. */
function presetPayload(preset: MoaPreset) {
  return {
    reference_models: preset.reference_models.map((s) => ({
      provider: s.provider,
      model: s.model,
      ...(s.reasoning_effort ? { reasoning_effort: s.reasoning_effort } : {}),
      enabled: s.enabled,
    })),
    aggregator: {
      provider: preset.aggregator.provider,
      model: preset.aggregator.model,
      ...(preset.aggregator.reasoning_effort
        ? { reasoning_effort: preset.aggregator.reasoning_effort }
        : {}),
      enabled: true,
    },
    reference_temperature: preset.reference_temperature ?? null,
    aggregator_temperature: preset.aggregator_temperature ?? null,
    reference_timeout: preset.reference_timeout ?? null,
    degraded_reference_policy:
      preset.degraded_reference_policy === 'silent' ? 'silent' : 'loud',
    max_tokens: preset.max_tokens,
    reference_max_tokens: preset.reference_max_tokens ?? null,
    fanout: preset.fanout ?? null,
    enabled: preset.enabled,
  };
}

/**
 * Replace one preset and write the whole block back.
 *
 * Takes the config it was read from as well as the edit, because a payload
 * carrying only the edited preset would delete the others — see the header.
 */
export function moaSavePayload(config: MoaConfig, name: string, preset: MoaPreset) {
  const presets = { ...config.presets, [name]: preset };
  return {
    default_preset: config.default_preset || name,
    active_preset: config.active_preset || '',
    presets: Object.fromEntries(
      Object.entries(presets).map(([key, value]) => [key, presetPayload(value)]),
    ),
  };
}

/**
 * The problems the backend would answer 422 for, in its own words.
 *
 * Mirrors `validate_moa_payload` in `hermes_cli/moa_config.py`. Kept here so
 * the sheet can disable Save with a reason attached rather than letting someone
 * fill a form, press it, and read a raw API error — and so an empty advisor row
 * left behind by an interrupted edit is named as the empty row it is.
 */
export function moaPayloadProblems(preset: MoaPreset): string[] {
  const problems: string[] = [];
  let complete = 0;
  preset.reference_models.forEach((slot, i) => {
    const issue = slotProblem(slot);
    if (issue) problems.push(`Advisor ${i + 1}: ${issue}`);
    else complete += 1;
  });
  if (!complete) problems.push('Needs at least one complete advisor model.');
  const agg = slotProblem(preset.aggregator);
  if (agg) problems.push(`Aggregator: ${agg}`);
  return problems;
}

function slotProblem(slot: MoaSlot | undefined): string | null {
  const provider = (slot?.provider || '').trim();
  const model = (slot?.model || '').trim();
  if (!provider && !model) return 'nothing picked yet.';
  if (!provider) return 'no provider.';
  if (!model) return `no model picked for ${provider}.`;
  // Rejected by the backend too: a preset whose slots are themselves MoA is a
  // recursive fan-out, and the runtime only discovers it mid-turn.
  if (provider.toLowerCase() === 'moa') return 'Mixture of Agents cannot be used inside a preset.';
  return null;
}

/**
 * Which of a preset's slots name a provider that has no credentials here.
 *
 * `authenticated` is the wrong signal to read off the picker rows: this app
 * calls `/api/model/options` without `include_unconfigured`, so the payload
 * *is* the authenticated set and a provider's absence from it is the answer.
 * The MoA row itself is excluded — it is always present and always reports
 * authenticated, which is the reason this check is needed in the first place.
 *
 * Deliberately phrased as a suspicion by its callers rather than a verdict: a
 * credential can reach Hermes by a route the picker does not enumerate, and a
 * false alarm on a working preset must not read as an error. The asymmetry is
 * what matters — an advisor with no key degrades the turn, an aggregator with
 * no key ends it.
 */
export function slotCredentialGaps(
  preset: MoaPreset | undefined,
  known: { slug: string }[] | undefined,
): { aggregator: boolean; references: number } {
  if (!preset || !known?.length) return { aggregator: false, references: 0 };
  const have = new Set(known.map((p) => p.slug.trim().toLowerCase()).filter(Boolean));
  const missing = (slot: MoaSlot | undefined) => {
    const provider = (slot?.provider || '').trim().toLowerCase();
    return Boolean(provider) && provider !== 'moa' && !have.has(provider);
  };
  return {
    aggregator: missing(preset.aggregator),
    references: preset.reference_models.filter((s) => s.enabled !== false && missing(s)).length,
  };
}

export function useSaveMoaConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      config,
      name,
      preset,
      profile,
    }: {
      config: MoaConfig;
      name: string;
      preset: MoaPreset;
      profile?: string | null;
    }) =>
      api.put<{ ok?: boolean }>(
        withProfile('/api/model/moa', profile),
        moaSavePayload(config, name, preset),
      ),
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: ['moa', vars.profile ?? null] });
      // The picker's MoA row lists preset *names*, so adding or renaming one
      // changes what the model picker offers.
      void qc.invalidateQueries({ queryKey: ['model-options'] });
    },
  });
}
