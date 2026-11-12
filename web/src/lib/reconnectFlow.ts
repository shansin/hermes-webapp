/**
 * Reattaching to the conversation on screen after the socket came back.
 *
 * Lifted out of `ChatScreen`'s reconnect effect so the sequence can be tested
 * without rendering the screen — it is the part that is easy to get subtly
 * wrong. The why of each step (resume before anything, adopt a rebuilt handle,
 * live state before history, replay the running turn) is on that effect; what
 * lives here is the order and the two liveness checks.
 *
 * **Liveness belongs to the connection attempt, not to the session id.** The
 * effect used to cancel this flow from its own cleanup, and `sessionId` was a
 * dependency — so on a rebuilt runtime the flow's own `adoptSession` re-ran
 * the effect, its cleanup marked the flow dead mid-flight, and the transcript
 * load after `fetchHistory` was skipped: a stale transcript, a half-written
 * reply frozen under it and tool cards pulsing for ever. `isCurrent` is now the
 * caller's say on whether this connection is still the one (a later drop, or
 * the screen unmounting), and the store's session epoch says whether this is
 * still the conversation — re-read after the flow's own adopt, which changes
 * it on purpose.
 */
import type { HistoryMessage, SessionCreateResult } from '../ws/types';
import { sessionEpoch, useSession } from '../store/session';

export interface ReconnectTarget {
  sessionId: string;
  storedSessionId: string | null;
  profile: string | null;
}

export interface ReconnectDeps {
  resume: (storedId: string, profile: string | null) => Promise<SessionCreateResult>;
  fetchHistory: (sessionId: string) => Promise<HistoryMessage[]>;
  /** `session.events.since` from the start of the ring. */
  eventsSince: (sessionId: string) => Promise<{ events?: unknown[] } | null | undefined>;
  /** The full rebuild, for a resume that failed outright. */
  rebuild: (storedId: string, profile: string | null) => Promise<unknown>;
  /** False once a newer connection attempt (or an unmount) has superseded this one. */
  isCurrent: () => boolean;
}

export async function reconnectSession(target: ReconnectTarget, deps: ReconnectDeps): Promise<void> {
  const { sessionId, storedSessionId, profile } = target;
  const store = useSession.getState;
  let token = sessionEpoch();
  const current = () => deps.isCurrent() && sessionEpoch() === token;

  try {
    // No stored id — a session.create that has not answered yet, or one
    // Hermes never persisted. Nothing to resume against; reconcile alone.
    if (!storedSessionId) {
      const history = await deps.fetchHistory(sessionId);
      if (!current()) return;
      store().applyResync(history);
      void store().refreshUsage();
      return;
    }

    const res = await deps.resume(storedSessionId, profile);
    if (!current()) return;
    const rebuilt = res.session_id !== sessionId;
    if (rebuilt) {
      store().adoptSession({
        sessionId: res.session_id,
        storedSessionId: res.stored_session_id ?? storedSessionId,
        profile,
        info: res.info,
      });
      // Our own adopt moved the epoch; the conversation is still this one.
      token = sessionEpoch();
    }

    store().applyLiveState(res);

    const history = await deps.fetchHistory(res.session_id);
    if (!current()) return;
    if (rebuilt) store().loadHistory(history);
    else store().applyResync(history, { running: res.running });

    // Not on a rebuilt session: a new runtime has a new ring. And not once the
    // turn has ended while the history was out — see `applyReplay`.
    if (!rebuilt && res.running && store().running) {
      store().beginReplayWindow();
      try {
        const replay = await deps.eventsSince(res.session_id);
        // Always called, current or not: it is also what closes the window.
        store().applyReplay(current() ? (replay?.events ?? []) : []);
      } catch {
        // A backend without the ring, or a socket that dropped again: the
        // turn's cards come back when it completes, as they always did.
        store().applyReplay([]);
      }
    }
    if (current()) void store().refreshUsage();
  } catch {
    // The resume itself failed — a gateway that is up but refusing (a reap
    // still settling), or a socket that dropped again underneath us. The full
    // rebuild is the fallback it always was.
    if (!current() || !storedSessionId) return;
    await deps.rebuild(storedSessionId, store().profile);
  }
}
