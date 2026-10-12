/**
 * `session.resume` with `inline_images: false`, on a backend that may not know it.
 *
 * Hermes validates socket params with `extra="forbid"`: a key it does not
 * know answers 4000 instead of being ignored. Sent unconditionally, the flag
 * that makes a transcript kilobytes on a newer backend would make every resume
 * fail on an older one — every conversation unopenable. So it is sent once,
 * dropped on that specific refusal, and remembered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

class RpcError extends Error {
  constructor(
    message: string,
    public code: number,
  ) {
    super(message);
  }
}
const call = vi.fn();
vi.mock('../src/ws/client', () => ({
  hermes: { call: (...a: unknown[]) => call(...a) },
  CONTROL_TIMEOUT_MS: 15_000,
  RpcError,
}));

const ok = { session_id: 'abc12345' };
const refusal = new RpcError(
  'invalid params for session.resume: inline_images: Extra inputs are not permitted',
  4000,
);

beforeEach(() => {
  call.mockReset();
  vi.resetModules();
});

const load = async () => (await import('../src/api/gateway')).resumeSession;
const paramsOf = (n: number) => call.mock.calls[n]![1] as Record<string, unknown>;

describe('resumeSession', () => {
  it('asks for images as placeholders', async () => {
    call.mockResolvedValue(ok);
    await (await load())('stored-1');
    expect(paramsOf(0).inline_images).toBe(false);
  });

  it('retries without the flag when the backend refuses the key', async () => {
    call.mockRejectedValueOnce(refusal).mockResolvedValue(ok);
    const result = await (await load())('stored-1');

    expect(result.session_id).toBe('abc12345');
    expect(paramsOf(1)).not.toHaveProperty('inline_images');
  });

  it('remembers the refusal instead of paying for it on every resume', async () => {
    call.mockRejectedValueOnce(refusal).mockResolvedValue(ok);
    const resume = await load();
    await resume('stored-1');
    await resume('stored-2');

    expect(call).toHaveBeenCalledTimes(3);
    expect(paramsOf(2)).not.toHaveProperty('inline_images');
  });

  it('does not swallow any other failure', async () => {
    call.mockRejectedValue(new RpcError('session not found', 4001));
    await expect((await load())('stored-1')).rejects.toThrow('session not found');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
