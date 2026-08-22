/**
 * Summarising the auxiliary model assignments.
 *
 * Hermes gives every auxiliary task — titles, vision, compression, approval
 * and the rest — its own model slot, and this app sets all of them together.
 * The summary line is the only place a person sees what those eleven slots
 * currently say, and every wrong answer it could give looks perfectly
 * plausible: reporting one task's model as if it spoke for the rest, or
 * calling the factory state "Mixed", would both read as fact while quietly
 * misdescribing where the tokens are being billed.
 */
import { describe, expect, it } from 'vitest';
import { summariseAuxiliary } from '../src/components/hub/AuxiliaryModelSection';

describe('summariseAuxiliary', () => {
  it('calls the factory state Auto rather than naming a model', () => {
    const s = summariseAuxiliary([{ model: '' }, { model: '' }, { model: '' }]);
    expect(s.label).toBe('Auto');
    expect(s.uniform).toBe('');
  });

  it('names the model when every task agrees', () => {
    const s = summariseAuxiliary([{ model: 'haiku-4.5' }, { model: 'haiku-4.5' }]);
    expect(s.label).toBe('haiku-4.5');
    expect(s.detail).toBe('Used for all 2 auxiliary tasks');
    expect(s.uniform).toBe('haiku-4.5');
  });

  /**
   * The case that matters: showing `tasks[0]` here would claim everything runs
   * on one model while some of it silently bills to another.
   */
  it('refuses to speak for tasks that disagree', () => {
    const s = summariseAuxiliary([{ model: 'haiku-4.5' }, { model: 'opus-5' }, { model: '' }]);
    expect(s.label).toBe('Mixed');
    expect(s.uniform).toBeNull();
    expect(s.detail).toContain('2 different models across 3 tasks');
  });

  it('treats a partially-set fleet as mixed, not as set', () => {
    const s = summariseAuxiliary([{ model: 'haiku-4.5' }, { model: '' }]);
    expect(s.label).toBe('Mixed');
  });

  /** An empty list is "auto" in effect and must not read as a disagreement. */
  it('does not call an empty list Mixed', () => {
    const s = summariseAuxiliary([]);
    expect(s.label).toBe('Auto');
    expect(s.uniform).toBe('');
  });
});
