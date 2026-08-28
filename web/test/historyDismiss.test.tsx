/**
 * Back-button dismissal, and the two ways it used to go wrong.
 *
 * Every open overlay owns a history sentinel and pops it in its effect
 * cleanup. React runs every cleanup in a commit before any new effect, and
 * `history.back()` is asynchronous, so two shapes that look ordinary in the
 * code both misbehaved:
 *
 *  - **A hand-off** — one sheet closing as another opens. The departing
 *    overlay's queued `back()` landed on the *newcomer's* entry, whose
 *    `popstate` saw a foreign id and closed it a frame after it opened. On the
 *    phone: a menu item that does nothing. It shipped that way on the kanban
 *    board menu and on `/model` and `/context` from the command palette.
 *  - **A double close** — two sheets dismissed together, which is what
 *    "Discard" in the file viewer does to its confirm sheet and the viewer
 *    under it. The first pops; the second checks while that pop is still in
 *    flight, sees the first overlay's id rather than its own, and correctly
 *    declines to pop something that is not hers. The entry underneath is then
 *    orphaned, and swallows the next back press — a back button that does
 *    nothing on a screen with nothing open.
 *
 * Both are fixed by the same two rules: an overlay opening onto an abandoned
 * entry *reuses* it, and the pops are driven by a shared unwind that walks
 * down while the top entry belongs to a closed overlay.
 *
 * **jsdom implements `history.back()` as a no-op and fires no `popstate`**, so
 * none of this can be observed against the real one — the behaviour was
 * confirmed, and the fix verified, in Chrome. What runs here is a stand-in
 * stack that behaves the way a browser's does: `back()` moves the index and
 * dispatches `popstate` on a later task. That is enough to exercise the whole
 * chain, including the second pop that the real bug turned on.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useHistoryDismiss } from '../src/lib/useHistoryDismiss';

/**
 * A history stack that pops. Only the parts the hook touches: `state`,
 * `pushState`, `replaceState` and `back`.
 */
let stack: unknown[];
let idx: number;
let backs: number;
let restore: (() => void)[];

function installFakeHistory() {
  stack = [null];
  idx = 0;
  backs = 0;
  restore = [];

  const original = Object.getOwnPropertyDescriptor(History.prototype, 'state');
  Object.defineProperty(window.history, 'state', { configurable: true, get: () => stack[idx] });
  restore.push(() => {
    delete (window.history as unknown as Record<string, unknown>).state;
    if (original) Object.defineProperty(History.prototype, 'state', original);
  });

  const spy = <K extends 'pushState' | 'replaceState' | 'back'>(key: K, impl: History[K]) => {
    const prev = window.history[key];
    (window.history as unknown as Record<string, unknown>)[key] = impl;
    restore.push(() => {
      (window.history as unknown as Record<string, unknown>)[key] = prev;
    });
  };

  spy('pushState', ((state: unknown) => {
    // A push truncates anything ahead of the cursor, as a browser's does.
    stack = stack.slice(0, idx + 1);
    stack.push(state);
    idx = stack.length - 1;
  }) as History['pushState']);

  spy('replaceState', ((state: unknown) => {
    stack[idx] = state;
  }) as History['replaceState']);

  spy('back', (() => {
    backs += 1;
    if (idx === 0) return;
    idx -= 1;
    // A browser delivers this on a later task, which is the whole reason the
    // second cleanup in a double close used to see a stale top.
    setTimeout(() => window.dispatchEvent(new PopStateEvent('popstate', { state: stack[idx] })), 0);
  }) as History['back']);
}

/** Long enough for a queued microtask and the pops it chains into. */
const settle = () => new Promise((r) => setTimeout(r, 20));

/**
 * How deep we currently sit above the page's own entry — one per overlay
 * whose sentinel has not been popped.
 *
 * The cursor, not the array length: going back does not *remove* the entries
 * ahead of it, in the fake or in a browser. Measuring length would report a
 * pop that happened as a pop that did not.
 */
const depth = () => idx;

beforeEach(installFakeHistory);
afterEach(() => {
  for (const undo of restore) undo();
  vi.restoreAllMocks();
});

/** Three overlays in one component, so their effects share a commit. */
function useThree({ a, b, c }: { a: boolean; b: boolean; c?: boolean }) {
  useHistoryDismiss(a, () => {});
  useHistoryDismiss(b, () => {});
  useHistoryDismiss(Boolean(c), () => {});
}

