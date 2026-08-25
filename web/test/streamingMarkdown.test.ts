/**
 * Where the streaming bubble is allowed to cut its markdown in half.
 *
 * This is tested rather than eyeballed because both ways of being wrong are
 * invisible until they are not. Splitting too eagerly corrupts the rendered
 * message — two fences out of one, an ordered list that restarts at 1 halfway
 * down — and only while a reply is streaming, which is the state hardest to
 * catch and impossible to reproduce from a saved transcript. Splitting too
 * timidly renders perfectly and silently gives back the whole optimisation.
 *
 * So: the "must not split" cases pin correctness, and the "must split" cases
 * pin that the thing still does its job.
 */
import { describe, it, expect } from 'vitest';
import { splitStableMarkdown } from '../src/lib/streamingMarkdown';

/** The split has to be lossless — the two halves rejoin to the original. */
function roundTrips(text: string): boolean {
  const { stable, open } = splitStableMarkdown(text);
  return (stable ? `${stable}\n${open}` : open) === text;
}

describe('splitStableMarkdown', () => {
  it('keeps a single block whole', () => {
    expect(splitStableMarkdown('Just one paragraph, still going')).toEqual({
      stable: '',
      open: 'Just one paragraph, still going',
    });
  });

  it('splits between two paragraphs', () => {
    const text = 'Finished paragraph.\n\nOne being writ';
    expect(splitStableMarkdown(text)).toEqual({
      stable: 'Finished paragraph.\n',
      open: 'One being writ',
    });
  });

  it('splits at the last boundary, not the first', () => {
    // The point is to leave as little as possible to re-parse.
    const text = 'One.\n\nTwo.\n\nThree in prog';
    expect(splitStableMarkdown(text).open).toBe('Three in prog');
  });

  it('is lossless', () => {
    for (const text of [
      'a\n\nb',
      'a\n\n\n\nb',
      '# Head\n\ntext\n\n```js\ncode',
      '- one\n\n- two\n\nafter',
      '',
      '\n\n',
    ]) {
      expect(roundTrips(text), JSON.stringify(text)).toBe(true);
    }
  });

  it('never splits inside a fenced code block', () => {
    // The blank line here is code, not a boundary. Splitting produces two
    // unterminated fences and renders the second half as prose.
    const text = 'Intro:\n\n```python\ndef f():\n\n    return 1';
    const { stable, open } = splitStableMarkdown(text);
    expect(stable).toBe('Intro:\n');
    expect(open).toBe('```python\ndef f():\n\n    return 1');
  });

  it('resumes splitting after a fence closes', () => {
    const text = '```js\nlet a = 1;\n```\n\nAnd then';
    expect(splitStableMarkdown(text)).toEqual({
      stable: '```js\nlet a = 1;\n```\n',
      open: 'And then',
    });
  });

  it('does not let a shorter or different fence close a longer one', () => {
    const text = '````\n```\n\nstill inside the outer fence';
    expect(splitStableMarkdown(text).stable).toBe('');
    expect(splitStableMarkdown('~~~\n```\n\nstill inside').stable).toBe('');
  });

  it('never splits a loose list into two lists', () => {
    // An ordered list cut here renders as "1. 2." then "1." again — the most
    // visible possible corruption, and the case that motivated the rule.
    const text = '1. first\n\n2. second\n\n3. thi';
    expect(splitStableMarkdown(text).stable).toBe('');
  });

  it('leaves bullet and blockquote continuations alone', () => {
    expect(splitStableMarkdown('- a\n\n- b').stable).toBe('');
    expect(splitStableMarkdown('> quoted\n\n> more').stable).toBe('');
  });

  it('leaves a table continuing across a blank line alone', () => {
    expect(splitStableMarkdown('| a | b |\n| - | - |\n\n| 1 | 2 |').stable).toBe('');
  });

  it('leaves indented continuations alone', () => {
    // Indented text after a blank line belongs to the block above it.
    expect(splitStableMarkdown('- item\n\n    continued').stable).toBe('');
  });

  it('splits before a paragraph that follows a list', () => {
    // The list is closed by a non-continuation line, so this is safe and is
    // the ordinary case in a long answer.
    const text = '- a\n- b\n\nAnd in conclu';
    expect(splitStableMarkdown(text)).toEqual({ stable: '- a\n- b\n', open: 'And in conclu' });
  });

  it('splits before a heading and before a fence', () => {
    expect(splitStableMarkdown('text\n\n## Head').open).toBe('## Head');
    expect(splitStableMarkdown('text\n\n```js\nlet').open).toBe('```js\nlet');
  });

  it('never puts the first line in the open part alone', () => {
    // A leading blank line is not a boundary; there is nothing above it.
    expect(splitStableMarkdown('\nfirst').stable).toBe('');
  });
});
