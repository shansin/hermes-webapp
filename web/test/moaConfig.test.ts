/**
 * What a Mixture of Agents save carries, and what it would quietly destroy.
 *
 * `PUT /api/model/moa` merges at the `moa` key, not per preset — the backend
 * does `cfg.setdefault("moa", {}).update(normalized)`, so the `presets` map it
 * receives *replaces* the stored one. A payload naming only the preset being
 * edited therefore deletes every other preset in the profile, with a success
 * response and nothing on screen to show for it. The same shape of loss sits
 * one level down: `MoaPresetPayload` has a default for every field, so a
 * per-preset value left out of the payload does not stay as it was, it
 * silently becomes 4096 / "loud" / null.
 *
 * Neither failure is visible from the app that caused it, which is what these
 * tests are for.
 *
 * The other half is `slotCredentialGaps`. The failure it exists to predict —
 * an aggregator whose provider has no key here — ends every turn on the
 * profile, and until this it was reported by nothing except the text of a
 * failed run.
 */
import { describe, it, expect } from 'vitest';
import {
  MoaConfigSchema,
  moaPayloadProblems,
  moaSavePayload,
  slotCredentialGaps,
  type MoaPreset,
} from '../src/api/moa';

const preset = (over: Partial<MoaPreset> = {}): MoaPreset =>
  MoaConfigSchema.parse({
    presets: {
      p: {
        reference_models: [{ provider: 'anthropic', model: 'claude-opus-4.8' }],
        aggregator: { provider: 'copilot', model: 'gpt-5.5' },
        ...over,
      },
    },
  }).presets.p;

