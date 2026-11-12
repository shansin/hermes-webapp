/**
 * Reloading MCP servers and skills from the phone.
 *
 * Both were listed as "terminal only", but each has a gateway method and
 * neither needs a terminal — they are how a server added in `config.yaml` or a
 * skill dropped into `~/.hermes/skills/` reaches a session already open.
 *
 * `reload.mcp` (`tui_gateway/methods_tools.py`) carries a **confirm gate**.
 * Re-registering the tools changes the tool array, which invalidates the
 * prompt cache: the next message re-sends the whole conversation at full input
 * price. Unless `approvals.mcp_reload_confirm` is off, a call without
 * `confirm: true` reloads nothing and answers
 * `{status: "confirm_required", message}`; `always: true` alongside the
 * confirm also turns that config key off. So the gate is asked rather than
 * assumed — on an install that has silenced it, one tap reloads. Success is
 * `{status: "reloaded", loaded_rev, coalesced?}`.
 *
 * `skills.reload` (same file) rescans under the session's own profile and cwd
 * and answers `{output, result: {added, removed, total}}`, with `output`
 * already worded for a person.
 */
import { hermes } from '../ws/client';

export type McpReloadResult =
  | { status: 'confirm_required'; message: string }
  | { status: 'reloaded'; coalesced: boolean };

/** `/reload-mcp now` confirms once; `/reload-mcp always` confirms and stops asking. */
export function mcpReloadParams(sessionId: string | null, arg = ''): Record<string, unknown> {
  const word = arg.trim().toLowerCase();
  return {
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(word === 'now' || word === 'always' ? { confirm: true } : {}),
    ...(word === 'always' ? { always: true } : {}),
  };
}

export function readMcpReload(raw: unknown): McpReloadResult {
  const r = (raw ?? {}) as { status?: unknown; message?: unknown; coalesced?: unknown };
  if (r.status === 'confirm_required') {
    return { status: 'confirm_required', message: typeof r.message === 'string' ? r.message : '' };
  }
  return { status: 'reloaded', coalesced: r.coalesced === true };
}

/** Our wording, not the backend's — its message is written for a terminal prompt. */
export const MCP_CONFIRM_TEXT =
  'Reloading MCP servers resets the prompt cache, so the next message re-sends the whole conversation at full input cost.';

export function describeMcpReload(r: McpReloadResult): string {
  if (r.status === 'confirm_required') {
    return `${MCP_CONFIRM_TEXT}\nRun /reload-mcp now to go ahead, or /reload-mcp always to stop asking.`;
  }
  return r.coalesced ? 'MCP servers reloaded (joined a reload already running).' : 'MCP servers reloaded.';
}

export async function reloadMcp(
  sessionId: string | null,
  opts: { confirm?: boolean; always?: boolean } = {},
): Promise<McpReloadResult> {
  const arg = opts.always ? 'always' : opts.confirm ? 'now' : '';
  // Default (long) timeout: a reload reconnects every configured server.
  return readMcpReload(await hermes.call('reload.mcp', mcpReloadParams(sessionId, arg)));
}

export function describeSkillsReload(raw: unknown): string {
  const output = (raw as { output?: unknown } | null)?.output;
  return typeof output === 'string' && output.trim() ? output.trim() : 'Skills reloaded.';
}

export async function reloadSkills(sessionId: string | null): Promise<string> {
  return describeSkillsReload(
    await hermes.call('skills.reload', sessionId ? { session_id: sessionId } : {}),
  );
}
