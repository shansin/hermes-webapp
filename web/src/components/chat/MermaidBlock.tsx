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

  return (
    <>
      <div
        className="mermaid"
        role="img"
        onClick={() => setZoomed(true)}
        // Mermaid sanitizes its own output under securityLevel: strict.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {zoomed && (
        <div className="mermaid__zoom" onClick={() => setZoomed(false)} role="dialog" aria-modal="true">
          <div className="mermaid__zoom-inner" dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      )}
    </>
  );
}
