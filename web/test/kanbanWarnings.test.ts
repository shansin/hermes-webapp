/**
 * The warning badge's tooltip, and the shape it is built from.
 *
 * A card's `warnings.kinds` reads like a list of names and is not: Hermes
 * answers a **map of kind → count** (`{repeated_failures: 2}`). Typed as
 * `string[]` that cost nothing at compile time and threw
 * `kinds.join is not a function` on the first card carrying a warning — and
 * with no error boundary anywhere in `App.tsx`, the throw unmounted every
 * screen, so `/kanban` was a blank page rather than a card missing a tooltip.
 *
 * Found by driving the real build in a browser against the live backend, which
 * is the only place it showed: the whole suite passed while the board was
 * blank, because nothing here rendered a card that had a warning on it.
 *
 * Both shapes are accepted on purpose. The plugin's routes are undocumented and
 * this app runs against Hermes versions it was not built with, so the failure
 * mode for a shape drift has to be a missing tooltip, never a lost board.
 */
import { describe, expect, it } from 'vitest';
import { warningKinds } from '../src/api/kanban';

describe('warningKinds', () => {
  it('renders the kind → count map Hermes actually sends', () => {
    expect(warningKinds({ repeated_failures: 2 })).toBe('repeated_failures ×2');
  });

  it('omits the count for a kind seen once, which is the common card', () => {
    expect(warningKinds({ spawn_failure: 1 })).toBe('spawn_failure');
  });

  it('joins several kinds, counting only the repeated ones', () => {
    expect(warningKinds({ repeated_failures: 3, stale_claim: 1 })).toBe(
      'repeated_failures ×3, stale_claim',
    );
  });

  it('still renders a plain array, which is what the type used to claim', () => {
    expect(warningKinds(['repeated_failures', 'stale_claim'])).toBe(
      'repeated_failures, stale_claim',
    );
  });

  /*
   * The cases that used to throw. Each is a payload a version-drifted plugin
   * can produce, and none of them may be worse than an empty tooltip.
   */
  it('answers empty for an absent, null or non-object kinds', () => {
    expect(warningKinds(undefined)).toBe('');
    expect(warningKinds(null)).toBe('');
    expect(warningKinds('repeated_failures' as unknown as string[])).toBe('');
    expect(warningKinds(7 as unknown as string[])).toBe('');
  });

  it('drops non-string entries from an array rather than printing "undefined"', () => {
    expect(warningKinds([null, 'stale_claim'] as unknown as string[])).toBe('stale_claim');
  });

  it('treats a non-numeric count as a bare kind', () => {
    expect(warningKinds({ repeated_failures: 'lots' } as unknown as Record<string, number>)).toBe(
      'repeated_failures',
    );
  });

  it('answers empty for an empty map, so the title attribute stays absent', () => {
    expect(warningKinds({})).toBe('');
  });
});
