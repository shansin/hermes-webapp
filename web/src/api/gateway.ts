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
export async function resumeSession(storedId: string): Promise<SessionCreateResult> {
  const raw = await hermes.call(
    'session.resume',
    { session_id: storedId, cols: 80, source: 'web' },
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

export async function fetchModelOptions(): Promise<ModelOptions> {
  const raw = await hermes.call('model.options', {}, { timeoutMs: CONTROL_TIMEOUT_MS });
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
