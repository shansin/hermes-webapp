/**
 * Markdown renderer with syntax highlighting and copyable code blocks.
 *
 * Code blocks get their own header with the language and a copy button —
 * selecting text precisely on a phone is painful, so copy has to be a tap.
 */
import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { IconCheck, IconCopy } from '../shared/Icons';
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

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre({ children }) {
            const text = nodeText(children);
            // The <code> child carries hljs' detected language class.
            let lang = '';
            const child = Array.isArray(children) ? children[0] : children;
            const cls =
              typeof child === 'object' && child && 'props' in child
                ? ((child as { props?: { className?: string } }).props?.className ?? '')
                : '';
            const m = /language-(\w+)/.exec(cls);
            if (m?.[1]) lang = m[1];

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
