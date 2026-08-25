/**
 * Render a ```mermaid fence as a diagram.
 *
 * Mermaid is ~500KB, so it's imported dynamically the first time a diagram is
 * actually seen — a transcript without one never pays for it. The import is
 * memoized at module scope so a conversation full of diagrams loads it once.
 *
 * Diagrams are drawn at desktop widths and are unreadable squeezed into a
 * phone, so the result scrolls horizontally and can be opened full-screen
 * rather than being scaled down to illegibility.
 */
import { useEffect, useRef, useState } from 'react';
import { useUi } from '../../store/ui';
import { ZoomOverlay } from './ZoomOverlay';

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

let loader: Promise<MermaidApi> | null = null;

function loadMermaid(dark: boolean): Promise<MermaidApi> {
  if (!loader) {
    loader = import('mermaid').then((mod) => (mod.default ?? mod) as unknown as MermaidApi);
  }
  // Re-initialize on every render rather than only on first load, so switching
  // the app theme re-themes diagrams that were drawn under the old one.
  return loader.then((api) => {
    api.initialize({
      startOnLoad: false,
      // `securityLevel: strict` keeps the rendered SVG free of scripts and
      // click handlers — diagram source arrives from the model, so it is
      // untrusted input like any other part of a reply.
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      fontFamily: 'inherit',
    });
    return api;
  });
}

let seq = 0;

/**
 * What to call the diagram out loud.
 *
 * `role="img"` with no accessible name announces as "image" and nothing else,
 * which is worse than the raw fence would have been — at least that could be
 * read. Mermaid's first meaningful line is its diagram type and often its
 * direction (`flowchart TD`, `sequenceDiagram`, `gantt`), so it names the
 * shape of the thing; a `title:` in a frontmatter block names the thing
 * itself and wins where the model wrote one.
 */
function describe(source: string): string {
  const lines = source.split('\n');

  // ---\ntitle: Deployment flow\n--- , mermaid's own frontmatter.
  if (lines[0]?.trim() === '---') {
    for (const line of lines.slice(1)) {
      if (line.trim() === '---') break;
      const title = /^\s*title\s*:\s*(.+?)\s*$/.exec(line)?.[1];
      if (title) return `Diagram: ${title.replace(/^["']|["']$/g, '')}`;
    }
  }

  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('%%') || t === '---') continue;
    // The first two words at most: `flowchart TD` is useful, the node list
    // that follows on the same line is not.
    return `${t.split(/\s+/).slice(0, 2).join(' ')} diagram`;
  }
  return 'Diagram';
}

export function MermaidBlock({ source }: { source: string }) {
  const theme = useUi((s) => s.theme);
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const idRef = useRef(`mmd-${++seq}`);

  useEffect(() => {
    let alive = true;
    loadMermaid(theme !== 'light')
      .then((m) => m.render(idRef.current, source))
      .then(({ svg: out }) => {
        if (alive) {
          setSvg(out);
          setFailed(null);
        }
      })
      .catch((err: unknown) => {
        // An invalid diagram is the model's mistake, not a crash. Show the
        // source instead so the reply is still readable.
        if (alive) setFailed(err instanceof Error ? err.message : 'Could not render diagram');
      });

    return () => {
      alive = false;
    };
  }, [source, theme]);

  if (failed) {
    return (
      <div className="code">
        <div className="code__head">
          <span>mermaid</span>
          <span style={{ color: 'var(--warn)' }}>unrenderable</span>
        </div>
        <pre>{source}</pre>
      </div>
    );
  }

  if (!svg) return <div className="mermaid mermaid--pending">Drawing diagram…</div>;

  const label = describe(source);

  return (
    <>
      {/* A button around the image, not a click handler on it. Enlarging was
          reachable by tap only — no focus, no Enter, nothing announced — and
          the diagram is the one part of a reply that is unreadable at phone
          width, so the way to open it cannot be pointer-only. The inner div
          keeps `role="img"`, which takes no interactive descendants and so is
          legal inside the button. */}
      <button
        type="button"
        className="mermaid-open"
        aria-label={`${label}. Enlarge`}
        onClick={() => setZoomed(true)}
      >
        <div
          className="mermaid"
          role="img"
          aria-label={label}
          // Mermaid sanitizes its own output under securityLevel: strict.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </button>
      {zoomed && (
        <ZoomOverlay label={label} onClose={() => setZoomed(false)}>
          <div className="zoom__diagram" dangerouslySetInnerHTML={{ __html: svg }} />
        </ZoomOverlay>
      )}
    </>
  );
}
