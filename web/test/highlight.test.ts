/**
 * The local syntax-highlighting plugin.
 *
 * It exists to keep thirty-odd unused grammars out of the Markdown chunk (see
 * the file's own note), which means it replaced a well-tested dependency with
 * about eighty lines of tree-walking. These pin the behaviour that swap has to
 * preserve: the fence's language survives, unknown languages degrade to plain
 * code rather than throwing out of the render, and the `hljs` class — which
 * carries the code block's background in every theme — is applied either way.
 *
 * The failure this guards against is quiet in the worst way: an exception
 * inside a rehype plugin takes down the whole message, and a message that
 * fails to render looks like the agent said nothing.
 */
import { describe, it, expect } from 'vitest';
import { rehypeHighlightLocal } from '../src/components/chat/highlight';

/** A `<pre><code class="language-x">source</code></pre>` tree. */
function tree(lang: string | null, source: string) {
  return {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'pre',
        properties: {},
        children: [
          {
            type: 'element',
            tagName: 'code',
            properties: lang ? { className: [`language-${lang}`] } : {},
            children: [{ type: 'text', value: source }],
          },
        ],
      },
    ],
  };
}

function run(lang: string | null, source: string) {
  const root = tree(lang, source);
  rehypeHighlightLocal()(root as never);
  const code = (root.children[0] as { children: { properties?: { className?: unknown } ; children?: unknown[] }[] }).children[0]!;
  return {
    classes: (code.properties?.className ?? []) as string[],
    children: code.children ?? [],
    text: JSON.stringify(code.children),
  };
}

describe('rehypeHighlightLocal', () => {
  it('highlights a declared language', () => {
    const out = run('ts', 'const a: number = 1;');
    // The source is replaced by spans carrying hljs- classes.
    expect(out.children.length).toBeGreaterThan(1);
    expect(out.text).toContain('hljs-keyword');
  });

  it('resolves aliases to their grammar', () => {
    for (const alias of ['js', 'sh', 'yml', 'html', 'py']) {
      expect(() => run(alias, 'x')).not.toThrow();
    }
    expect(run('sh', 'if true; then echo hi; fi').text).toContain('hljs-');
  });

  it('leaves an unregistered language as plain text', () => {
    // Not an error: a fence for a language we do not carry renders as code,
    // which is what an unlabelled fence already does.
    const out = run('brainfuck', '+++[->+++<]');
    expect(out.children).toEqual([{ type: 'text', value: '+++[->+++<]' }]);
  });

  it('leaves an unlabelled fence alone', () => {
    const out = run(null, 'just some text');
    expect(out.children).toEqual([{ type: 'text', value: 'just some text' }]);
  });

  it('always adds the hljs class', () => {
    // It carries the block's background and base colour in every theme, so a
    // block that misses it renders unstyled against the bubble.
    expect(run('ts', 'const a = 1').classes).toContain('hljs');
    expect(run('brainfuck', '+').classes).toContain('hljs');
    expect(run(null, 'x').classes).toContain('hljs');
  });

  it('keeps the language class, which the code block header reads', () => {
    // `Markdown.tsx` pulls the label — and the mermaid special case — out of
    // this class, so losing it would blank every code header and stop
    // diagrams rendering.
    expect(run('python', 'x = 1').classes).toContain('language-python');
  });

  it('does not touch inline code', () => {
    // A bare <code> with no <pre> parent is inline code inside a sentence.
    const root = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [
            {
              type: 'element',
              tagName: 'code',
              properties: { className: ['language-ts'] },
              children: [{ type: 'text', value: 'const a = 1' }],
            },
          ],
        },
      ],
    };
    rehypeHighlightLocal()(root as never);
    const code = (root.children[0] as { children: { properties: { className: string[] }; children: unknown[] }[] })
      .children[0]!;
    expect(code.children).toEqual([{ type: 'text', value: 'const a = 1' }]);
    expect(code.properties.className).not.toContain('hljs');
  });

  it('survives a fence nested in a list', () => {
    // The walk has to recurse, not just look at the root's children.
    const root = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'li',
          properties: {},
          children: tree('json', '{"a": 1}').children,
        },
      ],
    };
    rehypeHighlightLocal()(root as never);
    expect(JSON.stringify(root)).toContain('hljs-attr');
  });
});
