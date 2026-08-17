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

export type Theme = 'dark' | 'amoled' | 'light';

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
  theme: Theme;
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

const initialTheme = read(KEYS.theme, 'dark') as Theme;
const initialHaptics = read(KEYS.haptics, 'on') === 'on';
setHapticsEnabled(initialHaptics);

export const useUi = create<UiState>((set, get) => ({
  theme: initialTheme,
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
    set({ theme });
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

/** Reflect the theme on <html> so CSS custom properties can switch wholesale. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  const color = theme === 'light' ? '#f7f7fa' : theme === 'amoled' ? '#000000' : '#0b0b0f';
  meta?.setAttribute('content', color);
}

applyTheme(initialTheme);
