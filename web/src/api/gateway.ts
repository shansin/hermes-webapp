/**
 * Thin typed wrappers over the JSON-RPC methods the UI uses.
 *
 * Kept separate from the store so screens can call the gateway without
 * pulling in streaming state, and so every method name lives in one place.
 */
import { hermes, CONTROL_TIMEOUT_MS, RpcError } from '../ws/client';
import { api } from './client';
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

/**
 * Call a method with parameters only newer Hermes knows, falling back without
 * them on a backend that does not.
 *
 * The gateway validates params with `extra="forbid"`: an unknown key answers
 * 4000 ("invalid params for <method>: <key>: Extra inputs are not permitted")
 * rather than being ignored. So a parameter added for a newer backend, sent
 * unconditionally, turns into a method that fails outright on an older one —
 * every resume, or every new chat. A key refused once is remembered for the
 * page's lifetime, so an old backend costs one wasted round trip, not one per
 * call.
 */
const refusedParams = new Set<string>();

async function callTolerant(
  method: string,
  params: Record<string, unknown>,
  optional: Record<string, unknown>,
): Promise<unknown> {
  const extra = Object.fromEntries(
    Object.entries(optional).filter(([key]) => !refusedParams.has(`${method}:${key}`)),
  );
  try {
    return await hermes.call(method, { ...params, ...extra }, { timeoutMs: CONTROL_TIMEOUT_MS });
  } catch (err) {
    if (!(err instanceof RpcError) || err.code !== 4000) throw err;
    const refused = Object.keys(extra).filter((key) => err.message.includes(`: ${key}:`));
    if (!refused.length) throw err;
    for (const key of refused) refusedParams.add(`${method}:${key}`);
    return callTolerant(method, params, optional);
  }
}

/**
 * The idempotency key of a create that has not been confirmed yet.
 *
 * A create whose *response* is lost — the radio drops after the gateway built
 * the session — used to mean a second tap made a second session, and the first
 * sat in the list as an empty conversation. Newer Hermes takes a caller-chosen
 * `idempotency_key` and answers a repeat with the session the first call made,
 * so the key is kept until a create is answered either way and reused by the
 * next attempt in the meantime. Bounded in time: a create retried minutes
 * later is a new intent, not a retry.
 */
let pendingCreate: { key: string; at: number } | null = null;
const CREATE_RETRY_WINDOW_MS = 2 * 60_000;

function newKey(): string {
  // `randomUUID` needs a secure context, and plain-HTTP LAN is a supported way in.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join('');
}

export async function createSession(opts: CreateOptions = {}): Promise<SessionCreateResult> {
  const params: Record<string, unknown> = { cols: 80, source: 'web' };
  if (opts.model) params.model = opts.model;
  if (opts.provider) params.provider = opts.provider;
  if (opts.reasoningEffort) params.reasoning_effort = opts.reasoningEffort;
  if (opts.cwd) params.cwd = opts.cwd;
  if (opts.title) params.title = opts.title;

  if (!pendingCreate || Date.now() - pendingCreate.at > CREATE_RETRY_WINDOW_MS) {
    pendingCreate = { key: newKey(), at: Date.now() };
  }
  try {
    const raw = await callTolerant('session.create', params, { idempotency_key: pendingCreate.key });
    pendingCreate = null;
    return SessionCreateResultSchema.parse(raw);
  } catch (err) {
    // The gateway answered, so nothing was made under this key that a retry
    // could find. Only a call that got no answer leaves it pending.
    if (err instanceof RpcError) pendingCreate = null;
    throw err;
  }
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
  /**
   * `inline_images: false` makes an image part in the history come back as
   * `[image]` instead of its whole data URI — which this app could never draw
   * anyway (the markdown sanitiser blanks `data:` URLs), so it was megabytes
   * over a phone's radio to render nothing. Pictures the composer sends travel
   * as `@image:` path refs and are untouched by it.
   */
  const raw = await callTolerant(
    'session.resume',
    { session_id: storedId, cols: 80, source: 'web', ...(profile ? { profile } : {}) },
    { inline_images: false },
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
  { refresh = false, profile = null }: { refresh?: boolean; profile?: string | null } = {},
): Promise<ModelOptions> {
  // A refresh dials out to every saved custom endpoint in turn, so the 15s
  // meant for metadata calls is not enough — one sleeping Tailscale host would
  // fail the whole probe. Only the refresh path pays this.
  const timeoutMs = refresh ? 60_000 : CONTROL_TIMEOUT_MS;

  /**
   * Naming a profile changes the transport, and it has to.
   *
   * The gateway's `model.options` takes `session_id`, `explicit_only`,
   * `include_unconfigured` and `refresh` — no profile. The socket answers for
   * the profile the gateway is running as, full stop. But the catalogue is
   * genuinely per-profile: `custom_providers` is profile config, so two
   * profiles can have different endpoints saved and therefore different models
   * to offer. Asking the socket for another profile's list would quietly hand
   * back this one's, which is worse than not offering the choice at all — the
   * picker would look right and name models that profile cannot reach.
   *
   * The REST route does take `?profile=`, so that is the one used whenever a
   * profile is named. The socket stays the default path for the unscoped case,
   * where it is one already-open connection instead of a new request.
   */
  if (profile) {
    const qs = new URLSearchParams({ profile });
    if (refresh) qs.set('refresh', 'true');
    const raw = await api.get<unknown>(`/api/model/options?${qs.toString()}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return ModelOptionsSchema.parse(raw);
  }

  const raw = await hermes.call('model.options', refresh ? { refresh: true } : {}, { timeoutMs });
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

export async function compressSession(sessionId: string, focusTopic?: string): Promise<void> {
  await hermes.call(
    'session.compress',
    focusTopic ? { session_id: sessionId, focus_topic: focusTopic } : { session_id: sessionId },
  );
}

/** Persist the transcript to a file; returns the gateway's confirmation text. */
export async function saveSession(sessionId: string): Promise<string> {
  const raw = (await hermes.call('session.save', { session_id: sessionId })) as Record<
    string,
    unknown
  > | null;
  const path =
    (typeof raw?.path === 'string' && raw.path) ||
    (typeof raw?.file === 'string' && raw.file) ||
    '';
  return path ? `Saved to ${path}` : 'Session saved.';
}

/** Rename via the dedicated RPC (preferred over slash.exec: structured reply). */
export async function titleSession(sessionId: string, title?: string): Promise<string> {
  const raw = (await hermes.call(
    'session.title',
    title ? { session_id: sessionId, title } : { session_id: sessionId },
    { timeoutMs: CONTROL_TIMEOUT_MS },
  )) as Record<string, unknown> | null;
  const next = typeof raw?.title === 'string' && raw.title ? raw.title : (title ?? '');
  return next ? `Session titled “${next}”.` : 'Session renamed.';
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

/**
 * Ask a side question about the live conversation (`prompt.btw`).
 *
 * Answered by a detached agent over a snapshot of the transcript, so it does
 * not join the history, does not wait for a running turn, and does not
 * disturb the prompt cache. The answer arrives later as `btw.complete` on
 * this session; the call itself only says it was accepted.
 */
export async function askSideQuestion(sessionId: string, text: string): Promise<void> {
  await hermes.call('prompt.btw', { session_id: sessionId, text }, { timeoutMs: CONTROL_TIMEOUT_MS });
}
