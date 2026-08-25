/**
 * Markdown renderer with syntax highlighting and copyable code blocks.
 *
 * Code blocks get their own header with the language and a copy button —
 * selecting text precisely on a phone is painful, so copy has to be a tap.
 */
import { memo, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeHighlightLocal } from './highlight';
import { Link } from 'react-router-dom';
import { IconCheck, IconCopy } from '../shared/Icons';
import { MermaidBlock } from './MermaidBlock';
import { LocalImage } from './LocalImage';
import { localImagePath } from '../../lib/localImages';
import { useSession } from '../../store/session';
import { buzz } from '../../lib/haptics';
import { copyText } from '../../lib/share';

/**
 * Copy a code block.
 *
 * This used to call `navigator.clipboard` directly and swallow the failure,
 * which meant the button did nothing at all over plain HTTP — the app's own
 * default deployment. `copyText` carries the legacy fallback that works there.
 */
function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="code__copy"
      onClick={async () => {
        const ok = await copyText(getText());
        if (!ok) return;
        buzz('tap');
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
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
 * Highlighting is `./highlight.ts` rather than `rehype-highlight`, and that is
 * a size decision: the plugin imports lowlight's `common` set — thirty-seven
 * grammars — at module scope, so no option can shrink it and the bundler
 * cannot drop any. (Passing `languages` was tried and reverted for exactly
 * that reason.) The local plugin registers the ten or so languages a Hermes
 * transcript actually contains and nothing else. Auto-detection stays off
 * there too, for the reason recorded in that file.
 */
type MarkdownProps = ComponentProps<typeof ReactMarkdown>;

/**
 * Let a local image survive sanitizing.
 *
 * `defaultUrlTransform` allows http, https, mailto, irc and xmpp and blanks
 * everything else — so the agent's own `![shot](file:///…/x.png)` arrived at
 * the `img` component with an empty `src` and no way to tell it had ever had
 * one. `file:` is passed through for the image renderer below to resolve into
 * an authenticated read; every other scheme keeps the default treatment, which
 * is what keeps `javascript:` out of a reply the model wrote.
 */
const urlTransform: MarkdownProps['urlTransform'] = (url, key, node) => {
  if (key === 'src' && node.tagName === 'img' && url.startsWith('file://')) return url;
  return defaultUrlTransform(url);
};

const remarkPlugins: MarkdownProps['remarkPlugins'] = [remarkGfm];
const rehypePlugins: MarkdownProps['rehypePlugins'] = [rehypeHighlightLocal];

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  // The workspace root for resolving `workspace://` links.
  const cwd = useSession((s) => s.info?.cwd) ?? undefined;

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={urlTransform}
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
          img({ src, alt }) {
            // A screenshot the agent just took is on its disk, not on the web:
            // `file://` is unreachable from a page served over http, and a
            // bare absolute path resolves against the proxy's own origin and
            // 404s. Both become an authenticated read instead.
            const local = localImagePath(typeof src === 'string' ? src : undefined, cwd);
            if (local) return <LocalImage path={local} alt={alt} />;
            return <img className="chat-image" src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} />;
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
