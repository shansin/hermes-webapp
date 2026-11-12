/**
 * Fork the conversation at a message and carry on in the fork.
 *
 * The non-destructive sibling of `rewind` in `store/session.ts`: an edit there
 * soft-deletes everything after the edited message, while a fork leaves the
 * original whole and continues in a new stored session made by
 * `session.branch` (see `api/branch.ts`). Two entry points use it — "Fork from
 * here" on a reply (keep the conversation through that reply) and "Edit in a
 * fork" in `EditTurnSheet` (keep everything *before* a prompt, then send the
 * edited prompt in the child).
 *
 * The order matters in three places:
 *
 *  - **Refused mid-turn.** The branch copies the persisted transcript, which
 *    lags a running turn (Hermes writes a turn when it ends), so a fork taken
 *    now would silently drop the turn on screen. The desktop app refuses for
 *    the same reason.
 *  - **The cut is computed against the stored transcript** — see
 *    `lib/forkPoint.ts` for why the screen's own index is not the count.
 *  - **Switching is an adopt, not a resume.** The branch answers with a live
 *    handle and the copied rows, so the store is reset and the child adopted
 *    exactly as `ChatScreen`'s `doResume` does, without a second round trip.
 *    The session epoch is checked first: a fork answered after the user moved
 *    to another conversation must not drag them back into it. The fork still
 *    exists then and shows up on the Sessions screen.
 *
 * Deps are injectable so the sequence can be tested without a socket, the way
 * `reconnectFlow.ts` is.
 */
import { sessionEpoch, useSession } from '../store/session';
import { branchSession, type BranchResult } from '../api/branch';
import { fetchWholeTranscript, type StoredMessage } from '../api/sessions';
import { fetchHistory } from '../api/gateway';
import type { HistoryMessage } from '../ws/types';
import {
  forkCountFromLocal,
  forkCountFromStored,
  forkLanded,
  forkTarget,
  type ForkMode,
} from './forkPoint';
import { rememberSession } from './lastSession';

export interface ForkDeps {
  branch: (sessionId: string, count: number, key: string) => Promise<BranchResult>;
  transcript: (storedId: string, profile: string | null) => Promise<{ messages: StoredMessage[] }>;
  history: (sessionId: string) => Promise<HistoryMessage[]>;
  newKey: () => string;
}

const defaultDeps: ForkDeps = {
  branch: branchSession,
  transcript: (id, profile) => fetchWholeTranscript(id, profile),
  history: fetchHistory,
  newKey: () =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `fork-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
};

export type ForkOutcome =
  | { ok: true; title: string; landed: boolean }
  | { ok: false; reason: string };

export async function forkAt(
  messageId: string,
  opts: { replacement?: string } = {},
  deps: ForkDeps = defaultDeps,
): Promise<ForkOutcome> {
  const store = useSession.getState;
  const s = store();
  const mode: ForkMode = opts.replacement != null ? 'before' : 'through';
  const target = s.messages.find((m) => m.id === messageId);

  if (!s.sessionId || s.forking || s.rewinding) return { ok: false, reason: 'busy' };
  if (s.running) {
    useSession.setState({ error: 'Stop the current turn before forking.' });
    return { ok: false, reason: 'running' };
  }
  if (!target || (mode === 'through' ? target.kind !== 'assistant' : target.kind !== 'user')) {
    return { ok: false, reason: 'not-forkable' };
  }

  const { sessionId, storedSessionId, profile, title: parentTitle } = s;
  // Snapshot: the flow compares against the transcript the tap was made on.
  const messages = s.messages;
  const token = sessionEpoch();
  useSession.setState({ forking: true, error: null });

  try {
    let count: number | null = null;
    const where = forkTarget(messages, messageId);
    if (storedSessionId && where) {
      try {
        const stored = await deps.transcript(storedSessionId, profile);
        count = forkCountFromStored(stored.messages, where, mode);
      } catch {
        // Unreadable stored copy: the screen's own count is right unless the
        // session was compacted, and `landed` below reports when it was not.
      }
    }
    count ??= forkCountFromLocal(messages, messageId, mode);
    if (sessionEpoch() !== token) return { ok: false, reason: 'moved' };
    if (count == null) {
      useSession.setState({ error: 'Could not find that message in the saved conversation.' });
      return { ok: false, reason: 'not-found' };
    }

    const res = await deps.branch(sessionId, count, deps.newKey());
    if (sessionEpoch() !== token) return { ok: false, reason: 'moved' };

    const landed = forkLanded(res.messages, messages, messageId, mode);
    const title = res.title || 'Fork';

    store().reset();
    store().adoptSession({
      sessionId: res.session_id,
      storedSessionId: res.stored_session_id,
      // The child is written into the parent's profile store.
      profile,
      info: res.info,
    });
    useSession.setState({ title, forkedFrom: parentTitle || 'Untitled chat' });
    const childToken = sessionEpoch();

    let copied = res.messages;
    if (!copied) {
      try {
        copied = await deps.history(res.session_id);
      } catch {
        copied = [];
      }
      if (sessionEpoch() !== childToken) return { ok: true, title, landed };
    }
    store().loadHistory(copied);
    rememberSession(res.stored_session_id, profile);

    if (opts.replacement != null) await store().submitPrompt(opts.replacement);
    void store().refreshUsage();
    return { ok: true, title, landed };
  } catch (err) {
    if (sessionEpoch() === token) {
      useSession.setState({ error: err instanceof Error ? err.message : 'Could not fork the conversation' });
    }
    return { ok: false, reason: 'failed' };
  } finally {
    useSession.setState({ forking: false });
  }
}
