/**
 * jsdom lacks a few things the app assumes on a phone. Each shim here stands
 * in for a browser API rather than for app code — anything faking the app
 * itself belongs in the test that needs it.
 */
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

// The haptics layer calls this on every buzz; jsdom has no vibration motor.
if (!navigator.vibrate) {
  Object.defineProperty(navigator, 'vibrate', { value: vi.fn(), writable: true });
}
