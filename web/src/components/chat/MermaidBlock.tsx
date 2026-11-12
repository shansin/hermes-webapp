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
 *
 * ## Why the SVG is an `<img>`, not markup in the page
 *
 * The source is the model's, so the SVG is untrusted output. It used to go in
 * through `dangerouslySetInnerHTML`, trusting mermaid's own sanitizing under
 * `securityLevel: 'strict'`. That stops scripts, but an inline SVG is still
 * live document: its `<style>` is page-wide CSS, so anything that slips
 * through mermaid's handling of `classDef` / `style` lines lands on the whole
 * app, and a CSS `url()` or `<image href>` inside it is a network request —
 * the same leak `RemoteImage` closes. Another DOMPurify pass would not help
 * with either (mermaid's output has already had one); it does not parse CSS.
 *
 * An SVG loaded as an image is a separate, static document: no script, no
 * external fetches, and its styles stop at its own edge. What it costs, and
 * why each is acceptable here:
 *  - **Theming.** The page's CSS can't reach in. Nothing needed it to:
 *    mermaid bakes the `dark` / `default` theme's colours into the SVG, and a
 *    theme switch re-renders. The two things that did inherit from the page —
 *    the font (`fontFamily: 'inherit'`) and `currentColor` in icons — are
 *    resolved from the page and written in before it becomes an image.
 *  - **Fonts.** An image may only use installed fonts. The app's stack is
 *    system fonts throughout, so mermaid measures labels with the same face
 *    the image draws them in.
 *  - **Text selection** inside the diagram is gone. It was never reachable on
 *    a phone, where the whole diagram is one tap target.
 *  - **Sizing** comes from the viewBox, written onto the root as width and
 *    height so the image has an intrinsic size rather than mermaid's `100%`.
 *
 * `htmlLabels: false` is the other half: labels become SVG `<text>`, not HTML
 * in a `<foreignObject>` — the part of mermaid's output with the longest
 * history of sanitizer bypasses, and the part an image renders least
 * faithfully. Its costs, checked against mermaid 11 in Chrome: HTML a model
 * writes inside a label (`<b>`, `&nbsp;`) shows literally rather than styled
 * (`<br/>` still breaks the line), and a mindmap's circular root node
 * mis-centres its text. Both are cosmetic; if they ever matter more, the
 * `<img>` already makes foreignObject inert and this flag can be revisited.
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
      // SVG text rather than HTML-in-foreignObject; see the header. The
      // flowchart key is deprecated in favour of the root one but still read
      // by older code paths, so both are set.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: dark ? 'dark' : 'default',
      // A concrete stack, not `inherit`: the image this becomes has no page
      // to inherit from.
      fontFamily: pageStyle().font,
    });
    return api;
  });
}

let seq = 0;

/** The page's font and text colour, for an SVG that will no longer inherit them. */
function pageStyle(): { font: string; color: string } {
  const css = getComputedStyle(document.body);
  return {
    // Double quotes become single so the stack can sit in an attribute or a
    // CSS string mermaid builds without escaping.
    font: css.fontFamily.replace(/"/g, "'") || 'sans-serif',
    color: css.color || 'currentColor',
  };
}

/**
 * Mermaid's SVG markup as a self-contained image document.
 *
 * Mermaid returns HTML-serialized markup (it comes out of DOMPurify), which is
 * not always well-formed XML — an `&nbsp;` in a label is enough to make an
 * `image/svg+xml` document fail to parse. So it is read with the HTML parser
 * (an inert document: nothing runs, nothing loads) and written back out with
 * `XMLSerializer`, fixing up what the image will no longer inherit on the way.
 */
export function svgImage(
  markup: string,
  page: { font: string; color: string },
): { src: string; width?: number; height?: number } | null {
  const svg = new DOMParser().parseFromString(markup, 'text/html').querySelector('svg');
  if (!svg) return null;

  const box = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const width = box[2];
  const height = box[3];
  const sized = box.length === 4 && width! > 0 && height! > 0;
  if (sized) {
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    // `max-width: <natural>px` beside `width="100%"` was mermaid's way of
    // saying "fit, but never upscale"; the stylesheet says that now.
    svg.style.removeProperty('max-width');
  }
  // Icons fill with `currentColor`, which inside an image is black.
  svg.style.color = page.color;
  svg.style.setProperty('--mermaid-font-family', page.font);

  const xml = new XMLSerializer().serializeToString(svg);
  // A data: URL rather than a blob: one — nothing to revoke across theme
  // re-renders and the zoomed copy, and at diagram sizes the encoding
  // overhead doesn't matter.
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`,
    ...(sized ? { width, height } : {}),
  };
}

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
  const [image, setImage] = useState<ReturnType<typeof svgImage>>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const idRef = useRef(`mmd-${++seq}`);

  useEffect(() => {
    let alive = true;
    loadMermaid(theme !== 'light')
      .then((m) => m.render(idRef.current, source))
      .then(({ svg }) => {
        if (!alive) return;
        const drawn = svgImage(svg, pageStyle());
        if (!drawn) throw new Error('Mermaid returned no SVG');
        setImage(drawn);
        setFailed(null);
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

  if (!image) return <div className="mermaid mermaid--pending">Drawing diagram…</div>;

  const label = describe(source);

  return (
    <>
      {/* A button around the image, not a click handler on it. Enlarging was
          reachable by tap only — no focus, no Enter, nothing announced — and
          the diagram is the one part of a reply that is unreadable at phone
          width, so the way to open it cannot be pointer-only. */}
      <button
        type="button"
        className="mermaid-open"
        aria-label={`${label}. Enlarge`}
        onClick={() => setZoomed(true)}
      >
        <div className="mermaid">
          <img src={image.src} width={image.width} height={image.height} alt={label} />
        </div>
      </button>
      {zoomed && (
        <ZoomOverlay label={label} onClose={() => setZoomed(false)}>
          <div className="zoom__diagram">
            <img src={image.src} width={image.width} height={image.height} alt={label} />
          </div>
        </ZoomOverlay>
      )}
    </>
  );
}
