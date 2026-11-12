/**
 * Sending into a running turn: queue, steer, redirect — and background runs.
 *
 * `session.steer` and `session.redirect` answer a decline as a *successful*
 * reply (`{status: "rejected"}`), and `session.steer` reports an accepted
 * steer as `"queued"`. Read wrongly, either way the app says "done" while the
 * text went nowhere, or queues a second copy of guidance the agent already
 * has. So what is pinned is the outcome per status: what the gateway was
 * sent, whether the message survived, and that a decline is said out loud.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/haptics', () => ({ buzz: vi.fn(), setHapticsEnabled: vi.fn() }));

const { ConnectionLost, CallTimeout } = vi.hoisted(() => ({
  ConnectionLost: class ConnectionLost extends Error {},
  CallTimeout: class CallTimeout extends Error {},
}));

type Handler = (e: { type: string; session_id?: string; payload?: unknown }) => void;
const handlers = new Set<Handler>();
const call = vi.fn(async (..._args: unknown[]) => ({}) as unknown);
vi.mock('../src/ws/client', () => ({
  hermes: {
    call: (...args: unknown[]) => call(...args),
    onEvent: (h: Handler) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    onState: () => () => {},
    state: 'open',
  },
  CONTROL_TIMEOUT_MS: 15_000,
  ConnectionLost,
  CallTimeout,
}));

const { useSession } = await import('../src/store/session');
const { useUi } = await import('../src/store/ui');
const { sendWhileRunning, startBackground, useSendMode } = await import('../src/store/turnControl');

const store = () => useSession.getState();
const notices = () => store().messages.filter((m) => m.kind === 'notice');
const toasts = () => useUi.getState().toasts.map((t) => t.text);
const emit = (type: string, payload: unknown) => handlers.forEach((h) => h({ type, session_id: 's1', payload }));

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({});
  handlers.clear();
  localStorage.clear();
  useUi.setState({ toasts: [] });
  store().reset();
  store().adoptSession({ sessionId: 's1', storedSessionId: 'stored-1' });
  useSession.setState({ running: true });
});

describe('queue', () => {
  it('holds the message locally and never calls the gateway', async () => {
    expect(await sendWhileRunning('queue', 'next thing')).toBe('queued');
    expect(call).not.toHaveBeenCalled();
    expect(store().queued).toEqual({ text: 'next thing', display: undefined });
  });

  it('is what a send carrying a picture takes, whatever the mode', async () => {
    expect(await sendWhileRunning('steer', 'look', { display: 'look\n@image:/tmp/a.png' })).toBe('queued');
    expect(call).not.toHaveBeenCalled();
    expect(store().queued?.display).toContain('@image:');
  });
});

describe('steer', () => {
  it('sends the text with the session and notes an accepted steer in the transcript', async () => {
    call.mockResolvedValue({ status: 'queued', text: 'use the staging db' });
    expect(await sendWhileRunning('steer', 'use the staging db')).toBe('steered');
    expect(call).toHaveBeenCalledWith(
      'session.steer',
      { session_id: 's1', text: 'use the staging db' },
      expect.anything(),
    );
    // "queued" from session.steer means accepted mid-turn — not a second copy for later.
    expect(store().queued).toBeNull();
    expect(notices().at(-1)).toMatchObject({ text: 'use the staging db', tone: 'info' });
    expect(toasts()).toEqual([]);
  });

  it('falls back to the local queue on "rejected", and says so', async () => {
    call.mockResolvedValue({ status: 'rejected', text: 'x' });
    expect(await sendWhileRunning('steer', 'x')).toBe('fell-back');
    expect(store().queued).toEqual({ text: 'x', display: undefined });
    expect(toasts()[0]).toMatch(/Steer not accepted — queued for after this turn/);
  });

  it('falls back on a gateway error too, naming it', async () => {
    call.mockRejectedValue(new Error('agent does not support steer'));
    expect(await sendWhileRunning('steer', 'x')).toBe('fell-back');
    expect(store().queued?.text).toBe('x');
    expect(toasts()[0]).toContain('agent does not support steer');
  });

  /**
   * The socket went, or no answer came, with the steer possibly delivered:
   * queueing it as well sent the same guidance twice once the turn ended.
   */
  it.each([
    ['the socket went', () => new ConnectionLost()],
    ['the call timed out', () => new CallTimeout()],
  ])('hands the text back to the composer, unqueued, when %s', async (_why, error) => {
    call.mockRejectedValue(error());
    expect(await sendWhileRunning('steer', 'use the staging db')).toBe('unconfirmed');
    expect(store().queued).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
    expect(store().returnedText).toEqual({ text: 'use the staging db' });
    expect(toasts()[0]).toBe(
      "Couldn't confirm the steer was delivered — check the transcript before resending",
    );
  });

  it('sends as a new message when the turn ended while the call was out', async () => {
    call.mockImplementation(async (method: unknown) => {
      if (method === 'session.steer') {
        useSession.setState({ running: false });
        return { status: 'rejected' };
      }
      return {};
    });
    await sendWhileRunning('steer', 'late');
    expect(call).toHaveBeenLastCalledWith('prompt.submit', { session_id: 's1', text: 'late' });
    expect(toasts()[0]).toMatch(/turn had finished/);
  });

  it('touches nothing when the conversation changed under the call', async () => {
    call.mockImplementation(async () => {
      store().reset();
      store().adoptSession({ sessionId: 's2' });
      return { status: 'rejected' };
    });
    await sendWhileRunning('steer', 'stray');
    expect(store().queued).toBeNull();
    expect(store().messages).toEqual([]);
    expect(toasts()).toEqual([]);
  });
});

