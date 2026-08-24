/**
 * Opening a conversation from a notification.
 *
 * A cron feed row navigates to `/chat?session=<run id>`, where the run id is
 * also the stored session id. This mounts the real screen and checks which
 * gateway call it makes — the difference between landing in the run's own
 * conversation and landing in a fresh empty one is invisible from the outside
 * until you look at whether `session.resume` or `session.create` went out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/lib/haptics', () => ({ buzz: vi.fn(), setHapticsEnabled: vi.fn() }));

// The screen's children are not what is under test, and each drags in the
// markdown pipeline, recharts or the audio stack.
vi.mock('../src/components/chat/MessageList', () => ({ MessageList: () => <div /> }));
vi.mock('../src/components/composer/Composer', () => ({ Composer: () => <div /> }));
vi.mock('../src/components/composer/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('../src/components/chat/ModelSheet', () => ({ ModelSheet: () => null }));
vi.mock('../src/components/chat/ContextSheet', () => ({ ContextSheet: () => null }));
vi.mock('../src/components/shared/MenuButton', () => ({ MenuButton: () => <button /> }));
vi.mock('../src/lib/useSlashRunner', () => ({
  useSlashRunner: () => ({ run: vi.fn(), busy: false }),
}));
vi.mock('../src/ws/client', () => ({
  hermes: { connect: vi.fn(), onEvent: () => () => {}, onState: () => () => {}, state: 'open' },
}));

const createSession = vi.fn();
const resumeSession = vi.fn();
const fetchHistory = vi.fn();
vi.mock('../src/api/gateway', () => ({
  createSession: (...a: unknown[]) => createSession(...(a as [])),
  resumeSession: (...a: unknown[]) => resumeSession(...(a as [])),
  fetchHistory: (...a: unknown[]) => fetchHistory(...(a as [])),
}));

const fetchSessionTitle = vi.fn();
const fetchStoredMessages = vi.fn();
vi.mock('../src/api/sessions', () => ({
  fetchSessionTitle: (...a: unknown[]) => fetchSessionTitle(...(a as [])),
  fetchStoredMessages: (...a: unknown[]) => fetchStoredMessages(...(a as [])),
  // The header's running-count pill reads this. Idle: these tests are about
  // deep links, and a pill that never appears is the right backdrop for them.
  useActiveSessions: () => ({ data: { sessions: [] }, isLoading: false, error: null }),
  // The header's `⋯` fetches this only once the actions sheet is opened, which
  // these tests never do — so an idle query is the honest stand-in.
  useSessionRow: () => ({ data: undefined, isLoading: false, error: null }),
}));

const { ChatScreen } = await import('../src/screens/ChatScreen');
const { useSession } = await import('../src/store/session');
const { useUi } = await import('../src/store/ui');

/** The shape the gateway actually returns for a cron run — captured live. */
const RESUMED = {
  session_id: 'e185fca3',
  message_count: 16,
  info: { model: 'opus' },
  // Deliberately no `stored_session_id` and no `title`: the real gateway omits
  // both for a cron run, and the screen has to cope.
};

const CRON_ID = 'cron_aaed47257a75_20260820_172854';

beforeEach(() => {
  createSession.mockReset().mockResolvedValue({ session_id: 'new1111' });
  resumeSession.mockReset().mockResolvedValue(RESUMED);
  fetchHistory.mockReset().mockResolvedValue([
    { role: 'user', text: '[IMPORTANT: You are running as a scheduled cron job…]' },
    { role: 'assistant', text: 'Meta stayed flat.' },
  ]);
  fetchSessionTitle.mockReset().mockResolvedValue('meta-trial-digest · Aug 20 17:29');
  fetchStoredMessages.mockReset().mockResolvedValue([]);

  useSession.getState().reset();
  useUi.setState({ connection: 'open' });
});

afterEach(cleanup);

/**
 * The header's running-count pill reads react-query, so the screen needs a
 * client even though none of these tests touch it. `retry: false` keeps a
 * failed background fetch from holding the test open.
 */
