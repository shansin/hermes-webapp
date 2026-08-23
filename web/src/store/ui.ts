/**
 * UI preferences and transient app-shell state.
 *
 * Preferences persist to localStorage by hand rather than via zustand's
 * `persist` middleware — the set is tiny and this keeps hydration synchronous,
 * so the app never paints the wrong theme for a frame.
 */
import { create } from 'zustand';
import { isSessionFilter, type SessionFilter } from '../lib/sessionKinds';
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

/**
 * The accent hue, an axis independent of the theme: every accent has both a
 * dark and a light pair in the stylesheet, so switching palettes never
 * silently changes which one is selected.
 */
export type Accent = 'amber' | 'blue' | 'violet' | 'green' | 'rose' | 'teal';

export const ACCENTS: Accent[] = ['amber', 'blue', 'violet', 'green', 'rose', 'teal'];

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
  /**
   * An offer to take it back.
   *
   * A toast is the only thing on screen after a destructive action, so it is
   * the natural place to undo one — and on a phone it is far better than a
   * confirmation dialog in front of every swipe. See `lib/undo.ts`, which
   * defers the irreversible half until the toast has expired.
   */
  action?: { label: string; onAction: () => void };
  /** When this toast disappears, so a long one is not gone before it is read. */
  durationMs: number;
}

export interface ToastOptions {
  action?: Toast['action'];
  durationMs?: number;
}

/**
 * Five seconds suits "Copied"; it does not suit a two-line gateway error, which
 * is gone before it has been read. Long text buys more, up to a ceiling — past
 * which the toast is the wrong medium anyway.
 */
const TOAST_BASE_MS = 5000;
const TOAST_PER_CHAR_MS = 45;
const TOAST_MAX_MS = 12_000;

export function toastDuration(text: string, action?: Toast['action']): number {
  // An undo offer is a decision, not a notice: give it the full window.
  const floor = action ? 8000 : TOAST_BASE_MS;
  const scaled = TOAST_BASE_MS + Math.max(0, text.length - 40) * TOAST_PER_CHAR_MS;
  return Math.min(Math.max(floor, scaled), TOAST_MAX_MS);
}

const KEYS = {
  theme: 'hermes.theme',
  accent: 'hermes.accent',
  haptics: 'hermes.haptics',
  token: 'hermes.token',
  devPanel: 'hermes.devPanel',
  sessionFilter: 'hermes.sessionFilter',
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
  /** The accent hue, applied on top of whichever palette is resolved. */
  accent: Accent;
  haptics: boolean;
  /** Optional explicit token, only needed when bypassing the proxy. */
  token: string;
  devPanel: boolean;
  /**
   * Which bucket the Sessions screen is showing.
   *
   * A preference rather than screen state: the whole point is that it survives
   * leaving the screen and closing the app. Someone who works out of the
   * kanban lane should not have to re-pick it every time.
   */
  sessionFilter: SessionFilter;
  connection: ConnState;
  toasts: Toast[];
  /**
   * The navigation drawer. Lives here rather than in `App` because the
   * hamburger sits inside each screen's own header — the two ends of the
   * interaction are in different subtrees.
   */
  navOpen: boolean;

  setTheme: (t: Theme) => void;
  setAccent: (a: Accent) => void;
  setHaptics: (on: boolean) => void;
  setToken: (t: string) => void;
  setDevPanel: (on: boolean) => void;
  setSessionFilter: (f: SessionFilter) => void;
  setNavOpen: (open: boolean) => void;
  setConnection: (c: ConnState) => void;
  toast: (text: string, tone?: Toast['tone'], opts?: ToastOptions) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;

// The default stays `dark` rather than `system`: anyone who has never opened
// Settings has no stored preference, and quietly repainting their app white
// because their phone is in light mode is not an improvement they asked for.
const initialTheme = read(KEYS.theme, 'dark') as Theme;
// Amber is the accent the app shipped with, so an install that predates this
// setting keeps exactly the colour it had.
const stored = read(KEYS.accent, 'amber') as Accent;
const initialAccent: Accent = ACCENTS.includes(stored) ? stored : 'amber';
const initialHaptics = read(KEYS.haptics, 'on') === 'on';
setHapticsEnabled(initialHaptics);

// Same treatment as the accent: an unknown stored value falls back rather
// than filtering the list by a bucket no chip can turn off.
const storedFilter = read(KEYS.sessionFilter, 'all');
const initialSessionFilter: SessionFilter = isSessionFilter(storedFilter) ? storedFilter : 'all';

export const useUi = create<UiState>((set, get) => ({
  theme: initialTheme,
  resolvedTheme: resolveTheme(initialTheme),
  accent: initialAccent,
  haptics: initialHaptics,
  token: read(KEYS.token, ''),
  devPanel: read(KEYS.devPanel, 'off') === 'on',
  // Validated on the way in: a hand-edited or stale value must not leave the
  // list filtered by something no chip can clear.
  sessionFilter: initialSessionFilter,
  connection: 'closed',
  toasts: [],
  navOpen: false,

  setNavOpen: (navOpen) => set({ navOpen }),

  setTheme: (theme) => {
    write(KEYS.theme, theme);
    applyTheme(theme);
    set({ theme, resolvedTheme: resolveTheme(theme) });
  },

  setAccent: (accent) => {
    write(KEYS.accent, accent);
    applyAccent(accent);
    set({ accent });
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

  setSessionFilter: (sessionFilter) => {
    write(KEYS.sessionFilter, sessionFilter);
    set({ sessionFilter });
  },

  setConnection: (connection) => set({ connection }),

  toast: (text, tone = 'info', opts = {}) => {
    const id = ++toastSeq;
    const durationMs = opts.durationMs ?? toastDuration(text, opts.action);
    set({
      toasts: [...get().toasts, { id, text, tone, action: opts.action, durationMs }],
    });
    setTimeout(() => get().dismissToast(id), durationMs);
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

/**
 * Reflect the accent on <html>, alongside `data-theme`.
 *
 * Two attributes rather than one combined value: the stylesheet needs to
 * match on the theme alone (surfaces, text) and on the accent alone (the dark
 * pair), and only the light overrides look at both.
 */
export function applyAccent(accent: Accent): void {
  document.documentElement.dataset.accent = accent;
}

applyTheme(initialTheme);
applyAccent(initialAccent);

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
