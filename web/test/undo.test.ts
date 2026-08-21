/**
 * Deferred destructive actions.
 *
 * The backend has no restore endpoint, so "Undo" can only mean "the request
 * has not gone out yet". Everything worth checking here is about that window:
 * that it closes, that it survives the screen it started on going away, and
 * that closing the app commits rather than silently cancelling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNDO_WINDOW_MS, flushUndoables, scheduleUndoable } from '../src/lib/undo';

let commit: ReturnType<typeof vi.fn>;
let revert: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  commit = vi.fn();
  revert = vi.fn();
});

afterEach(() => {
  // Leave nothing armed for the next test.
  flushUndoables();
  vi.useRealTimers();
});

const schedule = (ms = UNDO_WINDOW_MS) => scheduleUndoable({ commit, revert }, ms);

describe('the window', () => {
  it('does nothing immediately — the point is that it has not happened yet', () => {
    schedule();
    expect(commit).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
  });

  it('commits once the window closes', () => {
    schedule();
    vi.advanceTimersByTime(UNDO_WINDOW_MS + 1);
    expect(commit).toHaveBeenCalledOnce();
    expect(revert).not.toHaveBeenCalled();
  });

  it('does not commit a moment early', () => {
    schedule();
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 50);
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('undoing', () => {
  it('reverts and never commits', () => {
    const { undo } = schedule();
    undo();

    expect(revert).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('is idempotent', () => {
    const { undo } = schedule();
    undo();
    undo();
    undo();
    expect(revert).toHaveBeenCalledOnce();
  });

  /**
   * The button is gone by then, but nothing stops a caller holding the handle.
   * Reverting after the request has gone out would put a row back that no
   * longer exists on the server.
   */
  it('does nothing once the window has closed', () => {
    const { undo } = schedule();
    vi.advanceTimersByTime(UNDO_WINDOW_MS + 1);

    undo();
    expect(revert).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
  });
});

describe('outliving the screen it started on', () => {
  /**
   * The reason the timer is at module scope. Swiping a row away and navigating
   * elsewhere unmounts the list; a timer owned by that component would be
   * cleaned up with it, and the delete would never happen — the row would be
   * back on the next visit, having been reported deleted.
   */
  it('commits even though nothing is left holding the handle', () => {
    scheduleUndoable({ commit, revert }, UNDO_WINDOW_MS);
    vi.advanceTimersByTime(UNDO_WINDOW_MS + 1);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('keeps several in flight independently', () => {
    const a = vi.fn();
    const b = vi.fn();
    const first = scheduleUndoable({ commit: a, revert: vi.fn() }, UNDO_WINDOW_MS);
    scheduleUndoable({ commit: b, revert: vi.fn() }, UNDO_WINDOW_MS);

    first.undo();
    vi.advanceTimersByTime(UNDO_WINDOW_MS + 1);

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });
});

describe('flushing', () => {
  /**
   * Closing the tab must not quietly cancel a delete the user watched happen.
   */
  it('commits everything still pending', () => {
    const a = vi.fn();
    const b = vi.fn();
    scheduleUndoable({ commit: a, revert: vi.fn() }, UNDO_WINDOW_MS);
    scheduleUndoable({ commit: b, revert: vi.fn() }, UNDO_WINDOW_MS);

    flushUndoables();

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('does not resurrect something already undone', () => {
    const { undo } = schedule();
    undo();
    flushUndoables();
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not commit twice when the timer would also have fired', () => {
    schedule();
    flushUndoables();
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('is safe with nothing pending', () => {
    expect(() => flushUndoables()).not.toThrow();
  });
});
