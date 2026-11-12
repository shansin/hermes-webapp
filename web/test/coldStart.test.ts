/**
 * Which conversation a cold start reopens (`lib/lastSession`).
 *
 * A PWA discarded in the background reopens with nothing in memory; it used
 * to start a new chat every time. Now it resumes the last conversation if it
 * was active in the last half hour — and every explicit intent in the URL
 * (a notification's `?session=`, `?new=1`, a share-target payload) still wins,
 * because sending a shared photo into whatever was open last is the failure
 * that matters most.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  RESUME_WINDOW_MS,
  coldStartResume,
  forgetLastSession,
  readLastSession,
  rememberSession,
} from '../src/lib/lastSession';

const NOW = 1_800_000_000_000;
const none = { resumeId: null, wantNew: false, sharing: false };
const last = { id: 'stored-1', profile: 'research', at: NOW - 5 * 60_000 };

describe('coldStartResume', () => {
  it('resumes a conversation active within the window', () => {
    expect(coldStartResume(last, none, NOW)).toEqual(last);
    expect(coldStartResume({ ...last, at: NOW - RESUME_WINDOW_MS }, none, NOW)).not.toBeNull();
  });

  it('starts fresh once the window has passed', () => {
    expect(coldStartResume({ ...last, at: NOW - RESUME_WINDOW_MS - 1 }, none, NOW)).toBeNull();
  });

  it('lets every deep link win', () => {
    expect(coldStartResume(last, { ...none, resumeId: 'other' }, NOW)).toBeNull();
    expect(coldStartResume(last, { ...none, wantNew: true }, NOW)).toBeNull();
    expect(coldStartResume(last, { ...none, sharing: true }, NOW)).toBeNull();
  });

  it('does nothing without a record, or with a clock that went backwards', () => {
    expect(coldStartResume(null, none, NOW)).toBeNull();
    expect(coldStartResume({ ...last, at: NOW + 60_000 }, none, NOW)).toBeNull();
  });
});

describe('the stored record', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips, carrying the profile', () => {
    rememberSession('stored-1', 'research', NOW);
    expect(readLastSession()).toEqual({ id: 'stored-1', profile: 'research', at: NOW });
    rememberSession('stored-2', null, NOW);
    expect(readLastSession()).toEqual({ id: 'stored-2', profile: null, at: NOW });
  });

  it('ignores a session with no stored id yet', () => {
    rememberSession(null, null, NOW);
    expect(readLastSession()).toBeNull();
  });

  it('survives garbage and can be forgotten', () => {
    localStorage.setItem('hermes.lastSession', '{nope');
    expect(readLastSession()).toBeNull();
    rememberSession('stored-1', null, NOW);
    forgetLastSession();
    expect(readLastSession()).toBeNull();
  });
});
