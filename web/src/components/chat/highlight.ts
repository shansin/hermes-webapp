/**
 * Syntax highlighting, carrying only the grammars this app sees.
 *
 * `rehype-highlight` was doing this job and cost about 60KB gzipped inside the
 * Markdown chunk, nearly all of it grammars — lowlight's `common` set is
 * around thirty-seven languages, and a Hermes transcript contains perhaps ten.
 *
 * Its `languages` option cannot shrink that. The plugin does
 * `import {common} from 'lowlight'` at module scope, so `common` is reachable
 * whatever options are passed and the bundler must keep it; the option only
 * *adds*. That was tried before and reverted, and the note it left behind in
 * this directory is what this file replaces.
 *
 * So the plugin is here instead. It is small — find the code blocks, hand the
 * text to lowlight, put the result back — and being here is what lets the
 * grammar list be a real list: only what is registered below is imported, and
 * everything else is never referenced and never bundled.
 *
 * Adding a language is one import and one `register` line. The cost of an
 * absent one is small and visible in the right direction: an unknown fence
 * renders as plain code, exactly as an unlabelled one already does, because
 * detection is off (see below).
 */
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const lowlight = createLowlight({
  bash,
  css,
  diff,
  javascript,
  json,
  markdown,
  python,
  sql,
  typescript,
  // highlight.js files HTML under `xml`; the alias below is how a ```html
  // fence finds it.
  xml,
  yaml,
});

lowlight.registerAlias({
  bash: ['sh', 'shell', 'zsh', 'console'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  typescript: ['ts', 'tsx'],
  markdown: ['md'],
  python: ['py'],
  xml: ['html', 'svg'],
  yaml: ['yml'],
});

/** Minimal hast, to the extent this plugin touches it. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

/** The fence's declared language, or null. */
function languageOf(node: HastNode): string | null {
  const cls = node.properties?.className;
  const names = Array.isArray(cls) ? cls : typeof cls === 'string' ? cls.split(/\s+/) : [];
  for (const name of names) {
    const m = /^language-([\w-]+)$/.exec(String(name));
    if (m?.[1]) return m[1].toLowerCase();
  }
  return null;
}

/** Everything under a node, flattened — the source text of the block. */
function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/**
 * Highlight fenced code blocks.
 *
 * Deliberately no auto-detection, which is the behaviour this replaces rather
 * than a simplification of it. Detection ran highlight.js' classifier over
 * every block on every render — during streaming, once per frame, on a
 * fragment still being written — and guesses badly on short input. A fence
 * that declares its language highlights; one that does not renders as plain
 * code.
 */
export function rehypeHighlightLocal() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      for (const child of node.children ?? []) {
        if (
          node.tagName === 'pre' &&
          child.type === 'element' &&
          child.tagName === 'code'
        ) {
          const lang = languageOf(child);
          // `registered` covers aliases too, so an unknown fence falls through
          // to plain code rather than throwing out of the render.
          if (lang && lowlight.registered(lang)) {
            const result = lowlight.highlight(lang, textOf(child)) as unknown as HastNode;
            child.children = result.children ?? [];
          }
          // `hljs` carries the theme's background and base colour, and is
          // wanted whether or not a grammar was found.
          const cls = child.properties?.className;
          const names = Array.isArray(cls) ? [...(cls as unknown[])] : cls ? [cls] : [];
          if (!names.includes('hljs')) names.push('hljs');
          child.properties = { ...child.properties, className: names };
        }
        walk(child);
      }
    };
    walk(tree);
    return tree;
  };
}