describe('redirect', () => {
  it('calls session.redirect and notes the redirect', async () => {
    call.mockResolvedValue({ status: 'redirected', text: 'shorter please' });
    expect(await sendWhileRunning('redirect', 'shorter please')).toBe('redirected');
    expect(call.mock.calls[0]?.[0]).toBe('session.redirect');
    expect(store().queued).toBeNull();
    expect(notices()).toHaveLength(1);
  });

  it('treats "queued" as the backend having made it the next turn — no local copy', async () => {
    call.mockResolvedValue({ status: 'queued', text: 'x' });
    expect(await sendWhileRunning('redirect', 'x')).toBe('queued-next-turn');
    expect(store().queued).toBeNull();
  });

  it('hands an unconfirmed redirect back rather than queueing it', async () => {
    call.mockRejectedValue(new ConnectionLost());
    expect(await sendWhileRunning('redirect', 'x')).toBe('unconfirmed');
    expect(store().queued).toBeNull();
    expect(store().returnedText).toEqual({ text: 'x' });
    expect(toasts()[0]).toMatch(/^Couldn't confirm the redirect was delivered/);
  });

  it('falls back to the local queue on "rejected"', async () => {
    call.mockResolvedValue({ status: 'rejected', text: 'x' });
    expect(await sendWhileRunning('redirect', 'x')).toBe('fell-back');
    expect(store().queued?.text).toBe('x');
    expect(toasts()[0]).toMatch(/^Redirect not accepted/);
  });
});

describe('the mode preference', () => {
  it('persists per device', () => {
    useSendMode.getState().setMode('redirect');
    expect(localStorage.getItem('hermes.sendMode')).toBe('redirect');
  });
});

describe('background runs', () => {
  it('starts with prompt.background and lands the matching answer in the transcript', async () => {
    call.mockResolvedValue({ task_id: 'bg_abc123' });
    expect(await startBackground('s1', '  summarise the repo  ')).toBe('bg_abc123');
    expect(call).toHaveBeenCalledWith(
      'prompt.background',
      { session_id: 's1', text: 'summarise the repo' },
      expect.anything(),
    );

    emit('background.complete', { task_id: 'bg_other', text: 'not ours' });
    expect(notices()).toHaveLength(0);

    emit('background.complete', { task_id: 'bg_abc123', text: 'Here is the summary.' });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ text: 'Here is the summary.', tone: 'info' });
    expect(handlers.size).toBe(0);
  });

  it('marks an errored run as an error, and drops an answer for a conversation since left', async () => {
    call.mockResolvedValue({ task_id: 'bg_1' });
    await startBackground('s1', 'a');
    emit('background.complete', { task_id: 'bg_1', text: 'error: boom' });
    expect(notices()[0]?.tone).toBe('error');

    call.mockResolvedValue({ task_id: 'bg_2' });
    await startBackground('s1', 'b');
    store().reset();
    store().adoptSession({ sessionId: 's2' });
    emit('background.complete', { task_id: 'bg_2', text: 'late answer' });
    expect(notices()).toHaveLength(0);
  });
});
