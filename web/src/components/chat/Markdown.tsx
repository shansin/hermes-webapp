/**
 * Markdown renderer with syntax highlighting and copyable code blocks.
 *
 * Code blocks get their own header with the language and a copy button —
 * selecting text precisely on a phone is painful, so copy has to be a tap.
 */
import { memo, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Link } from 'react-router-dom';
import { IconCheck, IconCopy } from '../shared/Icons';
import { MermaidBlock } from './MermaidBlock';
import { useSession } from '../../store/session';
import { buzz } from '../../lib/haptics';

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="code__copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          buzz('tap');
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard needs a secure context; silently no-op on plain HTTP
          // where it is unavailable.
        }
      }}
    >
      {copied ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <IconCheck size={12} /> Copied
        </span>
      ) : (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <IconCopy size={12} /> Copy
        </span>
      )}
    </button>
  );
}

/** Recursively flatten a React subtree back to plain text, for copying. */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

/**
 * Resolve a `workspace://relative/path` link against the session's working
 * directory, since the file API only speaks absolute paths. Returns null for
 * ordinary links, and for a workspace link we have no root to resolve against.
 */
function workspacePath(href: string | undefined, cwd: string | undefined): string | null {
  if (!href?.startsWith('workspace://')) return null;
  const rel = href.slice('workspace://'.length).replace(/^\/+/, '');
  if (!rel) return null;
  if (!cwd) return null;
  return `${cwd.replace(/\/+$/, '')}/${rel}`;
}

/**
 * Hoisted so the array identities are stable. react-markdown rebuilds its
 * unified processor whenever the plugin list changes, and the streaming bubble
 * renders this component repeatedly for the length of a turn.
 *
 * `detect` is off. Auto-detection ran highlight.js' classifier over every code
 * block on every render — during streaming that is once per frame, on a
 * fragment that is still being written — and it guesses badly on short input.
 * Fences that declare a language still highlight, across lowlight's full
 * common set; an undeclared one renders as plain code.
 *
 * (Narrowing the grammar list was tried and reverted: `rehype-highlight`
 * imports lowlight's `common` at module scope, so passing `languages` adds
 * grammars without letting the bundler drop any.)
 */
type MarkdownProps = ComponentProps<typeof ReactMarkdown>;

const remarkPlugins: MarkdownProps['remarkPlugins'] = [remarkGfm];
const rehypePlugins: MarkdownProps['rehypePlugins'] = [
  [rehypeHighlight, { detect: false, ignoreMissing: true }],
];

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  // The workspace root for resolving `workspace://` links.
  const cwd = useSession((s) => s.info?.cwd) ?? undefined;

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          pre({ children }) {
            const text = nodeText(children);
            // The <code> child carries the fence's language class.
            let lang = '';
            const child = Array.isArray(children) ? children[0] : children;
            const cls =
              typeof child === 'object' && child && 'props' in child
                ? ((child as { props?: { className?: string } }).props?.className ?? '')
                : '';
            const m = /language-(\w+)/.exec(cls);
            if (m?.[1]) lang = m[1];

            // A mermaid fence becomes a diagram instead of a code block. Only
            // an explicit fence qualifies, which is the only kind there is now
            // that detection is off — a guess rendered through mermaid would
            // mangle real code.
            if (lang === 'mermaid' && text.trim()) {
              return <MermaidBlock source={text.trim()} />;
            }

            return (
              <div className="code">
                <div className="code__head">
                  <span>{lang || 'code'}</span>
                  <CopyButton getText={() => text} />
                </div>
                <pre>{children}</pre>
              </div>
            );
          },
          a({ children, href }) {
            // `workspace://path` is how the agent points at a file it touched.
            // Opening it in the file browser is the whole reason those links
            // exist; left alone the browser treats the scheme as unknown and
            // the link does nothing at all.
            const ws = workspacePath(href, cwd);
            if (ws) {
              return <Link to={`/files?path=${encodeURIComponent(ws)}`}>{children}</Link>;
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
