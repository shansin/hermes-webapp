/**
 * The inline theme script in `index.html`, and the one thing it can get wrong.
 *
 * It exists because `/src/main.tsx` is a module script and therefore deferred:
 * `applyTheme` does not run until the document has been parsed, and by then
 * the status bar of an installed Android PWA has already taken its colour. So
 * the resolve happens twice — once inline during parse, once in `store/ui.ts`
 * — and the inline copy cannot import anything.
 *
 * Two copies of the same three colours and the same storage key is exactly the
 * kind of duplication that rots silently: someone retunes the light surface in
 * `ui.ts`, the status bar keeps the old one, and nothing anywhere disagrees out
 * loud. Being wrong here is invisible on a desktop browser and permanent on a
 * phone, which is what makes it worth a test rather than a comment.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const ui = readFileSync(resolve(__dirname, '../src/store/ui.ts'), 'utf8');
const viteConfig = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8');

/** The one expression both copies compute, normalised to compare. */
const PALETTE = /'light'\s*\?\s*'(#[0-9a-f]{6})'\s*:\s*\w+\s*===\s*'amoled'\s*\?\s*'(#[0-9a-f]{6})'\s*:\s*'(#[0-9a-f]{6})'/i;

describe('the inline theme boot script', () => {
  it('resolves the palette to the same colours as applyTheme', () => {
    const inline = html.match(PALETTE);
    const module = ui.match(PALETTE);

    expect(inline, 'no palette expression found in index.html').not.toBeNull();
    expect(module, 'no palette expression found in store/ui.ts').not.toBeNull();
    // [light, amoled, dark] — the fallback being dark is itself the contract.
    expect(inline!.slice(1, 4)).toEqual(module!.slice(1, 4));
  });

  it('reads the same localStorage key the store writes', () => {
    expect(html).toContain("localStorage.getItem('hermes.theme')");
    expect(ui).toContain("theme: 'hermes.theme'");
  });

  /**
   * The default has to match `initialTheme`'s. A fresh install has nothing
   * stored, and disagreeing here would paint the status bar for one palette
   * and the app for another on every first launch.
   */
  it('falls back to the same theme a fresh install gets', () => {
    expect(html).toContain("localStorage.getItem('hermes.theme') || 'dark'");
    expect(ui).toContain("read(KEYS.theme, 'dark')");
  });

  /**
   * `system` is not a palette — the stylesheet has no rule for it — so both
   * copies have to resolve it against the device before writing anything.
   */
  it('resolves system rather than writing it to the document', () => {
    expect(html).toContain("stored === 'system'");
    expect(html).toContain("matchMedia('(prefers-color-scheme: dark)')");
    expect(html).not.toMatch(/dataset\.theme\s*=\s*stored\b/);
  });

  /**
   * The whole point of running during parse. A module script would be
   * deferred to after the document is parsed, which is after the status bar
   * has taken its colour.
   */
  it('is a classic inline script, not a deferred module', () => {
    const tag = html.match(/<script[^>]*>\s*\(function/);
    expect(tag, 'the boot script should be inline').not.toBeNull();
    expect(tag![0]).not.toContain('type="module"');
    expect(tag![0]).not.toContain('defer');
    // And it must come after the media-scoped tags it removes.
    expect(html.indexOf('<script')).toBeGreaterThan(html.lastIndexOf('name="theme-color" media'));
  });

  /**
   * A wedged or blocked localStorage (private mode, a locked-down webview)
   * throws on read. Taking the page down over the status bar colour would be
   * a spectacularly bad trade.
   */
  it('survives a localStorage that throws', () => {
    expect(html).toMatch(/try\s*\{[\s\S]*localStorage[\s\S]*\}\s*catch/);
  });

  /**
   * The installed app's status bar is painted from the *manifest*, which
   * cannot be media-scoped or rewritten at runtime — and only the icon tint
   * comes from the tag these two files write. Report anything but the
   * manifest's own colour there and Chrome picks icons for a bar it did not
   * paint: the dark palette against the light manifest fill is white icons on
   * a near-white band, which is how Dark shipped. So all three copies of that
   * one colour have to agree, and only a test can say so — nothing else in the
   * repo connects a manifest field to a `<meta>` tag.
   */
  it('reports the manifest fill, not the palette, when installed', () => {
    const manifest = viteConfig.match(/theme_color:\s*'(#[0-9a-f]{6})'/i);
    expect(manifest, 'no theme_color found in vite.config.ts').not.toBeNull();
    const fill = manifest![1];

    expect(ui).toContain(`export const STANDALONE_STATUS_BAR = '${fill}';`);
    expect(ui).toContain('isStandalone() ? STANDALONE_STATUS_BAR : palette');

    // The inline copy cannot import the constant, so it carries the literal.
    expect(html).toMatch(
      new RegExp(`matchMedia\\('\\(display-mode: standalone\\)'\\)\\.matches\\s*\\?\\s*'${fill}'`, 'i'),
    );
  });
});
