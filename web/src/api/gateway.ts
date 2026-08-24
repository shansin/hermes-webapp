/**
 * Thin typed wrappers over the JSON-RPC methods the UI uses.
 *
 * Kept separate from the store so screens can call the gateway without
 * pulling in streaming state, and so every method name lives in one place.
 */
import { hermes, CONTROL_TIMEOUT_MS } from '../ws/client';
import { dispatchCommand } from './commands';
import {
  ModelOptionsSchema,
  SessionCreateResultSchema,
  SessionHistorySchema,
  type HistoryMessage,
  type ModelOptions,
  type SessionCreateResult,
} from '../ws/types';

export interface CreateOptions {
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  cwd?: string;
  title?: string;
}

export async function createSession(opts: CreateOptions = {}): Promise<SessionCreateResult> {
  const params: Record<string, unknown> = { cols: 80, source: 'web' };
  if (opts.model) params.model = opts.model;
  if (opts.provider) params.provider = opts.provider;
  if (opts.reasoningEffort) params.reasoning_effort = opts.reasoningEffort;
  if (opts.cwd) params.cwd = opts.cwd;
  if (opts.title) params.title = opts.title;

  const raw = await hermes.call('session.create', params, { timeoutMs: CONTROL_TIMEOUT_MS });
  return SessionCreateResultSchema.parse(raw);
}

/** Reopen a stored session by its persistent id. */
/**
 * @param profile the profile whose `state.db` holds this session, when it is
 *   not the one the gateway was launched as. `session.resume` supports it
 *   explicitly ("resume a session that lives in another local profile's
 *   state.db"); without it the id is looked up in the launch profile's store
 *   and simply is not there, which surfaces as a failed resume rather than as
 *   the wrong-store lookup it actually is.
 */
export async function resumeSession(
  storedId: string,
  profile?: string | null,
): Promise<SessionCreateResult> {
  const raw = await hermes.call(
    'session.resume',
    { session_id: storedId, cols: 80, source: 'web', ...(profile ? { profile } : {}) },
    { timeoutMs: CONTROL_TIMEOUT_MS },
  );
  return SessionCreateResultSchema.parse(raw);
}

export async function fetchHistory(sessionId: string): Promise<HistoryMessage[]> {
  const raw = await hermes.call(
    'session.history',
    { session_id: sessionId },
    { timeoutMs: CONTROL_TIMEOUT_MS },
  );
  return SessionHistorySchema.parse(raw).messages;
}

/**
 * The provider/model catalogue behind every model picker.
 *
 * @param refresh re-probe every saved custom provider and bust the model
 *   cache. Off by default, and that default is Hermes' own policy rather than
 *   laziness: a normal open probes only the *current* custom provider, so one
 *   unreachable saved endpoint cannot hang the picker. The cost is that a
 *   non-current custom endpoint is served from the catalogue cached in
 *   `config.yaml`, which goes stale the moment a model is pulled on that box —
 *   observed with an Ollama host that had been serving two `ornith-1.5`
 *   variants for a while and showed neither, while still listing the older
 *   `ornith` builds so the list looked populated rather than empty.
 *
 * That is why refresh is a button and not something this does on open: the
 * hang it avoids is real, and only the person looking at the picker knows
 * whether they are waiting on a box that is switched on.
 */
export async function fetchModelOptions(
  { refresh = false }: { refresh?: boolean } = {},
): Promise<ModelOptions> {
  const raw = await hermes.call(
    'model.options',
    refresh ? { refresh: true } : {},
    {
      // A refresh dials out to every saved custom endpoint in turn, so the
      // 15s meant for metadata calls is not enough — one sleeping Tailscale
      // host would fail the whole probe. Only the refresh path pays this.
      timeoutMs: refresh ? 60_000 : CONTROL_TIMEOUT_MS,
    },
  );
  return ModelOptionsSchema.parse(raw);
}

/**
 * Switch the model. Hermes routes model changes through `config.set`, where
 * the value is the same string the `/model` slash command accepts — so
 * `--session` scopes the change to this chat instead of the global default.
 */
export async function setModel(
  sessionId: string,
  model: string,
  opts: { provider?: string; sessionOnly?: boolean } = {},
): Promise<void> {
  const parts = [model];
  if (opts.provider) parts.push(`--provider`, opts.provider);
  if (opts.sessionOnly !== false) parts.push('--session');
  await hermes.call(
    'config.set',
    { session_id: sessionId, key: 'model', value: parts.join(' ') },
    { timeoutMs: CONTROL_TIMEOUT_MS },
  );
}

export async function setReasoning(sessionId: string, level: string): Promise<void> {
  await hermes.call(
    'config.set',
    { session_id: sessionId, key: 'reasoning', value: level },
    { timeoutMs: CONTROL_TIMEOUT_MS },
  );
}

export async function setApprovalMode(sessionId: string, mode: string): Promise<void> {
  await hermes.call(
    'config.set',
    { session_id: sessionId, key: 'approval_mode', value: mode },
    { timeoutMs: CONTROL_TIMEOUT_MS },
  );
}

export async function compressSession(sessionId: string): Promise<void> {
  await hermes.call('session.compress', { session_id: sessionId });
}

/**
 * Rewind `turns` user turns and get that turn's text back.
 *
 * This is the primitive behind both retry and edit-and-regenerate. Note it
 * dispatches `undo` rather than calling the `session.undo` RPC: the two differ
 * in ways that matter here. `session.undo` only truncates the in-memory
 * history and reports a count, whereas the dispatch path also soft-deletes the
 * rows on disk, reloads the active transcript, notifies memory providers that
 * the session was rewound, and — the part we need — returns the user text it
 * backed up to, so the caller can resubmit or edit it.
 *
 * The backend refuses while a turn is in flight (code 4009); callers must
 * interrupt first.
 */
export async function undoTurns(sessionId: string, turns = 1): Promise<string> {
  const res = await dispatchCommand(sessionId, 'undo', turns > 1 ? String(turns) : '');
  return res.message ?? '';
}

export const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