const show = (props: { a: boolean; b: boolean; c?: boolean }) =>
  renderHook(useThree, { initialProps: props });

describe('a single overlay', () => {
  it('pushes a sentinel on open and pops it on close', async () => {
    const { rerender } = show({ a: true, b: false });
    expect(depth()).toBe(1);

    rerender({ a: false, b: false });
    await settle();
    expect(depth()).toBe(0);
    expect(stack[idx]).toBeNull();
  });

  /**
   * React Router keeps its own bookkeeping (`idx`, `key`) in `history.state`,
   * and a bare sentinel would strand it.
   */
  it('carries the existing state into the sentinel', () => {
    window.history.replaceState({ idx: 4, key: 'abc' }, '');
    show({ a: true, b: false });
    expect(stack[idx]).toMatchObject({ idx: 4, key: 'abc' });
  });

  /**
   * A navigation moved past our entry, so a pop would undo *that* rather than
   * close us. The unwind stops at the first entry that is not an abandoned
   * sentinel.
   */
  it('does not pop an entry a navigation has moved past', async () => {
    const { rerender } = show({ a: true, b: false });
    window.history.pushState({ idx: 9 }, ''); // the router navigates

    rerender({ a: false, b: false });
    await settle();
    expect(backs).toBe(0);
    expect(stack[idx]).toMatchObject({ idx: 9 });
  });
});

describe('nesting — the parent stays open', () => {
  it('stacks a second entry rather than reusing the first', () => {
    const { rerender } = show({ a: true, b: false });
    rerender({ a: true, b: true });
    expect(depth()).toBe(2);
  });

  /* Closing the child pops its own entry and lands on the parent's sentinel,
     which the parent recognises — that is what keeps a half-filled form open
     when its picker is dismissed. */
  it('pops only the child’s entry, leaving the parent’s', async () => {
    const { rerender } = show({ a: true, b: true });
    rerender({ a: true, b: false });
    await settle();
    expect(depth()).toBe(1);
    expect(backs).toBe(1);
  });
});

describe('hand-off — the parent closes as the child opens', () => {
  it('reuses the departing entry and pops nothing', async () => {
    const { rerender } = show({ a: true, b: false });
    // One commit: `a`'s cleanup runs, then `b`'s effect.
    rerender({ a: false, b: true });
    await settle();

    expect(depth()).toBe(1);
    // Popping would have landed on the entry `b` just claimed and closed it.
    expect(backs).toBe(0);
  });

  it('leaves one entry, so a single back press closes the newcomer', async () => {
    const { rerender } = show({ a: true, b: false });
    rerender({ a: false, b: true });
    await settle();

    rerender({ a: false, b: false });
    await settle();
    expect(depth()).toBe(0);
  });
});

describe('double close — two overlays dismissed together', () => {
  /**
   * The file viewer's "Discard": a confirm sheet and the viewer under it, both
   * closed in one commit. Driven per-overlay, the second cleanup checked while
   * the first pop was still in flight, saw the wrong id on top and declined —
   * orphaning an entry that then swallowed the next back press.
   */
  it('pops both entries, not just the top one', async () => {
    const { rerender } = show({ a: true, b: true });
    expect(depth()).toBe(2);

    rerender({ a: false, b: false });
    await settle();

    expect(depth()).toBe(0);
    expect(stack[idx]).toBeNull();
  });

  it('unwinds three the same way', async () => {
    const { rerender } = show({ a: true, b: true, c: true });
    expect(depth()).toBe(3);

    rerender({ a: false, b: false, c: false });
    await settle();
    expect(depth()).toBe(0);
  });

  /* And stops at a survivor rather than unwinding past it: closing two of
     three must leave the third's entry, or dismissing it would pop something
     that belongs to the page. */
  it('stops at an overlay that is still open', async () => {
    const { rerender } = show({ a: true, b: true, c: true });
    rerender({ a: true, b: false, c: false });
    await settle();

    expect(depth()).toBe(1);
  });
});

describe('StrictMode’s double invocation', () => {
  /**
   * Development mounts every effect, tears it down and mounts it again — a
   * hand-off from an overlay to itself. That used to mean push, back, push:
   * two entries for one sheet, so the first back press did nothing.
   */
  it('ends with one sentinel, not two', async () => {
    const { rerender } = show({ a: true, b: false });
    rerender({ a: false, b: false });
    rerender({ a: true, b: false });
    await settle();

    expect(depth()).toBe(1);
    expect(backs).toBe(0);
  });
});
