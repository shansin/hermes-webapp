/**
 * Paths in a transcript, rendered.
 *
 * `fileLinks.test.ts` pins what counts as a path; this pins that the renderer
 * actually reaches for it, in the two places an agent puts one — a markdown
 * link and inline code — and that the things which merely look like paths come
 * out as ordinary text. Worth testing through `Markdown` rather than the
 * helper alone because two of the three failure modes live in the wiring, not
 * the rule:
 *
 *  - **`file://` is blanked before the renderer sees it.** react-markdown's
 *    URL sanitiser allows http, https, mailto, irc and xmpp and empties
 *    everything else, so the href arrived as `''` — indistinguishable from a
 *    link the agent wrote without one. `urlTransform` has to pass it through
 *    for links as well as for images.
 *  - **A fenced code block is not inline code.** react-markdown gives both to
 *    the same component; a block that happened to contain a path would turn
 *    into a link and take its formatting with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

/** The session's working directory, which `workspace://` resolves against. */
vi.mock('../src/store/session', () => ({
  useSession: (pick: (s: unknown) => unknown) => pick({ info: { cwd: '/code/app' } }),
}));

import { Markdown } from '../src/components/chat/Markdown';

const show = (md: string) =>
  render(<MemoryRouter>{(<Markdown>{md}</Markdown>) as ReactNode}</MemoryRouter>);

// Queries below read the whole document, so a tree left standing from the
// previous test would be counted twice. This project does not enable
// auto-cleanup globally.
afterEach(cleanup);

/** Every href the render produced, in order. */
const hrefs = () => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));

describe('a path in inline code', () => {
  it('becomes a link to the file browser', () => {
    show('Done. Wrote `/home/shsin/report.md` for you.');
    expect(hrefs()).toEqual(['/files?path=%2Fhome%2Fshsin%2Freport.md']);
    // Still reads as code, because it is — see `.md__path`.
    expect(document.querySelector('a')?.className).toContain('md__path');
  });

  /* The app's own routes appear in transcripts constantly and are not files.
     A link here would land on "not found" and teach you to distrust the rest. */
  it('leaves an API route as plain code', () => {
    show('The board route `/api/plugins/kanban/board` is unchanged.');
    expect(hrefs()).toEqual([]);
    expect(screen.getByText('/api/plugins/kanban/board').tagName).toBe('CODE');
  });

  it('leaves an ordinary literal as plain code', () => {
    show('Set `kanban.auto_decompose` to false.');
    expect(hrefs()).toEqual([]);
    expect(screen.getByText('kanban.auto_decompose').tagName).toBe('CODE');
  });

  /**
   * A fenced block is a sample, not a link. Both arrive at the same component,
   * so without the guard a shell snippet's first line would become a link and
   * lose its block formatting with it.
   */
  it('leaves a fenced block alone, paths and all', () => {
    show('```sh\ncd /home/shsin\ncat /home/shsin/report.md\n```');
    expect(hrefs()).toEqual([]);
    expect(document.querySelector('pre')).toBeTruthy();
  });
});

describe('a path in a link', () => {
  /* The one that used to arrive with an empty href, because the sanitiser
     blanks every scheme it does not know. */
  it('opens a file:// link in the browser', () => {
    show('See [the brief](file:///home/shsin/brief.md).');
    expect(hrefs()).toEqual(['/files?path=%2Fhome%2Fshsin%2Fbrief.md']);
  });

  it('resolves a workspace:// link against the session cwd', () => {
    show('See [the plan](workspace://notes/plan.md).');
    expect(hrefs()).toEqual(['/files?path=%2Fcode%2Fapp%2Fnotes%2Fplan.md']);
  });

  it('opens a bare absolute path', () => {
    show('See [the brief](/home/shsin/brief.md).');
    expect(hrefs()).toEqual(['/files?path=%2Fhome%2Fshsin%2Fbrief.md']);
  });

  it('leaves an ordinary web link pointing outward', () => {
    show('See [the docs](https://example.com/home/x.md).');
    expect(hrefs()).toEqual(['https://example.com/home/x.md']);
    expect(document.querySelector('a')?.getAttribute('target')).toBe('_blank');
  });

  /* The sanitiser's actual job, which the `file://` exemption must not widen:
     a script URL in a reply the model wrote must never become navigable. */
  it('still blanks a javascript: link', () => {
    show('[click me](javascript:alert(1))');
    expect(hrefs()).toEqual(['']);
  });
});

describe('several in one message', () => {
  it('links each path and leaves the route alone', () => {
    show(
      'Done. Wrote `/home/shsin/report.md`, see [the brief](file:///home/shsin/brief.md). ' +
        'The route `/api/plugins/kanban/board` is unchanged.',
    );
    expect(hrefs()).toEqual([
      '/files?path=%2Fhome%2Fshsin%2Freport.md',
      '/files?path=%2Fhome%2Fshsin%2Fbrief.md',
    ]);
  });
});
