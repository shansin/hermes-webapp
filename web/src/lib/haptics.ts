/**
 * Haptic feedback. Android honours `navigator.vibrate`; iOS Safari ignores it,
 * so every call is best-effort and silent when unsupported.
 */
export type Buzz = 'tap' | 'tool' | 'done' | 'approval' | 'warn' | 'error';

const PATTERNS: Record<Buzz, number | number[]> = {
  tap: 8,
  tool: 12,
  done: [18, 40, 18],
  approval: [30, 60, 30, 60, 30],
  warn: [40, 30, 40],
  error: [60, 40, 60],
};

let enabled = true;

export function setHapticsEnabled(on: boolean): void {
  enabled = on;
}

export function hapticsEnabled(): boolean {
  return enabled;
}

export function buzz(kind: Buzz = 'tap'): void {
  if (!enabled) return;
  try {
    navigator.vibrate?.(PATTERNS[kind]);
  } catch {
    // Unsupported or blocked by a user-gesture requirement — ignore.
  }
}
