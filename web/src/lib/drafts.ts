/**
 * Unsent composer text, kept per conversation.
 *
 * The box used to be plain component state, so anything that unmounted the
 * composer threw a half-written message away: opening Files to check a path,
 * switching to another chat to copy something, or — the common one on a
 * phone — the OS discarding a backgrounded PWA. Drafts are keyed on the
 * *stored* session id, because that is the id that survives all three; the
 * gateway handle is minted afresh by every resume. A conversation that has no
 * stored id yet files under `NEW_CHAT_KEY` and is re-keyed in place when one
 * arrives (see `useComposerDraft`).
 *
 * One localStorage entry holding every draft, rather than one entry each, so
 * the cap is a single read-modify-write: at most `MAX_DRAFTS`, oldest-touched
 * evicted first. Every storage touch is wrapped — private mode, a full quota
 * or a corrupted entry means drafts simply don't persist, never a broken box.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useSession } from '../store/session';

export const DRAFTS_KEY = 'hermes.drafts';
export const NEW_CHAT_KEY = '__new__';
export const MAX_DRAFTS = 30;
/** Long enough to skip most keystrokes, short enough that a swipe-away keeps the last words. */
export const DRAFT_DEBOUNCE_MS = 400;

interface Entry {
  text: string;
  /** Last written, for LRU eviction. */
  at: number;
}

type Drafts = Record<string, Entry>;

function readAll(): Drafts {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Drafts = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const e = value as Partial<Entry> | null;
      if (e && typeof e.text === 'string' && typeof e.at === 'number') out[key] = { text: e.text, at: e.at };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(drafts: Drafts): void {
  try {
    if (Object.keys(drafts).length === 0) localStorage.removeItem(DRAFTS_KEY);
    else localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Quota or private mode: the draft lives only as long as the page does.
  }
}

/** The saved draft for `key`, or null when there is none. */
export function loadDraft(key: string): string | null {
  return readAll()[key]?.text ?? null;
}

/**
 * Save (or, for blank text, forget) the draft for `key`, evicting the
 * least-recently written beyond `MAX_DRAFTS`.
 */
export function saveDraft(key: string, text: string, now = Date.now()): void {
  const drafts = readAll();
  if (!text.trim()) {
    if (!(key in drafts)) return;
    delete drafts[key];
    writeAll(drafts);
    return;
  }
  if (drafts[key]?.text === text) return; // Unchanged: no write, no reorder.
  drafts[key] = { text, at: now };
  const keys = Object.keys(drafts);
  if (keys.length > MAX_DRAFTS) {
    keys
      .sort((a, b) => (drafts[a]?.at ?? 0) - (drafts[b]?.at ?? 0))
      .slice(0, keys.length - MAX_DRAFTS)
      .forEach((k) => delete drafts[k]);
  }
  writeAll(drafts);
}

export function clearDraft(key: string): void {
  saveDraft(key, '');
}

/** Which draft the composer is editing; null while there is no session at all. */
export function draftKey(
  storedSessionId: string | null,
  sessionId: string | null,
  pristine = false,
): string | null {
  // A never-sent new chat is minted a stored id that no cold start reopens;
  // keying its draft there orphaned it on every reload.
  if (pristine && sessionId) return NEW_CHAT_KEY;
  if (storedSessionId) return storedSessionId;
  return sessionId ? NEW_CHAT_KEY : null;
}

/**
 * Keep the composer's text in step with the draft of whichever conversation
 * is on screen. Returns `discard`, for the send path: the text has gone, and
 * a debounced write still pending must not bring it back.
 *
 * The box belongs to an *owner* key, which is not always the current one:
 * between conversations (`reset()` clears both ids before the next session is
 * adopted) there is no key, and the box still holds the previous chat's text.
 * Treating that gap as "a new owner" would carry one chat's words into the
 * next, so the owner only changes when a real key arrives.
 */
export function useComposerDraft(text: string, setText: (text: string) => void): () => void {
  const sessionId = useSession((s) => s.sessionId);
  const storedSessionId = useSession((s) => s.storedSessionId);
  const pristine = useSession((s) => s.pristine);
  const key = draftKey(storedSessionId, sessionId, pristine);

  const owner = useRef<{ key: string | null; sessionId: string | null }>({ key: null, sessionId: null });
  const textRef = useRef(text);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Declared first so the key effect below reads this render's text.
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (owner.current.key) saveDraft(owner.current.key, textRef.current);
  }, []);

  useEffect(() => {
    const prev = owner.current;
    if (key === prev.key) {
      owner.current = { key, sessionId };
      return;
    }
    // Between sessions: save what is there, and leave the box to whoever comes next.
    if (!key) {
      flush();
      return;
    }
    const typed = textRef.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    owner.current = { key, sessionId };

    // The same conversation just learned its stored id: same draft, new name.
    if (prev.key === NEW_CHAT_KEY && prev.sessionId === sessionId) {
      saveDraft(key, typed);
      clearDraft(NEW_CHAT_KEY);
      return;
    }

    if (prev.key) {
      saveDraft(prev.key, typed);
      setText(loadDraft(key) ?? '');
      return;
    }

    // First key this composer has seen (cold start). Anything typed while the
    // session was still coming up wins over an older saved draft.
    const restored = loadDraft(key);
    if (restored != null && !typed.trim()) setText(restored);
  }, [key, sessionId, setText, flush]);

  // Debounced write of whatever is typed, under the box's owner.
  useEffect(() => {
    if (!owner.current.key) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, DRAFT_DEBOUNCE_MS);
  }, [text, flush]);

  // A discarded PWA gets `pagehide` / a hidden visibility state and nothing
  // after, so the debounce window is written out there, as on unmount.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [flush]);

  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    textRef.current = '';
    if (owner.current.key) clearDraft(owner.current.key);
  }, []);
}
