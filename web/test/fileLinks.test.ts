/**
 * Turning a path the agent mentioned into a tap.
 *
 * The risk here is not missing a link, it is inventing one. A transcript is
 * dense with slash-shaped strings that are not files — the app's own routes
 * (`/api/plugins/kanban/board`, `/chat?resume=…`), a sed expression, a URL
 * path quoted in prose — and a false positive is worse than no link at all: it
 * looks tappable, lands on "file not found", and teaches you the feature is
 * unreliable. A missed one costs a copy and paste.
 *
 * So the rule is deliberately narrow. An explicit `file://` or `workspace://`
 * scheme is the author saying what it is and needs no test. A bare path
 * qualifies only under a root that exists on a real machine, under the
 * session's own working directory, or written `~/…`. That covers every path
 * this install's agents actually emit — `/home/shsin/meta-settlement.md`,
 * `/home/shsin/.hermes/kanban/workspaces/t_2e20d126/plan.md` — and excludes
 * every route in the same breath.
 *
 * Inline code has a higher bar than an href, because backticks are used for
 * every literal an agent ever mentions and only some of them are paths.
 */
import { describe, expect, it } from 'vitest';
import { filesHref, inlineCodePath, resolveFilePath } from '../src/lib/fileLinks';

/**
 * Deliberately not under one of the recognised roots, so the cwd rule is what
 * is being tested rather than the root rule quietly covering for it. A
 * container working in `/code` is the real shape of this.
 */
const CWD = '/code/app';

describe('explicit schemes', () => {
  it('unwraps a file:// URL', () => {
    expect(resolveFilePath('file:///home/shsin/report.md')).toBe('/home/shsin/report.md');
  });

  it('decodes an escaped file:// path', () => {
    expect(resolveFilePath('file:///home/shsin/my%20report.md')).toBe('/home/shsin/my report.md');
  });

  /* The scheme is the author's own statement, so a path outside every known
     root still counts — that is the difference between a declaration and a
     guess. */
  it('trusts a file:// path anywhere on disk', () => {
    expect(resolveFilePath('file:///weird/place/x.txt')).toBe('/weird/place/x.txt');
  });

  it('resolves workspace:// against the session cwd', () => {
    expect(resolveFilePath('workspace://notes/plan.md', CWD)).toBe('/code/app/notes/plan.md');
    expect(resolveFilePath('workspace:///notes/plan.md', CWD)).toBe('/code/app/notes/plan.md');
  });

  /* Without a cwd there is nothing to resolve against, and guessing a root
     would point the viewer at a file that does not exist. */
  it('declines a workspace:// link with no working directory', () => {
    expect(resolveFilePath('workspace://notes/plan.md')).toBeNull();
  });
});

describe('bare absolute paths', () => {
  it.each([
    '/home/shsin/meta-settlement-2026-08-26.md',
    '/home/shsin/.hermes/kanban/workspaces/t_2e20d126/plan_sub45_10k.md',
    '/Users/someone/Desktop/notes.txt',
    '/tmp/out.json',
    '/etc/hosts',
    '/var/log/syslog',
    '/root',
  ])('accepts %s', (path) => {
    expect(resolveFilePath(path)).toBe(path);
  });

  /**
   * The app's own routes, which appear in transcripts constantly — this file
   * exists as much to keep these out as to let the ones above in.
   */
  it.each([
    '/api/plugins/kanban/board',
    '/api/sessions?limit=50',
    '/chat?resume=20260826_235007_8f07fa',
    '/files',
    '/notifications',
    '/kanban?task=t_31c1ac2e',
  ])('refuses %s', (path) => {
    expect(resolveFilePath(path)).toBeNull();
  });

  it('accepts anything under the session’s own working directory', () => {
    expect(resolveFilePath('/code/app/src/main.ts', CWD)).toBe('/code/app/src/main.ts');
    // A sibling of the cwd is not under it, and `/code` is not a root.
    expect(resolveFilePath('/code/other/main.ts', CWD)).toBeNull();
    // And without a cwd, neither is.
    expect(resolveFilePath('/code/app/src/main.ts')).toBeNull();
  });

  it('passes a tilde through for the backend to expand', () => {
    expect(resolveFilePath('~/notes.md')).toBe('~/notes.md');
    expect(resolveFilePath('~')).toBe('~');
  });

  it('refuses a relative path, which has nothing to resolve against', () => {
    expect(resolveFilePath('notes.md')).toBeNull();
    expect(resolveFilePath('./notes.md')).toBeNull();
    expect(resolveFilePath('../notes.md')).toBeNull();
  });
});

describe('things that only look like paths', () => {
  it('refuses a URL, however file-shaped its path is', () => {
    expect(resolveFilePath('https://example.com/home/shsin/report.md')).toBeNull();
    expect(resolveFilePath('mailto:someone@example.com')).toBeNull();
    // The one that matters: a script URL must never become a navigation.
    expect(resolveFilePath('javascript:alert(1)')).toBeNull();
  });

  /* A query or a fragment means it is addressing something on a server. */
  it('refuses a path carrying a query or a fragment', () => {
    expect(resolveFilePath('/home/shsin/x.md?raw=1')).toBeNull();
    expect(resolveFilePath('/home/shsin/x.md#section')).toBeNull();
  });

  /**
   * A filename with a space is real, and so is a sentence with a slash in it.
   * Nothing can tell them apart from the text alone, so the ambiguous case is
   * declined — a `file://` href or a link is how such a path gets through.
   */
  it('refuses anything containing whitespace', () => {
    expect(resolveFilePath('/home/shsin/my report.md')).toBeNull();
  });

  it('ignores nothing at all', () => {
    expect(resolveFilePath(undefined)).toBeNull();
    expect(resolveFilePath('')).toBeNull();
    expect(resolveFilePath('   ')).toBeNull();
  });
});

describe('punctuation the sentence left attached', () => {
  /* Agents write "(see /home/shsin/report.md)" and "wrote /home/shsin/x.md."
     — the bracket and the full stop are the sentence's, not the filename's. */
  it.each([
    ['/home/shsin/report.md)', '/home/shsin/report.md'],
    ['/home/shsin/report.md.', '/home/shsin/report.md'],
    ['/home/shsin/report.md,', '/home/shsin/report.md'],
    ["/home/shsin/report.md'", '/home/shsin/report.md'],
  ])('trims %s', (given, want) => {
    expect(resolveFilePath(given)).toBe(want);
  });
});

describe('inline code', () => {
  it('links a path in backticks', () => {
    expect(inlineCodePath('/home/shsin/report.md')).toBe('/home/shsin/report.md');
  });

  /**
   * A fenced block is a code sample, not a link, however many paths it
   * contains — and the newline is what separates the two, since react-markdown
   * gives a fence with no language the same shape as inline code.
   */
  it('leaves a multi-line block alone', () => {
    expect(inlineCodePath('cd /home/shsin\nls -la')).toBeNull();
  });

  it('leaves ordinary literals alone', () => {
    expect(inlineCodePath('--reasoning high')).toBeNull();
    expect(inlineCodePath('block_recurrences')).toBeNull();
    expect(inlineCodePath('kanban.auto_decompose')).toBeNull();
  });

  /* A pathological blob is not something to scan on the streaming hot path. */
  it('gives up on something absurdly long', () => {
    expect(inlineCodePath(`/home/${'a'.repeat(600)}`)).toBeNull();
  });
});

describe('filesHref', () => {
  it('addresses the file browser, encoding the path', () => {
    expect(filesHref('/home/shsin/a b.md')).toBe('/files?path=%2Fhome%2Fshsin%2Fa%20b.md');
  });
});
