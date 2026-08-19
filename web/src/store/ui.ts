/**
 * UI preferences and transient app-shell state.
 *
 * Preferences persist to localStorage by hand rather than via zustand's
 * `persist` middleware — the set is tiny and this keeps hydration synchronous,
 * so the app never paints the wrong theme for a frame.
 */
import { create } from 'zustand';
import { setHapticsEnabled } from '../lib/haptics';
import type { ConnState } from '../ws/types';

/** A palette that actually exists in CSS — what `data-theme` can be set to. */
export type ResolvedTheme = 'dark' | 'amoled' | 'light';

/**
 * The stored preference, which is not the same thing: `system` names a rule
 * for choosing rather than a palette, and has to be resolved against the
 * device every time it is applied.
 */
export type Theme = ResolvedTheme | 'system';

const darkQuery = '(prefers-color-scheme: dark)';

/**
 * What `system` currently means on this device.
 *
 * AMOLED is deliberately not reachable this way. The OS says light or dark and
 * nothing finer, so a preference for the black-pixel variant is a choice only
 * the user can make — `system` going dark picks the ordinary dark palette.
 */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== 'system') return theme;
  if (typeof matchMedia === 'undefined') return 'dark';
  return matchMedia(darkQuery).matches ? 'dark' : 'light';
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'warn' | 'error';
}

const KEYS = {
  theme: 'hermes.theme',
  haptics: 'hermes.haptics',
  token: 'hermes.token',
  devPanel: 'hermes.devPanel',
} as const;

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / quota — preferences simply won't persist.
  }
}

interface UiState {
  /** What the user picked, which may be `system`. */
  theme: Theme;
  /** What that currently resolves to — the palette actually on screen. */
  resolvedTheme: ResolvedTheme;
  haptics: boolean;
  /** Optional explicit token, only needed when bypassing the proxy. */
  token: string;
  devPanel: boolean;
  connection: ConnState;
  toasts: Toast[];
  /**
   * The navigation drawer. Lives here rather than in `App` because the
   * hamburger sits inside each screen's own header — the two ends of the
   * interaction are in different subtrees.
   */
  navOpen: boolean;

  setTheme: (t: Theme) => void;
  setHaptics: (on: boolean) => void;
  setToken: (t: string) => void;
  setDevPanel: (on: boolean) => void;
  setNavOpen: (open: boolean) => void;
  setConnection: (c: ConnState) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;

// The default stays `dark` rather than `system`: anyone who has never opened
// Settings has no stored preference, and quietly repainting their app white
// because their phone is in light mode is not an improvement they asked for.
const initialTheme = read(KEYS.theme, 'dark') as Theme;
const initialHaptics = read(KEYS.haptics, 'on') === 'on';
setHapticsEnabled(initialHaptics);

export const useUi = create<UiState>((set, get) => ({
  theme: initialTheme,
  resolvedTheme: resolveTheme(initialTheme),
  haptics: initialHaptics,
  token: read(KEYS.token, ''),
  devPanel: read(KEYS.devPanel, 'off') === 'on',
  connection: 'closed',
  toasts: [],
  navOpen: false,

  setNavOpen: (navOpen) => set({ navOpen }),

  setTheme: (theme) => {
    write(KEYS.theme, theme);
    applyTheme(theme);
    set({ theme, resolvedTheme: resolveTheme(theme) });
  },

  setHaptics: (on) => {
    write(KEYS.haptics, on ? 'on' : 'off');
    setHapticsEnabled(on);
    set({ haptics: on });
  },

  setToken: (token) => {
    write(KEYS.token, token);
    set({ token });
  },

  setDevPanel: (on) => {
    write(KEYS.devPanel, on ? 'on' : 'off');
    set({ devPanel: on });
  },

  setConnection: (connection) => set({ connection }),

  toast: (text, tone = 'info') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, text, tone }] });
    setTimeout(() => get().dismissToast(id), 5000);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/**
 * Reflect the theme on <html> so CSS custom properties can switch wholesale.
 *
 * `data-theme` only ever carries a resolved palette — the stylesheet has no
 * rule for `system`, and writing it there would fall back to the `:root` dark
 * values whatever the device actually prefers.
 */
export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  const color = resolved === 'light' ? '#f7f7fa' : resolved === 'amoled' ? '#000000' : '#0b0b0f';
  meta?.setAttribute('content', color);
}

applyTheme(initialTheme);

/**
 * Follow the device while `system` is selected.
 *
 * Without this the app only picks up an OS change on reload — and a phone
 * switching to dark at sunset with the app already open is the exact moment
 * the setting is supposed to earn its place.
 */
if (typeof matchMedia !== 'undefined') {
  const mq = matchMedia(darkQuery);
  const onChange = () => {
    if (useUi.getState().theme !== 'system') return;
    applyTheme('system');
    useUi.setState({ resolvedTheme: resolveTheme('system') });
  };
  // Safari only grew `addEventListener` on MediaQueryList in 14.
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else mq.addListener(onChange);
}