const openAt = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <ChatScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('arriving from a cron notification', () => {
  it('resumes the run’s own conversation', async () => {
    openAt(`/chat?session=${CRON_ID}`);
    // The second argument is the profile whose store holds the session.
    // Null here on purpose: a notification written before profiles were
    // threaded through carries no profile, and must still resume against the
    // gateway's own launch profile exactly as it always did.
    await waitFor(() => expect(resumeSession).toHaveBeenCalledWith(CRON_ID, null));
  });

  /**
   * The failure this is really guarding. Falling through to `session.create`
   * drops the user into a brand new empty chat — which from the outside looks
   * exactly like being taken to a random session.
   */
  it('never creates a fresh session instead', async () => {
    openAt(`/chat?session=${CRON_ID}`);
    await waitFor(() => expect(resumeSession).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(createSession).not.toHaveBeenCalled();
  });

  it('adopts the resumed session and its history', async () => {
    openAt(`/chat?session=${CRON_ID}`);
    await waitFor(() => expect(useSession.getState().sessionId).toBe('e185fca3'));
    expect(useSession.getState().messages).toHaveLength(2);
  });

  /** No `stored_session_id` comes back, so the id from the URL has to stand in. */
  it('keeps the stored id the notification named', async () => {
    openAt(`/chat?session=${CRON_ID}`);
    await waitFor(() => expect(useSession.getState().storedSessionId).toBe(CRON_ID));
  });

  it('restores the stored title, since a resume carries none', async () => {
    openAt(`/chat?session=${CRON_ID}`);
    await waitFor(() =>
      expect(useSession.getState().title).toBe('meta-trial-digest · Aug 20 17:29'),
    );
  });

  it('carries a profile through to the resume when the link names one', async () => {
    /* Sessions live in per-profile stores, so a link from the sessions screen
       or a kanban card to another profile's session names that profile. The
       gateway's `session.resume` takes it; without it the id is looked up in
       the launch profile's state.db and is simply not there — a failed resume
       that looks like a missing session rather than a wrong store. */
    openAt(`/chat?resume=${CRON_ID}&profile=research`);
    await waitFor(() => expect(resumeSession).toHaveBeenCalledWith(CRON_ID, 'research'));
  });

  it('treats ?resume= identically', async () => {
    openAt(`/chat?resume=${CRON_ID}`);
    // The second argument is the profile whose store holds the session.
    // Null here on purpose: a notification written before profiles were
    // threaded through carries no profile, and must still resume against the
    // gateway's own launch profile exactly as it always did.
    await waitFor(() => expect(resumeSession).toHaveBeenCalledWith(CRON_ID, null));
  });
});

describe('when the resume genuinely fails', () => {
  it('falls back to a new session rather than a dead screen', async () => {
    resumeSession.mockRejectedValue(new Error('no such session'));
    openAt(`/chat?session=${CRON_ID}`);
    await waitFor(() => expect(createSession).toHaveBeenCalled());
  });
});

describe('a cosmetic failure must not cost the conversation', () => {
  /**
   * Everything after the adopt is decoration — the offline mirror, the stored
   * title. A throw from any of them lands in the same catch as a failed
   * resume, which tears down the conversation that had already loaded and
   * replaces it with an empty one.
   */
  it('keeps the resumed session when the title lookup fails', async () => {
    fetchSessionTitle.mockRejectedValue(new Error('404'));
    openAt(`/chat?session=${CRON_ID}`);

    await waitFor(() => expect(useSession.getState().sessionId).toBe('e185fca3'));
    await new Promise((r) => setTimeout(r, 50));
    expect(createSession).not.toHaveBeenCalled();
    expect(useSession.getState().sessionId).toBe('e185fca3');
  });

  /**
   * The realistic trigger in production: `fetchHistory` parses strictly and
   * carries the 15s control timeout, so a long cron transcript over a phone's
   * radio is exactly the shape that fails here.
   */
  it('keeps the resumed session when the history fetch fails', async () => {
    fetchHistory.mockRejectedValue(new Error('session.history timed out'));
    openAt(`/chat?session=${CRON_ID}`);

    await waitFor(() => expect(useSession.getState().sessionId).toBe('e185fca3'));
    await new Promise((r) => setTimeout(r, 50));
    expect(createSession).not.toHaveBeenCalled();
    expect(useSession.getState().storedSessionId).toBe(CRON_ID);
  });

  it('says the history did not load rather than failing silently', async () => {
    fetchHistory.mockRejectedValue(new Error('session.history timed out'));
    openAt(`/chat?session=${CRON_ID}`);

    await waitFor(() =>
      expect(useUi.getState().toasts.some((t) => /history/i.test(t.text))).toBe(true),
    );
  });

  it('keeps the resumed session when warming the offline mirror fails', async () => {
    fetchStoredMessages.mockRejectedValue(new Error('offline'));
    openAt(`/chat?session=${CRON_ID}`);

    await waitFor(() => expect(useSession.getState().sessionId).toBe('e185fca3'));
    await new Promise((r) => setTimeout(r, 50));
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe('no intent in the URL', () => {
  it('starts a session when there is none', async () => {
    openAt('/chat');
    await waitFor(() => expect(createSession).toHaveBeenCalled());
  });

  it('does not resume anything', async () => {
    openAt('/chat');
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(resumeSession).not.toHaveBeenCalled();
  });
});
