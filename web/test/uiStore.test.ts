/**
 * Theme, accent and the rest of the app-shell preferences.
 *
 * Preferences are written to localStorage by hand so hydration stays
 * synchronous — the app must never paint the wrong theme for a frame — which
 * makes "what does a fresh install look like" and "what does a wedged
 * localStorage do" both worth pinning down.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/haptics', () => ({ setHapticsEnabled: vi.fn(), buzz: vi.fn() }));

/** Re-import the store with a given localStorage state, as a fresh launch. */
async function launch(stored: Record<string, string> = {}) {
  localStorage.clear();
  for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v);
  vi.resetModules();
  return import('../src/store/ui');
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-accent');
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
});

/** Stand in for the two media-scoped tags `index.html` ships. */
function seedIndexHtmlMetas(): void {
  for (const [media, content] of [
    ['(prefers-color-scheme: light)', '#f7f7fa'],
    ['(prefers-color-scheme: dark)', '#0b0b0f'],
  ]) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.setAttribute('media', media!);
    meta.content = content!;
    document.head.appendChild(meta);
  }
}

const themeColors = () =>
  [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => ({
    content: m.getAttribute('content'),
    media: m.getAttribute('media'),
  }));

describe('defaults', () => {
  /**
   * Anyone who has never opened Settings has no stored preference, and
   * repainting their app white because their phone is in light mode is not an
   * improvement they asked for.
   */
  it('opens dark rather than following the device', async () => {
    const { useUi } = await launch();
    expect(useUi.getState().theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('opens on amber, the accent the app shipped with', async () => {
    const { useUi } = await launch();
    expect(useUi.getState().accent).toBe('amber');
    expect(document.documentElement.dataset.accent).toBe('amber');
  });

  it('has haptics on', async () => {
    const { useUi } = await launch();
    expect(useUi.getState().haptics).toBe(true);
  });

  it('falls back to amber for an accent that no longer exists', async () => {
    const { useUi } = await launch({ 'hermes.accent': 'chartreuse' });
    expect(useUi.getState().accent).toBe('amber');
  });
});

describe('persistence', () => {
  it('restores a stored theme', async () => {
    const { useUi } = await launch({ 'hermes.theme': 'amoled' });
    expect(useUi.getState().theme).toBe('amoled');
    expect(document.documentElement.dataset.theme).toBe('amoled');
  });

  it('writes a change straight through', async () => {
    const { useUi } = await launch();
    useUi.getState().setTheme('light');
    expect(localStorage.getItem('hermes.theme')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('keeps the token out of the way until it is set', async () => {
    const { useUi } = await launch();
    expect(useUi.getState().token).toBe('');
    useUi.getState().setToken('abc');
    expect(localStorage.getItem('hermes.token')).toBe('abc');
  });

  /**
   * Private mode and a full quota both throw on write. Preferences simply not
   * persisting is fine; the app failing to start is not.
   */
  it('survives a localStorage that throws', async () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      const { useUi } = await launch();
      expect(() => useUi.getState().setTheme('light')).not.toThrow();
      expect(useUi.getState().theme).toBe('light');
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe('theme resolution', () => {
  it('resolves an explicit palette to itself', async () => {
    const { resolveTheme } = await launch();
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('amoled')).toBe('amoled');
  });

  /**
   * The OS says light or dark and nothing finer, so a preference for the
   * black-pixel variant is a choice only the user can make.
   */
  it('never resolves system to amoled', async () => {
    const { resolveTheme } = await launch();
    window.matchMedia = ((q: string) => ({
      matches: true,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    expect(resolveTheme('system')).toBe('dark');
  });

  it('follows the device when system is selected', async () => {
    const { resolveTheme } = await launch();
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    expect(resolveTheme('system')).toBe('light');
  });

  /**
   * The stylesheet has no rule for `system`; writing it to `data-theme` would
   * fall back to the dark values whatever the device actually prefers.
   */
  it('never writes system to the document', async () => {
    const { useUi } = await launch();
    useUi.getState().setTheme('system');
    expect(['dark', 'light', 'amoled']).toContain(document.documentElement.dataset.theme);
  });

  /**
   * Read the *live* tag each time rather than holding a reference: the tag is
   * replaced on every theme change, not edited in place. See the
   * `the theme-color meta` block below for why that matters.
   */
  it('updates the theme-color meta tag so the OS chrome matches', async () => {
    const content = () =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute('content');

    const { useUi } = await launch();
    useUi.getState().setTheme('light');
    expect(content()).toBe('#f7f7fa');
    useUi.getState().setTheme('amoled');
    expect(content()).toBe('#000000');
  });
});

describe('toasts', () => {
  it('adds a toast with a distinct id', async () => {
    const { useUi } = await launch();
    useUi.getState().toast('first');
    useUi.getState().toast('second', 'error');

    const toasts = useUi.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[0]!.id).not.toBe(toasts[1]!.id);
    expect(toasts[1]).toMatchObject({ text: 'second', tone: 'error' });
  });

  it('expires a toast on its own', async () => {
    vi.useFakeTimers();
    const { useUi } = await launch();
    useUi.getState().toast('transient');
    vi.advanceTimersByTime(5001);
    expect(useUi.getState().toasts).toEqual([]);
    vi.useRealTimers();
  });

  /**
   * Five seconds suits "Copied". It does not suit a two-line gateway error,
   * which was gone before it had been read.
   */
  it('gives a long message longer to be read', async () => {
    const { toastDuration } = await launch();
    expect(toastDuration('Copied')).toBe(5000);
    expect(toastDuration('x'.repeat(200))).toBeGreaterThan(5000);
  });

  it('caps how long a toast can linger', async () => {
    const { toastDuration } = await launch();
    expect(toastDuration('x'.repeat(5000))).toBeLessThanOrEqual(12_000);
  });

  /** An undo offer is a decision with a deadline, not a notice. */
  it('gives an actionable toast a full window even when it is short', async () => {
    const { toastDuration } = await launch();
    const action = { label: 'Undo', onAction: () => {} };
    expect(toastDuration('Deleted', action)).toBeGreaterThan(toastDuration('Deleted'));
  });

  it('carries an action through to the toast', async () => {
    const { useUi } = await launch();
    const onAction = vi.fn();
    useUi.getState().toast('Session deleted', 'success', {
      action: { label: 'Undo', onAction },
    });

    const toast = useUi.getState().toasts[0]!;
    expect(toast.action?.label).toBe('Undo');
    toast.action!.onAction();
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('honours an explicit duration', async () => {
    vi.useFakeTimers();
    const { useUi } = await launch();
    useUi.getState().toast('pinned', 'info', { durationMs: 9000 });

    vi.advanceTimersByTime(5001);
    expect(useUi.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(useUi.getState().toasts).toEqual([]);
    vi.useRealTimers();
  });

  it('dismisses only the toast asked for', async () => {
    const { useUi } = await launch();
    useUi.getState().toast('keep');
    useUi.getState().toast('drop');
    const dropId = useUi.getState().toasts[1]!.id;

    useUi.getState().dismissToast(dropId);
    expect(useUi.getState().toasts.map((t) => t.text)).toEqual(['keep']);
  });
});

describe('the Sessions lane filter', () => {
  /**
   * The list mixes your conversations with cron runs and kanban workers, so
   * the lane is a preference, not screen state — it has to survive a relaunch
   * or picking it again every visit becomes the new annoyance.
   */
  it('survives a relaunch', async () => {
    const { useUi } = await launch();
    expect(useUi.getState().sessionFilter).toBe('all');

    useUi.getState().setSessionFilter('kanban');
    expect(localStorage.getItem('hermes.sessionFilter')).toBe('kanban');

    const relaunched = await launch({ 'hermes.sessionFilter': 'kanban' });
    expect(relaunched.useUi.getState().sessionFilter).toBe('kanban');
  });

  it('starts on all when nothing is stored', async () => {
    const { useUi } = await launch();
    expect(useUi.getState().sessionFilter).toBe('all');
  });

  /**
   * A stale or hand-edited value must not leave the list filtered by a bucket
   * no chip can turn off — the rows would be gone with no way to get them
   * back short of clearing site data.
   */
  it('falls back to all on a value it cannot render', async () => {
    for (const stored of ['archived', '', 'MINE', 'null']) {
      const { useUi } = await launch({ 'hermes.sessionFilter': stored });
      expect(useUi.getState().sessionFilter, stored).toBe('all');
    }
  });
});

/**
 * The status bar on an installed Android PWA, which is painted from
 * `meta[name="theme-color"]` — and which spent the app's whole life so far
 * rendering a black band above a light app. Two separate causes, both pinned
 * here because neither is visible anywhere a unit test normally looks: the
 * band is drawn by the OS, not by the page.
 */
describe('the theme-color meta', () => {
  it('leaves exactly one tag, carrying the resolved palette', async () => {
    const { applyTheme } = await launch();
    seedIndexHtmlMetas();

    applyTheme('light');
    expect(themeColors()).toEqual([{ content: '#f7f7fa', media: null }]);
  });

  /**
   * The half a `setAttribute` could never fix. `index.html` ships one tag per
   * OS scheme so the launch frame is right before any JS has run, and the
   * first *matching* tag wins — so an explicit light chosen on a phone set to
   * dark leaves a dark tag still matching, and the bar stays black.
   */
  it('drops the media-scoped tags rather than editing one of them', async () => {
    const { applyTheme } = await launch();
    seedIndexHtmlMetas();

    applyTheme('light');
    expect(themeColors().some((m) => m.media)).toBe(false);
    expect(themeColors()).toHaveLength(1);
  });

  /**
   * Replacing the element, not rewriting `content`: Chrome picked an in-place
   * edit up for the status-bar icon tint and not for the bar fill, which is
   * what made the band unreadable — dark icons chosen for the light colour,
   * on a bar still painted the dark one.
   */
  it('inserts a new node each time rather than mutating the old one', async () => {
    const { applyTheme } = await launch();
    applyTheme('light');
    const first = document.querySelector('meta[name="theme-color"]');

    applyTheme('dark');
    const second = document.querySelector('meta[name="theme-color"]');

    expect(second).not.toBe(first);
    expect(second?.getAttribute('content')).toBe('#0b0b0f');
  });

  it('gives amoled its own true black, not the dark palette’s', async () => {
    const { applyTheme } = await launch();
    applyTheme('amoled');
    expect(themeColors()).toEqual([{ content: '#000000', media: null }]);
  });

  it('repaints when the theme changes back and forth', async () => {
    const { applyTheme } = await launch();
    seedIndexHtmlMetas();

    for (const [theme, color] of [
      ['light', '#f7f7fa'],
      ['dark', '#0b0b0f'],
      ['light', '#f7f7fa'],
    ] as const) {
      applyTheme(theme);
      expect(themeColors()).toEqual([{ content: color, media: null }]);
    }
  });
});
