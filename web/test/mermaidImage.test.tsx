/**
 * A diagram reaches the page as an inert image, never as live SVG markup.
 *
 * Mermaid's output is derived from text the model wrote. Inline, an SVG's
 * `<style>` is page-wide CSS and its `url()`s are requests; loaded as an
 * `<img>` it is a sealed document that can do neither. So the assertions are
 * structural — no `<svg>` in the transcript, an `<img>` whose source is a
 * well-formed SVG document — plus the conversion details that would otherwise
 * fail silently as a blank picture: markup that is HTML but not XML, and a
 * root with no intrinsic size.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const MARKUP =
  '<svg id="mmd-1" width="100%" xmlns="http://www.w3.org/2000/svg" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" style="max-width: 320px;" viewBox="-8 -8 320 140">' +
  '<style>#mmd-1{font-family:x;fill:#333;}#mmd-1 .node rect{fill:#eee;}</style>' +
  '<g class="node"><rect width="10" height="10"></rect><text>A&nbsp;&amp;&nbsp;B</text></g>' +
  '<use xlink:href="#arrow"></use></svg>';

const initialize = vi.fn();
vi.mock('mermaid', () => ({
  default: {
    initialize: (cfg: unknown) => initialize(cfg),
    render: vi.fn(async () => ({ svg: MARKUP })),
  },
}));

import { MermaidBlock, svgImage } from '../src/components/chat/MermaidBlock';

afterEach(cleanup);

const PAGE = { font: "system-ui, 'Segoe UI', sans-serif", color: 'rgb(230, 230, 238)' };

/** The SVG document a `data:` URL carries, parsed the way an image would be. */
function decode(src: string): Document {
  const prefix = 'data:image/svg+xml;charset=utf-8,';
  expect(src.startsWith(prefix)).toBe(true);
  return new DOMParser().parseFromString(decodeURIComponent(src.slice(prefix.length)), 'image/svg+xml');
}

describe('svgImage', () => {
  it('turns HTML-serialized markup into an SVG document that parses as XML', () => {
    // `&nbsp;` is the classic: valid HTML, a fatal error in XML.
    expect(
      new DOMParser().parseFromString(MARKUP, 'image/svg+xml').querySelector('parsererror'),
    ).not.toBeNull();

    const image = svgImage(MARKUP, PAGE)!;
    const doc = decode(image.src);
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(doc.querySelector('text')?.textContent).toBe('A & B');
    // The xlink reference survives with its namespace declared.
    expect(doc.querySelector('use')?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe(
      '#arrow',
    );
  });

  it('gives the image an intrinsic size from the viewBox', () => {
    const image = svgImage(MARKUP, PAGE)!;
    expect(image).toMatchObject({ width: 320, height: 140 });
    const root = decode(image.src).documentElement;
    expect(root.getAttribute('width')).toBe('320');
    expect(root.getAttribute('height')).toBe('140');
    expect(root.getAttribute('style')).not.toContain('max-width');
  });

  it('writes in what the image can no longer inherit from the page', () => {
    const style = decode(svgImage(MARKUP, PAGE)!.src).documentElement.getAttribute('style') ?? '';
    expect(style).toContain('color: rgb(230, 230, 238)');
    expect(style).toContain('--mermaid-font-family');
  });

  it('keeps mermaid’s own styles inside the image', () => {
    const doc = decode(svgImage(MARKUP, PAGE)!.src);
    expect(doc.querySelector('style')?.textContent).toContain('#mmd-1 .node rect');
  });

  it('declines markup with no SVG in it', () => {
    expect(svgImage('<p>nope</p>', PAGE)).toBeNull();
  });
});

describe('MermaidBlock', () => {
  it('draws the diagram as an <img>, with no SVG in the page', async () => {
    const { container } = render(<MermaidBlock source={'flowchart TD\n  A --> B'} />);

    const img = await screen.findByAltText('flowchart TD diagram');
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(img).toHaveAttribute('width', '320');
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('style')).toBeNull();
  });

  it('asks mermaid for SVG text labels, not HTML in foreignObject', async () => {
    render(<MermaidBlock source={'flowchart TD\n  A --> B'} />);
    await screen.findByAltText('flowchart TD diagram');

    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
        htmlLabels: false,
        flowchart: expect.objectContaining({ htmlLabels: false }),
      }),
    );
    // A concrete font: an image has no page to `inherit` one from.
    expect(initialize.mock.lastCall?.[0]).not.toHaveProperty('fontFamily', 'inherit');
  });
});
