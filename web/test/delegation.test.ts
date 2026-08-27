/**
 * The delegation registry, and the two controls that act on one child.
 *
 * Everything here is a wire contract with no second source to check it
 * against: the registry is gateway process memory, there is no REST route to
 * compare with, and `subagent.steer` answers `{"status": "rejected"}` — a
 * normal, successful JSON-RPC reply — when it declines. So the failures this
 * catches are the silent ones: a steer sent without the `session_id` the
 * gateway resolves authority from (it rejects, and nothing on screen changes),
 * or a rejection read as a success (the app says "sent" and the agent carries
 * on doing the thing you were trying to redirect it away from).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn(async () => ({}) as unknown);
vi.mock('../src/ws/client', () => ({
  hermes: { call: (...args: unknown[]) => call(...(args as [])), state: 'open' },
  CONTROL_TIMEOUT_MS: 15_000,
}));

const {
  fetchDelegationStatus,
  interruptSubagent,
  isRunning,
  steerSubagent,
} = await import('../src/api/delegation');

const params = () => call.mock.calls[0]?.[1] as Record<string, unknown>;

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({});
});

describe('reading the registry', () => {
  it('keeps the fields the pane and the cards are built from', async () => {
    call.mockResolvedValue({
      active: [
        {
          subagent_id: 'sa-0-a5b872fd',
          goal: "Research Alphabet's Q2 2026 results",
          delegation_id: 'deleg_382493b3',
          owner_agent_session_id: '20260826_222512_e30f30',
          started_at: 1_787_808_481.008,
          status: 'running',
          tool_count: 5,
          last_tool: 'web_extract',
        },
      ],
      paused: false,
    });

    const status = await fetchDelegationStatus();

    expect(call).toHaveBeenCalledWith('delegation.status', {}, expect.anything());
    expect(status.active[0]).toMatchObject({
      subagent_id: 'sa-0-a5b872fd',
      owner_agent_session_id: '20260826_222512_e30f30',
      last_tool: 'web_extract',
      tool_count: 5,
    });
  });

  /**
   * The registry is assembled from whatever a child has reported so far, so
   * everything past the id is optional — and a strict parse here would empty
   * the pane rather than show a row with less on it.
   */
  it('accepts a child that has only just been dispatched', async () => {
    call.mockResolvedValue({ active: [{ subagent_id: 'sa-9' }] });

    await expect(fetchDelegationStatus()).resolves.toMatchObject({
      active: [{ subagent_id: 'sa-9' }],
    });
  });

  it('treats a missing list as nothing running', async () => {
    call.mockResolvedValue({});

    await expect(fetchDelegationStatus()).resolves.toEqual({ active: [] });
  });
});

describe('what counts as still running', () => {
  it.each(['running', 'RUNNING', 'streaming', undefined])('%s keeps the row', (status) => {
    expect(isRunning({ subagent_id: 'x', status } as never)).toBe(true);
  });

  it.each(['done', 'complete', 'completed', 'error'])('%s drops it', (status) => {
    expect(isRunning({ subagent_id: 'x', status } as never)).toBe(false);
  });
});

describe('stopping one child', () => {
  it('addresses it by subagent id, not by session', async () => {
    call.mockResolvedValue({ found: true });

    await interruptSubagent('sa-1-e6282431');

    expect(call.mock.calls[0]?.[0]).toBe('subagent.interrupt');
    expect(params()).toEqual({ subagent_id: 'sa-1-e6282431' });
  });

  /* Not an error — but not a stop either, and the row vanishes either way. */
  it('reports a child that had already finished', async () => {
    call.mockResolvedValue({ found: false });

    await expect(interruptSubagent('sa-1')).resolves.toEqual({ found: false });
  });
});

describe('steering one child', () => {
  /**
   * `session.id` is load-bearing: the method resolves steering authority from
   * it, and without one it answers `rejected` rather than failing — so a
   * dropped parameter is invisible from here.
   */
  it('carries the session doing the steering', async () => {
    call.mockResolvedValue({ status: 'queued' });

    await steerSubagent('sa-2-a160d822', 'only the errors', 'abc12345');

    expect(call.mock.calls[0]?.[0]).toBe('subagent.steer');
    expect(params()).toEqual({
      subagent_id: 'sa-2-a160d822',
      text: 'only the errors',
      session_id: 'abc12345',
    });
  });

  it('reads a refusal as a refusal', async () => {
    call.mockResolvedValue({ status: 'rejected', subagent_id: 'sa-2', text: 'x' });

    await expect(steerSubagent('sa-2', 'x', 'abc12345')).resolves.toEqual({ queued: false });
  });

  it('does not read some other shape as success', async () => {
    call.mockResolvedValue({ ok: true });

    await expect(steerSubagent('sa-2', 'x', 'abc12345')).resolves.toEqual({ queued: false });
  });
});
