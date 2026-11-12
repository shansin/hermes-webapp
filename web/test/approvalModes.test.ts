/**
 * The approval-mode chips and what they send.
 *
 * Wrong values here fail quietly: Hermes answers 4002 to any mode outside
 * `manual | smart | off`, so two sheets of invented chips (`always`, `never`,
 * `yolo`, `suggest`, `auto`) each toasted an error nobody connected to the
 * vocabulary — and a misread current value lights no chip at all.
 */
import { describe, expect, it, vi } from 'vitest';

const call = vi.fn();
vi.mock('../src/ws/client', () => ({
  hermes: { call: (...args: unknown[]) => call(...args) },
  CONTROL_TIMEOUT_MS: 1,
  RpcError: class extends Error {},
}));

const { APPROVAL_MODES, normalizeApprovalMode } = await import('../src/lib/approvalModes');
const { setApprovalMode, setSessionYolo } = await import('../src/api/gateway');

describe('approval modes', () => {
  it('offers exactly the modes Hermes accepts, with human labels', () => {
    expect(APPROVAL_MODES.map((m) => [m.mode, m.label])).toEqual([
      ['manual', 'Ask'],
      ['smart', 'Smart'],
      ['off', 'Off'],
    ]);
  });

  it.each([
    ['manual', 'manual'],
    ['smart', 'smart'],
    ['off', 'off'],
    [' Smart ', 'smart'],
    // YAML 1.1 reads a bare `off` as false; Hermes treats it as the word.
    [false, 'off'],
    // Hermes falls back to manual for a word it does not know, and enforces
    // that — so that is what to show.
    ['auto', 'manual'],
    ['yolo', 'manual'],
    // Nothing to go on: light no chip rather than guess.
    [undefined, null],
    ['', null],
    [3, null],
  ] as const)('reads %j as %j', (raw, want) => {
    expect(normalizeApprovalMode(raw)).toBe(want);
  });
});

describe('setting them', () => {
  it('writes the global key, not the legacy alias', async () => {
    call.mockResolvedValue({});
    await setApprovalMode('abcd1234', 'smart');
    expect(call.mock.calls.at(-1)?.[0]).toBe('config.set');
    expect(call.mock.calls.at(-1)?.[1]).toEqual({
      session_id: 'abcd1234',
      key: 'approvals.mode',
      value: 'smart',
    });
  });

  it('sends the per-chat bypass as an explicit on/off, never a toggle', async () => {
    // An empty value makes Hermes *flip* the flag, which races a stale switch.
    call.mockResolvedValue({});
    await setSessionYolo('abcd1234', true);
    expect(call.mock.calls.at(-1)?.[1]).toEqual({ session_id: 'abcd1234', key: 'yolo', value: 'on' });
    await setSessionYolo('abcd1234', false);
    expect(call.mock.calls.at(-1)?.[1]).toMatchObject({ key: 'yolo', value: 'off' });
  });
});
