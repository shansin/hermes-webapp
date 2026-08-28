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
import { filesHref, inlineCodePath, resolveFilePath } from '../../lib/fileLinks';
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
/**
 * Schemes that name something on the agent's own machine.
 *
 * Neither is a URL the browser could follow; both are resolved into an
 * authenticated read against the proxy. Nothing else is exempted — the default
 * treatment is what keeps `javascript:` out of a reply the model wrote.
 */
const LOCAL_SCHEMES = ['file://', 'workspace://'];

const urlTransform: MarkdownProps['urlTransform'] = (url, key, node) => {
  if (key === 'src' && node.tagName === 'img' && url.startsWith('file://')) return url;
  /* And on a link, so `[the report](file:///home/…/x.md)` reaches the anchor
     renderer with an href to resolve. Blanked here it arrived as an empty
     string, indistinguishable from a link the agent never wrote one for.
     `workspace://` needs the same exemption and never had it — which is why
     those links, the ones this app documents as the agent's way of pointing at
     a file it touched, have never actually opened anything: the handler for
     them was reading an href the sanitiser had already emptied. */
  if (key === 'href' && node.tagName === 'a' && LOCAL_SCHEMES.some((s) => url.startsWith(s))) {
    return url;
  }
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
            /* `workspace://path` is how the agent points at a file it touched,
               and `file://` and a bare absolute path are how it points at one
               when it is not thinking about links at all. All three open the
               file browser; left alone the first two do nothing (the browser
               knows neither scheme) and the third resolves against the proxy's
               own origin and 404s. See `lib/fileLinks.ts` for what qualifies. */
            const local = resolveFilePath(href, cwd);
            if (local) {
              return <Link to={filesHref(local)}>{children}</Link>;
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },

          /**
           * Inline code that is a path becomes a link to it.
           *
           * This is where an agent actually puts a path most of the time —
           * "wrote `/home/shsin/report.md`" — and it was the one form with no
           * way to open it. Fenced blocks are excluded by the newline test in
           * `inlineCodePath`: a code sample is not a link, however many paths
           * it contains.
           */
          code({ children, className, ...rest }) {
            const text = typeof children === 'string' ? children : nodeText(children);
            const local = className?.includes('language-') ? null : inlineCodePath(text, cwd);
            if (local) {
              return (
                <Link className="md__path" to={filesHref(local)} title={`Open ${local}`}>
                  {children}
                </Link>
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
