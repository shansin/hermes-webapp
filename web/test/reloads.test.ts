/**
 * `/reload-mcp`, `/reload-skills` and `/bg` from the phone.
 *
 * The MCP reload has a confirm gate (`reload.mcp` answers
 * `{status: "confirm_required"}` and does nothing without `confirm: true`),
 * so the two ways to get it wrong are both quiet: reading that answer as a
 * success says "reloaded" when nothing was, and sending `confirm` on the first
 * call skips a warning the user's own config asked for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn(async (..._a: unknown[]) => ({}) as unknown);
vi.mock('../src/ws/client', () => ({
  hermes: { call: (...a: unknown[]) => call(...a), onEvent: () => () => {}, onState: () => () => {} },
  CONTROL_TIMEOUT_MS: 15_000,
  ConnectionLost: class extends Error {},
}));

const { describeMcpReload, mcpReloadParams, readMcpReload, reloadMcp, reloadSkills } = await import(
  '../src/lib/reloads'
);
const { canonicalCommand, isRunnable, isSuggestion, resolveCommand } = await import('../src/lib/slashCommands');

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({});
});

describe('reload.mcp', () => {
  it('asks first: no confirm unless the user said now or always', () => {
    expect(mcpReloadParams('s1')).toEqual({ session_id: 's1' });
    expect(mcpReloadParams('s1', 'now')).toEqual({ session_id: 's1', confirm: true });
    expect(mcpReloadParams('s1', 'ALWAYS')).toEqual({ session_id: 's1', confirm: true, always: true });
    expect(mcpReloadParams(null, 'banana')).toEqual({});
  });

  it('reads confirm_required as not reloaded', async () => {
    call.mockResolvedValue({ status: 'confirm_required', message: '⚠️ …' });
    const res = await reloadMcp('s1');
    expect(res.status).toBe('confirm_required');
    expect(describeMcpReload(res)).toMatch(/\/reload-mcp now/);
    expect(call).toHaveBeenCalledWith('reload.mcp', { session_id: 's1' });
  });

  it('confirms on the second call', async () => {
    call.mockResolvedValue({ status: 'reloaded', loaded_rev: 'abc' });
    expect(await reloadMcp('s1', { confirm: true })).toEqual({ status: 'reloaded', coalesced: false });
    expect(call).toHaveBeenCalledWith('reload.mcp', { session_id: 's1', confirm: true });
    expect(readMcpReload({ status: 'reloaded', coalesced: true })).toEqual({ status: 'reloaded', coalesced: true });
  });
});

describe('skills.reload', () => {
  it('shows the backend’s own summary', async () => {
    call.mockResolvedValue({ output: 'Reloading skills...\nNo new skills detected.\n12 skill(s) available', result: {} });
    expect(await reloadSkills('s1')).toMatch(/12 skill\(s\) available/);
    expect(call).toHaveBeenCalledWith('skills.reload', { session_id: 's1' });
  });
});

describe('the slash table', () => {
  it('runs both reloads over RPC, under either spelling', () => {
    for (const typed of ['/reload-mcp', '/reload_mcp', '/reload-skills', '/reload_skills']) {
      expect(isRunnable(typed)).toBe(true);
      expect(resolveCommand(typed)?.surface.kind).toBe('rpc');
    }
    expect(isSuggestion('/reload-mcp')).toBe(true);
    expect(isSuggestion('/reload_mcp')).toBe(false);
  });

  it('gives the MCP reload a confirm step that re-runs with "now"', () => {
    const surface = resolveCommand('/reload-mcp')?.surface;
    if (surface?.kind !== 'rpc') throw new Error('expected rpc');
    expect(surface.confirm?.needed({ status: 'confirm_required' })).toBe(true);
    expect(surface.confirm?.needed({ status: 'reloaded' })).toBe(false);
    expect(surface.confirm?.arg).toBe('now');
  });

  it('runs /bg through prompt.background, keeps /background working, and needs a prompt', () => {
    expect(canonicalCommand('/background')).toBe('/bg');
    const surface = resolveCommand('/background')?.surface;
    if (surface?.kind !== 'rpc') throw new Error('expected rpc');
    expect(surface.rpc).toBe('prompt.background');
    expect(surface.buildParams({ sessionId: 's1', arg: 'do it', name: '/bg' })).toEqual({
      session_id: 's1',
      text: 'do it',
    });
    expect(surface.usage).toBeTruthy();
    // `/bg` is what Hermes' catalog lists, so it has to be the suggestion.
    expect(isSuggestion('/bg')).toBe(true);
  });
});