const config = (presets: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
  MoaConfigSchema.parse({ default_preset: 'default', presets, ...rest });

describe('moaSavePayload', () => {
  /* The deletion trap: `update()` replaces the whole presets map. */
  it('sends every preset, not only the one being edited', () => {
    const cfg = config({
      default: { reference_models: [{ provider: 'a', model: 'm' }], aggregator: { provider: 'b', model: 'n' } },
      cheap: { reference_models: [{ provider: 'c', model: 'o' }], aggregator: { provider: 'd', model: 'p' } },
    });
    const body = moaSavePayload(cfg, 'default', preset());
    expect(Object.keys(body.presets).sort()).toEqual(['cheap', 'default']);
    expect(body.presets.cheap.aggregator).toMatchObject({ provider: 'd', model: 'p' });
    expect(body.presets.default.aggregator).toMatchObject({ provider: 'copilot', model: 'gpt-5.5' });
  });

  /*
   * Every per-preset field has a default on the payload model, so one omitted
   * here is one reset there. Checked field by field because the ones that
   * would hurt most (a token cap, a cadence) are also the ones nothing on the
   * screen would show had changed.
   */
  it('round-trips the fields it does not edit', () => {
    const cfg = config({
      default: {
        reference_models: [{ provider: 'a', model: 'm' }],
        aggregator: { provider: 'b', model: 'n' },
        max_tokens: 8192,
        reference_max_tokens: 600,
        reference_temperature: 0.4,
        aggregator_temperature: 0.1,
        reference_timeout: 300,
        degraded_reference_policy: 'silent',
        fanout: 'every_n:3',
      },
    });
    const saved = moaSavePayload(cfg, 'default', cfg.presets.default).presets.default;
    expect(saved).toMatchObject({
      max_tokens: 8192,
      reference_max_tokens: 600,
      reference_temperature: 0.4,
      aggregator_temperature: 0.1,
      reference_timeout: 300,
      degraded_reference_policy: 'silent',
      fanout: 'every_n:3',
    });
  });

  /* A disabled advisor is a kept choice, not a removed one. */
  it('keeps a disabled advisor in the payload', () => {
    const p = preset({
      reference_models: [
        { provider: 'a', model: 'm', enabled: false },
        { provider: 'b', model: 'n' },
      ],
    });
    const saved = moaSavePayload(config({ default: {} }), 'default', p).presets.default;
    expect(saved.reference_models).toHaveLength(2);
    expect(saved.reference_models[0]).toMatchObject({ provider: 'a', enabled: false });
  });

  it('preserves the preset name being edited when it is a new one', () => {
    const body = moaSavePayload(config({ default: {} }), 'experiment', preset());
    expect(Object.keys(body.presets).sort()).toEqual(['default', 'experiment']);
  });
});

/* Mirrors `validate_moa_payload`; the backend answers 422 rather than repairing. */
describe('moaPayloadProblems', () => {
  it('passes a complete preset', () => {
    expect(moaPayloadProblems(preset())).toEqual([]);
  });

  it('names a half-filled advisor by its position', () => {
    const p = preset({
      reference_models: [
        { provider: 'anthropic', model: 'claude-opus-4.8' },
        { provider: 'openrouter', model: '' },
      ],
    });
    expect(moaPayloadProblems(p)).toEqual(['Advisor 2: no model picked for openrouter.']);
  });

  it('refuses a preset with no complete advisor', () => {
    const p = preset({ reference_models: [] });
    expect(moaPayloadProblems(p)).toContain('Needs at least one complete advisor model.');
  });

  it('refuses an empty aggregator', () => {
    const p = preset({ aggregator: { provider: '', model: '', enabled: true } });
    expect(moaPayloadProblems(p).some((m) => m.startsWith('Aggregator:'))).toBe(true);
  });

  /* Recursive MoA: the runtime only discovers it mid-turn. */
  it('refuses MoA inside a preset', () => {
    const p = preset({ aggregator: { provider: 'moa', model: 'default', enabled: true } });
    expect(moaPayloadProblems(p).join(' ')).toContain('cannot be used inside a preset');
  });
});

describe('slotCredentialGaps', () => {
  const known = [{ slug: 'anthropic' }, { slug: 'copilot' }];

  /* The one that ends every turn. */
  it('flags an aggregator whose provider is not authenticated', () => {
    const p = preset({ aggregator: { provider: 'openrouter', model: 'x', enabled: true } });
    expect(slotCredentialGaps(p, known)).toEqual({ aggregator: true, references: 0 });
  });

  it('counts advisors separately from the aggregator', () => {
    const p = preset({
      reference_models: [
        { provider: 'openrouter', model: 'a' },
        { provider: 'openai-codex', model: 'b' },
        { provider: 'anthropic', model: 'c' },
      ],
    });
    expect(slotCredentialGaps(p, known)).toEqual({ aggregator: false, references: 2 });
  });

  it('ignores a disabled advisor', () => {
    const p = preset({
      reference_models: [{ provider: 'openrouter', model: 'a', enabled: false }],
    });
    expect(slotCredentialGaps(p, known).references).toBe(0);
  });

  /*
   * With no catalogue in hand there is no evidence either way, and a warning
   * on a working preset is worse than none: it would appear on every load
   * before the picker query resolves.
   */
  it('claims nothing when the provider list is missing or empty', () => {
    const p = preset({ aggregator: { provider: 'openrouter', model: 'x', enabled: true } });
    expect(slotCredentialGaps(p, undefined)).toEqual({ aggregator: false, references: 0 });
    expect(slotCredentialGaps(p, [])).toEqual({ aggregator: false, references: 0 });
    expect(slotCredentialGaps(undefined, known)).toEqual({ aggregator: false, references: 0 });
  });

  it('matches provider slugs case-insensitively', () => {
    const p = preset({ aggregator: { provider: 'Anthropic', model: 'x', enabled: true } });
    expect(slotCredentialGaps(p, known).aggregator).toBe(false);
  });

  /* The MoA row is always present and always authenticated — it proves nothing. */
  it('never flags the virtual moa provider itself', () => {
    const p = preset({ aggregator: { provider: 'moa', model: 'default', enabled: true } });
    expect(slotCredentialGaps(p, known).aggregator).toBe(false);
  });
});

describe('MoaConfigSchema', () => {
  /*
   * The response also carries a flattened copy of the default preset at the
   * top level for older clients. Parsing must not confuse it for a preset.
   */
  it('reads presets and tolerates the flattened compatibility view', () => {
    const parsed = MoaConfigSchema.parse({
      default_preset: 'default',
      active_preset: '',
      presets: { default: { reference_models: [], aggregator: { provider: 'a', model: 'b' } } },
      reference_models: [],
      aggregator: { provider: 'a', model: 'b' },
      max_tokens: 4096,
    });
    expect(Object.keys(parsed.presets)).toEqual(['default']);
    expect(parsed.presets.default.aggregator.model).toBe('b');
  });

  /* A payload missing a key is a 200 from a Hermes that predates it. */
  it('survives a preset with nothing in it', () => {
    const parsed = MoaConfigSchema.parse({ presets: { default: {} } });
    expect(parsed.presets.default.reference_models).toEqual([]);
    expect(parsed.presets.default.aggregator).toMatchObject({ provider: '', model: '' });
    expect(parsed.presets.default.max_tokens).toBe(4096);
  });
});
