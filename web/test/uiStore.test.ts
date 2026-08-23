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
});

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

  it('updates the theme-color meta tag so the OS chrome matches', async () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.append(meta);

    const { useUi } = await launch();
    useUi.getState().setTheme('light');
    expect(meta.getAttribute('content')).toBe('#f7f7fa');
    useUi.getState().setTheme('amoled');
    expect(meta.getAttribute('content')).toBe('#000000');

    meta.remove();
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
