/**
 * Session tags.
 *
 * There is no tag field on the wire, so a `#tag` written into the title *is*
 * the storage — which means the parser has to be conservative. Anything it
 * mistakes for a tag disappears out of the title it was displaying.
 */
import { describe, expect, it } from 'vitest';
import { collectTags, hasTag, parseTags, tagHue } from '../src/lib/sessionTags';

describe('parsing', () => {
  it('lifts a tag out of the title', () => {
    expect(parseTags('Refactor the parser #work')).toEqual({
      text: 'Refactor the parser',
      tags: ['work'],
    });
  });

  it('handles several tags anywhere in the title', () => {
    expect(parseTags('#urgent Fix the build #ci #work')).toEqual({
      text: 'Fix the build',
      tags: ['urgent', 'ci', 'work'],
    });
  });

  it('accepts hyphens and digits after the first letter', () => {
    expect(parseTags('Thing #in-progress #v2').tags).toEqual(['in-progress', 'v2']);
  });

  /**
   * A tag must start with a letter, so an issue reference stays part of the
   * title rather than vanishing into a tag chip.
   */
  it('leaves an issue number alone', () => {
    expect(parseTags('Fix #123 properly')).toEqual({ text: 'Fix #123 properly', tags: [] });
  });

  it('leaves a URL fragment alone', () => {
    const title = 'See https://example.com/docs#install';
    expect(parseTags(title)).toEqual({ text: title, tags: [] });
  });

  it('collapses the whitespace a removed tag leaves behind', () => {
    expect(parseTags('Fix #ci the build').text).toBe('Fix the build');
  });

  /** A title that is only tags would otherwise render as an empty row. */
  it('keeps something to show for a title that is only tags', () => {
    expect(parseTags('#work #urgent').text).toBe('#work #urgent');
  });

  it.each([null, '', '   '])('handles %j', (title) => {
    expect(parseTags(title)).toEqual({ text: '', tags: [] });
  });
});

describe('collecting', () => {
  it('de-duplicates case-insensitively and sorts', () => {
    expect(collectTags(['a #Work', 'b #work', 'c #ci'])).toEqual(['ci', 'Work']);
  });

  it('keeps the casing it first saw', () => {
    expect(collectTags(['a #Work', 'b #work'])).toEqual(['Work']);
  });

  it('ignores untitled sessions', () => {
    expect(collectTags([null, '', 'a #x'])).toEqual(['x']);
  });
});

describe('matching', () => {
  it('matches regardless of case', () => {
    expect(hasTag('Thing #Work', 'work')).toBe(true);
    expect(hasTag('Thing #work', 'WORK')).toBe(true);
  });

  it('does not match a prefix', () => {
    expect(hasTag('Thing #workshop', 'work')).toBe(false);
  });

  it('does not match an untagged title', () => {
    expect(hasTag('Thing', 'work')).toBe(false);
  });
});

describe('colouring', () => {
  it('gives the same tag the same hue every time', () => {
    expect(tagHue('work')).toBe(tagHue('work'));
  });

  it('stays inside the hue circle', () => {
    for (const tag of ['work', 'ci', 'urgent', '', 'a'.repeat(200)]) {
      expect(tagHue(tag)).toBeGreaterThanOrEqual(0);
      expect(tagHue(tag)).toBeLessThan(360);
    }
  });
});
