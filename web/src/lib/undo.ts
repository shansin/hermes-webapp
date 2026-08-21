/**
 * Destructive actions with a window to take them back.
 *
 * Deleting a session or a cron job is irreversible on the backend — there is no
 * "restore" endpoint to call — so an Undo button cannot put anything back after
 * the fact. The only honest way to offer one is to not do the irreversible part
 * yet: hide the thing immediately, and let the request itself wait out the life
 * of the toast.
 *
 * That is what this does, and it is why the timer lives at module scope rather
 * than in a component. Swiping a row away and immediately navigating elsewhere
 * unmounts the list; a `setTimeout` owned by that component would be cleaned up
 * with it and the delete would never happen, leaving the row back on the next
 * visit. Here it survives the navigation and commits regardless.
 *
 * A full page reload inside the window loses the pending commit, and the row
 * comes back. That is the same bargain every undo toast makes, and it fails in
 * the safe direction: nothing is destroyed that the user did not watch leave.
 */

export interface Undoable {
  /** Take it back. Safe to call after the window has closed; then it no-ops. */
  undo: () => void;
}

interface Pending {
  commit: () => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Whether the window has closed, either way it can close.
   *
   * One flag rather than two, because both outcomes mean the same thing to
   * `undo`: there is nothing left to take back. Tracking only "was undone"
   * left a committed entry looking open, so a late `undo()` — a stale handle,
   * a toast action firing on a race — would revert the optimistic hiding and
   * put a row back that the server had already deleted.
   */
  settled: boolean;
}

const pending = new Set<Pending>();

/**
 * Hide now, commit later, unless taken back first.
 *
 * `commit` is the irreversible half — the actual request. `revert` puts the
 * optimistic hiding back, and runs only if the user asks. Errors from `commit`
 * are the caller's to report: it is called with nothing watching, so it must
 * handle its own failure.
 */
export function scheduleUndoable(
  { commit, revert }: { commit: () => void; revert: () => void },
  windowMs: number,
): Undoable {
  const entry: Pending = {
    commit,
    settled: false,
    timer: setTimeout(() => {
      pending.delete(entry);
      if (entry.settled) return;
      entry.settled = true;
      commit();
    }, windowMs),
  };
  pending.add(entry);

  return {
    undo() {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      pending.delete(entry);
      revert();
    },
  };
}

/**
 * Run every pending commit now.
 *
 * Called when the app is being hidden or torn down: a delete the user has
 * already watched happen should not be quietly cancelled by them closing the
 * tab, and the request still has a chance of going out while the page unloads.
 */
export function flushUndoables(): void {
  for (const entry of [...pending]) {
    pending.delete(entry);
    clearTimeout(entry.timer);
    if (entry.settled) continue;
    entry.settled = true;
    entry.commit();
  }
}

/** How long an undo stays on offer. Matches the toast that carries it. */
export const UNDO_WINDOW_MS = 8000;
