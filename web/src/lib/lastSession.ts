/**
 * The conversation this device was last in, so a cold start can go back to it.
 *
 * A PWA the OS discarded in the background reopens with an empty store, and
 * the boot effect used to treat "no session in memory" as "start a new one" —
 * so glancing away for five minutes cost the conversation you were in, which
 * then had to be found again on the Sessions screen. Now a cold start without
 * a deep link resumes it, but only within a short window: after half an hour
 * the likelier intent on opening the app is a new question.
 *
 * Recorded only once a conversation has a *message* (a prompt sent, a reply
 * finished, a stored session resumed), never on `session.create`. Hermes
 * creates the stored row lazily on the first prompt, so a fresh empty chat has
 * no row to resume — remembering it would make the next cold start fail its
 * resume and fall back to a new chat anyway, with an error toast on the way.
 *
 * localStorage rather than the store: the store is exactly what a cold start
 * has lost.
 */

const KEY = 'hermes.lastSession';

/** How recent the last conversation must be for a cold start to reopen it. */
export const RESUME_WINDOW_MS = 30 * 60_000;

export interface LastSession {
  /** Stored session id (the REST one), not the gateway handle. */
  id: string;
  /** The profile whose store holds it; null for the active one. */
  profile: string | null;
  /** Epoch ms of the last activity seen in it. */
  at: number;
}

export function rememberSession(id: string | null, profile: string | null, now = Date.now()): void {
  if (!id) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ id, profile, at: now } satisfies LastSession));
  } catch {
    // Private mode or quota: a cold start simply opens a new chat, as before.
  }
}

export function readLastSession(): LastSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastSession>;
    if (typeof v.id !== 'string' || !v.id || typeof v.at !== 'number') return null;
    return { id: v.id, profile: typeof v.profile === 'string' ? v.profile : null, at: v.at };
  } catch {
    return null;
  }
}

/** Forget it, e.g. after it failed to resume — so the next cold start does not retry a dead id. */
export function forgetLastSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}

/**
 * What a boot with no session in memory should resume, if anything.
 *
 * Every explicit intent wins: a `?resume=` / `?session=` link names its own
 * conversation, and `?new=1` or a share-target payload asks for a fresh one —
 * a photo shared into the app must not land in whatever was open last.
 */
export function coldStartResume(
  last: LastSession | null,
  intent: { resumeId: string | null; wantNew: boolean; sharing: boolean },
  now = Date.now(),
): LastSession | null {
  if (intent.resumeId || intent.wantNew || intent.sharing) return null;
  if (!last) return null;
  const age = now - last.at;
  // A clock that moved backwards makes a negative age; treat it as unknown.
  if (age < 0 || age > RESUME_WINDOW_MS) return null;
  return last;
}
