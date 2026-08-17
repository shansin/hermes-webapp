/**
 * Thin typed wrappers over the JSON-RPC methods the UI uses.
 *
 * Kept separate from the store so screens can call the gateway without
 * pulling in streaming state, and so every method name lives in one place.
 */
import { hermes } from '../ws/client';
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

  const raw = await hermes.call('session.create', params);
  return SessionCreateResultSchema.parse(raw);
}

/** Reopen a stored session by its persistent id. */
export async function resumeSession(storedId: string): Promise<SessionCreateResult> {
  const raw = await hermes.call('session.resume', { session_id: storedId, cols: 80, source: 'web' });
  return SessionCreateResultSchema.parse(raw);
}

export async function fetchHistory(sessionId: string): Promise<HistoryMessage[]> {
  const raw = await hermes.call('session.history', { session_id: sessionId });
  return SessionHistorySchema.parse(raw).messages;
}

export async function fetchModelOptions(): Promise<ModelOptions> {
  const raw = await hermes.call('model.options', {});
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
  await hermes.call('config.set', {
    session_id: sessionId,
    key: 'model',
    value: parts.join(' '),
  });
}

export async function setReasoning(sessionId: string, level: string): Promise<void> {
  await hermes.call('config.set', { session_id: sessionId, key: 'reasoning', value: level });
}

export async function setApprovalMode(sessionId: string, mode: string): Promise<void> {
  await hermes.call('config.set', { session_id: sessionId, key: 'approval_mode', value: mode });
}

export async function compressSession(sessionId: string): Promise<void> {
  await hermes.call('session.compress', { session_id: sessionId });
}

export const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
