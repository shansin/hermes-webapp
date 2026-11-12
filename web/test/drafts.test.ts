/**
 * Per-conversation composer drafts.
 *
 * The failures here are all silent until someone has lost a paragraph: a
 * draft that never reached storage, one conversation's text appearing in
 * another's box, or a new chat's words wiped the moment it learns its stored
 * id. The storage half is also the place a phone in private mode or with a
 * full quota must not break the composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';

vi.mock('../src/lib/haptics', () => ({ buzz: vi.fn(), setHapticsEnabled: vi.fn() }));
vi.mock('../src/ws/client', () => ({
  hermes: { call: vi.fn(async () => ({})), onEvent: () => () => {}, onState: () => () => {}, state: 'open' },
  ConnectionLost: class extends Error {},
}));

const {
  DRAFTS_KEY,
  DRAFT_DEBOUNCE_MS,
  MAX_DRAFTS,
  NEW_CHAT_KEY,
  clearDraft,
  draftKey,
  loadDraft,
  saveDraft,
  useComposerDraft,
} = await import('../src/lib/drafts');
const { useSession } = await import('../src/store/session');

beforeEach(() => {
  localStorage.clear();
  useSession.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('draft storage', () => {
  it('round-trips, and forgets a draft that is cleared or blank', () => {
    saveDraft('a', 'half a thought');
    expect(loadDraft('a')).toBe('half a thought');
    saveDraft('a', '   ');
    expect(loadDraft('a')).toBeNull();
    saveDraft('b', 'x');
    clearDraft('b');
    expect(localStorage.getItem(DRAFTS_KEY)).toBeNull();
  });

  it(`keeps at most ${MAX_DRAFTS}, evicting the least recently written`, () => {
    for (let i = 0; i <= MAX_DRAFTS; i++) saveDraft(`s${i}`, `draft ${i}`, 1000 + i);
    expect(loadDraft('s0')).toBeNull();
    expect(loadDraft('s1')).toBe('draft 1');
    expect(loadDraft(`s${MAX_DRAFTS}`)).toBe(`draft ${MAX_DRAFTS}`);
    expect(Object.keys(JSON.parse(localStorage.getItem(DRAFTS_KEY)!))).toHaveLength(MAX_DRAFTS);
  });

  it('treats a corrupted entry as no drafts rather than throwing', () => {
    localStorage.setItem(DRAFTS_KEY, '{not json');
    expect(loadDraft('a')).toBeNull();
    saveDraft('a', 'fresh');
    expect(loadDraft('a')).toBe('fresh');
  });

  it('survives storage that refuses every call', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => saveDraft('a', 'text')).not.toThrow();
    expect(loadDraft('a')).toBeNull();
  });

  it('keys on the stored id, the new-chat key before one exists, nothing without a session', () => {
    expect(draftKey('20260101_x', 'ab12cd34')).toBe('20260101_x');
    expect(draftKey(null, 'ab12cd34')).toBe(NEW_CHAT_KEY);
    expect(draftKey(null, null)).toBeNull();
    // A never-sent new chat has a stored id no cold start reopens.
    expect(draftKey('20260101_x', 'ab12cd34', true)).toBe(NEW_CHAT_KEY);
    expect(draftKey('20260101_x', null, true)).toBe('20260101_x');
  });
});

/** The composer's text state plus the hook, as `Composer` wires them. */
function useBox() {
  const [text, setText] = useState('');
  const discard = useComposerDraft(text, setText);
  return { text, setText, discard };
}

const adopt = (sessionId: string, storedSessionId?: string) =>
  act(() => useSession.getState().adoptSession({ sessionId, storedSessionId }));

describe('useComposerDraft', () => {
  beforeEach(() => vi.useFakeTimers());

  it('writes typed text after the debounce and restores it on the next mount', () => {
    adopt('g1', 'stored-1');
    const first = renderHook(useBox);
    act(() => first.result.current.setText('remember this'));
    expect(loadDraft('stored-1')).toBeNull();
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS));
    expect(loadDraft('stored-1')).toBe('remember this');
    first.unmount();

    const second = renderHook(useBox);
    expect(second.result.current.text).toBe('remember this');
  });

  it('flushes on unmount, so leaving inside the debounce window loses nothing', () => {
    adopt('g1', 'stored-1');
    const { result, unmount } = renderHook(useBox);
    act(() => result.current.setText('typed and left'));
    unmount();
    expect(loadDraft('stored-1')).toBe('typed and left');
  });

  it('swaps drafts between conversations without carrying text across the gap', () => {
    saveDraft('stored-2', 'second chat draft');
    adopt('g1', 'stored-1');
    const { result } = renderHook(useBox);
    act(() => result.current.setText('first chat draft'));

    // `reset()` empties both ids before the next session is adopted.
    act(() => useSession.getState().reset());
    expect(result.current.text).toBe('first chat draft');
    adopt('g2', 'stored-3');
    expect(result.current.text).toBe('');
    expect(loadDraft('stored-1')).toBe('first chat draft');

    act(() => useSession.getState().reset());
    adopt('g3', 'stored-2');
    expect(result.current.text).toBe('second chat draft');
  });

  it('keeps a new chat’s text when the same session learns its stored id', () => {
    adopt('g1');
    const { result } = renderHook(useBox);
    act(() => result.current.setText('before the id'));
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS));
    expect(loadDraft(NEW_CHAT_KEY)).toBe('before the id');

    act(() => useSession.setState({ storedSessionId: 'stored-9' }));
    expect(result.current.text).toBe('before the id');
    expect(loadDraft('stored-9')).toBe('before the id');
    expect(loadDraft(NEW_CHAT_KEY)).toBeNull();
  });

  it('discard drops the draft and a write still pending', () => {
    adopt('g1', 'stored-1');
    const { result, unmount } = renderHook(useBox);
    act(() => result.current.setText('sending this'));
    act(() => {
      result.current.discard();
      result.current.setText('');
    });
    act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS));
    unmount();
    expect(loadDraft('stored-1')).toBeNull();
  });

  it('lets text typed before any session win over an older saved draft', () => {
    saveDraft('stored-1', 'old');
    const { result } = renderHook(useBox);
    act(() => result.current.setText('typed while connecting'));
    adopt('g1', 'stored-1');
    expect(result.current.text).toBe('typed while connecting');
  });
});
