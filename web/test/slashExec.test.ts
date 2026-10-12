/**
 * `slash.exec`'s two answers.
 *
 * A command either prints something (`{output}`) or hands the client work to
 * do (`{type, message, …}` — send this as the next turn, run this skill). The
 * output schema defaults `output` to '' and keeps unknown keys, so a typed
 * result parsed through it first comes out as a successful empty reply: the
 * command looks like it ran and nothing happens. That is what newer Hermes
 * answering `/prompt` with `{type: "send"}` produced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
vi.mock('../src/ws/client', () => ({
  hermes: { call: (...a: unknown[]) => call(...a) },
  RpcError: class RpcError extends Error {
    constructor(
      message: string,
      public code: number,
    ) {
      super(message);
    }
  },
}));

const { execCommand } = await import('../src/api/commands');

beforeEach(() => call.mockReset());

describe('execCommand', () => {
  it('returns printed output as output', async () => {
    call.mockResolvedValue({ output: 'Model: gpt' });
    expect(await execCommand('s1', '/model', '')).toEqual({ output: 'Model: gpt', warning: undefined });
  });

  it('treats a typed result as a dispatch, not an empty reply', async () => {
    call.mockResolvedValue({ type: 'send', message: 'Summarise the repo' });
    const res = await execCommand('s1', '/prompt', 'summary');

    expect(res.output).toBeUndefined();
    expect(res.dispatch).toMatchObject({ type: 'send', message: 'Summarise the repo' });
  });

  it('treats a skill result the same way', async () => {
    call.mockResolvedValue({ type: 'skill', message: 'Use the pdf skill', name: 'pdf' });
    expect((await execCommand('s1', '/pdf', '')).dispatch?.type).toBe('skill');
  });
});
