/**
 * Wire types for the Hermes JSON-RPC gateway.
 *
 * Shapes here were captured from live frames rather than inferred: the gateway
 * has no published schema, so each payload below was observed on the wire.
 * Everything is validated with a permissive zod schema (`z.looseObject` /
 * optional fields) — a Hermes upgrade that adds a field must not break the app,
 * and an unknown event type is surfaced in the dev panel rather than thrown.
 */
/**
 * A note on zod's weight, from the bundle audit.
 *
 * zod sits in the **entry** chunk and has to: these schemas validate gateway
 * frames, the socket opens in `App.tsx` on mount, and the first frame can
 * arrive before a dynamic import would resolve — so a lazy boundary would mean
 * dropping frames or hand-writing a second validator for the boot window.
 *
 * What it could do is weigh less. Classic zod does not tree-shake — every
 * schema carries the whole method-chaining API, and zod 4's adds JSON Schema
 * export — so the move to zod 4 (forced by an advisory) took the eager total
 * from 168.5 to 182.9KB gzipped. Every schema in the app is therefore on
 * `zod/mini`: the same engine and parse semantics behind a functional API the
 * bundler can prune, which took the eager total to 164.3KB.
 *
 * "Every" matters. The two builds share zod's core, and a shared module lands
 * in the entry chunk — so one classic `import { z } from 'zod'`, even on a lazy
 * route, pulls every core schema class (email, JWT, CIDR, …) back into it.
 * `api/moa.ts` did exactly that for 9KB. `main.tsx` sets `jitless` and loads
 * the English issue messages (which classic registered on import) through
 * the same entry, and `test/wireSchemas.test.ts` refuses a classic import.
 *
 * Editing these: `z.looseObject` is what `.passthrough()` was — unknown fields
 * pass through, which is the whole tolerance contract. Wrappers are functions
 * (`z.optional(x)`, `z.nullish(x)`, `z._default(x, v)`); `z.record` takes a key
 * schema; and `_default` returns its value as-is rather than parsing it — use
 * `z.prefault` where the default must pass through the schema (see
 * `MoaPresetSchema.aggregator` in `api/moa.ts`).
 */
import * as z from 'zod/mini';

// --- envelopes ---------------------------------------------------------------

export const RpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  result: z.optional(z.unknown()),
  error: z.optional(
    z.object({ code: z.number(), message: z.string(), data: z.optional(z.unknown()) }),
  ),
});
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

/** Every gateway event arrives as `method: "event"` with a typed params body. */
export const RpcEventSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('event'),
  params: z.looseObject({
    type: z.string(),
    session_id: z.optional(z.string()),
    payload: z.optional(z.unknown()),
  }),
});
export type RpcEvent = z.infer<typeof RpcEventSchema>;

// --- payloads (observed) -----------------------------------------------------

export const UsageSchema = z.looseObject({
  model: z.optional(z.string()),
  input: z.optional(z.number()),
  output: z.optional(z.number()),
  reasoning: z.optional(z.number()),
  total: z.optional(z.number()),
  calls: z.optional(z.number()),
  context_used: z.optional(z.number()),
  context_max: z.optional(z.number()),
  context_percent: z.optional(z.number()),
  compressions: z.optional(z.number()),
  active_subagents: z.optional(z.number()),
});
export type Usage = z.infer<typeof UsageSchema>;

export const TextDeltaSchema = z.looseObject({ text: z.string() });

/** `tool.start` — args aren't known yet, only a human-readable `context`. */
export const ToolStartSchema = z.looseObject({
  tool_id: z.string(),
  name: z.string(),
  context: z.optional(z.string()),
});

/** `tool.complete` — carries the resolved args plus the tool's return value. */
export const ToolCompleteSchema = z.looseObject({
  tool_id: z.string(),
  name: z.string(),
  args: z.optional(z.record(z.string(), z.unknown())),
  duration_s: z.optional(z.number()),
  result: z.optional(z.unknown()),
});

/**
 * `subagent.*` — a delegated child agent's activity, relayed onto the *parent*
 * session. Four types reach us: `start`, `tool`, `thinking` and `complete`.
 *
 * `subagent.text` deliberately never arrives here — the gateway skips the
 * parent emit for the child's reply tokens, since the parent shows a child as a
 * spawn card rather than inlining its whole reply. Don't add a handler for it.
 *
 * Every identity field is optional: older emitters omit them, and the gateway's
 * own comment says clients should fall back to flat rendering when they do.
 */
export const SubagentEventSchema = z.looseObject({
  goal: z.optional(z.string()),
  task_count: z.optional(z.number()),
  task_index: z.optional(z.number()),
  subagent_id: z.optional(z.string()),
  parent_id: z.optional(z.string()),
  child_session_id: z.optional(z.string()),
  depth: z.optional(z.number()),
  model: z.optional(z.string()),
  tool_name: z.optional(z.string()),
  /** Human-readable preview of what the child is doing right now. */
  text: z.optional(z.string()),
  status: z.optional(z.string()),
  summary: z.optional(z.string()),
  duration_seconds: z.optional(z.number()),
  input_tokens: z.optional(z.number()),
  output_tokens: z.optional(z.number()),
  files_read: z.optional(z.array(z.string())),
  files_written: z.optional(z.array(z.string())),
});
export type SubagentEvent = z.infer<typeof SubagentEventSchema>;

export const MessageCompleteSchema = z.looseObject({
  text: z.optional(z.string()),
  reasoning: z.optional(z.string()),
  status: z.optional(z.string()),
  usage: z.optional(UsageSchema),
});

/**
 * `approval.request` — the gateway derives `choices` from the permission flags,
 * so it is present in practice, but we default it defensively: an approval
 * sheet with no buttons would wedge the turn.
 */
export const ApprovalRequestSchema = z.looseObject({
  tool: z.optional(z.string()),
  name: z.optional(z.string()),
  command: z.optional(z.string()),
  description: z.optional(z.string()),
  reason: z.optional(z.string()),
  risk: z.optional(z.string()),
  choices: z._default(z.array(z.string()), ['once', 'deny']),
  allow_permanent: z.optional(z.boolean()),
  smart_denied: z.optional(z.boolean()),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/**
 * `clarify.request` — the agent asking the user a question and parking its
 * turn on the answer.
 *
 * Not an approval, though it blocks just as hard: no tool is waiting to run,
 * there is no allow/deny axis, and the choices are whatever the agent wrote.
 * Before this was handled the event fell through the `applyEvent` switch and
 * was dropped, which is what an ignored-by-default protocol costs when the
 * event happens to be the one that needs an answer — the transcript showed a
 * tool card pulsing "running" until the gateway's hour-long timeout expired.
 *
 * Two shapes on the wire. One question inline, or a `questions` batch that the
 * gateway completes only once every `qid` has been answered. `normalizeClarify`
 * folds them into one list so nothing downstream has to know which arrived.
 */
export const ClarifyQuestionSchema = z.looseObject({
  qid: z.optional(z.string()),
  question: z._default(z.string(), ''),
  // Null, not merely absent, is how the gateway spells an open-ended
  // question — one to be answered with free text rather than a choice.
  choices: z.nullish(z.array(z.string())),
  multi_select: z.optional(z.boolean()),
});

export const ClarifyRequestSchema = z.looseObject({
  request_id: z.string(),
  question: z.optional(z.string()),
  choices: z.nullish(z.array(z.string())),
  multi_select: z.optional(z.boolean()),
  questions: z.optional(z.array(ClarifyQuestionSchema)),
  /** Answers already locked in, replayed when a reconnect restores a batch. */
  answers: z.optional(z.record(z.string(), z.string())),
});
export type ClarifyRequest = z.infer<typeof ClarifyRequestSchema>;

export interface ClarifyQuestion {
  /** Present only in a batch; a single question is answered without one. */
  qid?: string;
  question: string;
  choices: string[];
  multiSelect: boolean;
}

export interface ClarifyPrompt {
  requestId: string;
  questions: ClarifyQuestion[];
  answered: Record<string, string>;
}

/** Fold either wire shape into the one the sheet renders. */
export function normalizeClarify(data: ClarifyRequest): ClarifyPrompt {
  const raw = data.questions?.length
    ? data.questions
    : [{ question: data.question ?? '', choices: data.choices, multi_select: data.multi_select }];

  return {
    requestId: data.request_id,
    questions: raw.map((q) => ({
      qid: q.qid,
      question: q.question ?? '',
      choices: q.choices ?? [],
      // `multi_select` is meaningless without choices, and the gateway only
      // sends it when true — an older one omits the field entirely.
      multiSelect: Boolean(q.multi_select) && Boolean(q.choices?.length),
    })),
    answered: data.answers ?? {},
  };
}

export const SessionInfoSchema = z.looseObject({
  model: z.optional(z.string()),
  provider: z.optional(z.string()),
  reasoning_effort: z.optional(z.string()),
  approval_mode: z.optional(z.string()),
  fast: z.optional(z.boolean()),
  yolo: z.optional(z.boolean()),
  tools: z.optional(z.record(z.string(), z.array(z.string()))),
  skills: z.optional(z.record(z.string(), z.array(z.string()))),
  cwd: z.optional(z.string()),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const SessionTitleSchema = z.looseObject({
  session_id: z.optional(z.string()),
  title: z.string(),
});

export const StatusUpdateSchema = z.looseObject({
  kind: z.optional(z.string()),
  text: z.optional(z.string()),
});

// --- session.create / history ------------------------------------------------

/**
 * The turn a resumed session is in the middle of.
 *
 * `assistant` is the reply accumulated so far, not a replay: the gateway does
 * not re-emit the deltas already sent, so this is the only way to recover the
 * text a turn produced while nobody was listening. `corrections` are mid-turn
 * redirects — extra user messages sent into the same turn — carried alongside
 * the original prompt rather than over it.
 */
export const InflightTurnSchema = z.looseObject({
  user: z._default(z.string(), ''),
  assistant: z._default(z.string(), ''),
  streaming: z.optional(z.boolean()),
  corrections: z.optional(z.array(z.string())),
  /** A retained failed turn: present only once the turn has stopped. */
  error: z.optional(z.string()),
  status: z.optional(z.string()),
});
export type InflightTurn = z.infer<typeof InflightTurnSchema>;

export const SessionCreateResultSchema = z.looseObject({
  session_id: z.string(),
  stored_session_id: z.optional(z.string()),
  message_count: z.optional(z.number()),
  messages: z.optional(z.array(z.unknown())),
  info: z.optional(SessionInfoSchema),
  /**
   * A question the agent is already parked on. Resuming is the only way back
   * to it: `clarify.request` fired while this client was detached, and the
   * gateway replays the pending prompt here rather than re-emitting it.
   */
  pending_clarify: z.optional(ClarifyRequestSchema),
  /**
   * The live-turn projection, and the reason it is read at all.
   *
   * `running` is the gateway's own answer to "is a turn in flight right
   * now", and nothing else can supply it after a cold start: `message.start`
   * fired at a client that no longer exists, so a reopened app saw deltas
   * arriving into a store that believed the session was idle. That showed as
   * a missing stop button and a missing working indicator, and — worse —
   * `submitPrompt` sending the next message straight at a busy session,
   * where the gateway rejects it (4009) and the bubble is stamped failed.
   *
   * `inflight` carries the half of that turn no transcript has yet: the
   * agent flushes to SQLite at turn end, so the prompt being answered and
   * the reply so far exist only here until it completes.
   */
  running: z.optional(z.boolean()),
  status: z.optional(z.string()),
  inflight: z.nullish(InflightTurnSchema),
  /** A prompt the gateway accepted for the next turn, held while busy. */
  queued: z.nullish(z.looseObject({ user: z._default(z.string(), '') })),
  /** Raised while we were detached; the turn is still blocked on it. */
  pending_approval: z.optional(ApprovalRequestSchema),
});
export type SessionCreateResult = z.infer<typeof SessionCreateResultSchema>;

/** One entry of `session.history`. `role: "tool"` rows describe a tool call. */
export const HistoryMessageSchema = z.looseObject({
  role: z.string(),
  text: z.optional(z.string()),
  name: z.optional(z.string()),
  context: z.optional(z.string()),
  reasoning: z.optional(z.string()),
  /**
   * The call's resolved arguments. Present on replayed `tool` rows and worth
   * keeping: `context` is only an 80-char preview, so a clarify restored
   * from history would otherwise show a truncated question and no choices.
   */
  args: z.optional(z.record(z.string(), z.unknown())),
  /** What the call returned. Absent from `session.history`; the REST copy has it. */
  result: z.optional(z.unknown()),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

export const SessionHistorySchema = z.looseObject({
  count: z.optional(z.number()),
  messages: z.array(HistoryMessageSchema),
});

export const ContextBreakdownSchema = z.looseObject({
  categories: z.array(
    z.object({ id: z.string(), label: z.string(), tokens: z.number(), color: z.optional(z.string()) }),
  ),
  context_max: z.optional(z.number()),
  context_used: z.optional(z.number()),
  context_percent: z.optional(z.number()),
  estimated_total: z.optional(z.number()),
  model: z.optional(z.string()),
});
export type ContextBreakdown = z.infer<typeof ContextBreakdownSchema>;

export const ModelOptionsSchema = z.looseObject({
  providers: z.array(
    z.looseObject({
      slug: z.string(),
      name: z.string(),
      is_current: z.optional(z.boolean()),
      models: z._default(z.array(z.string()), []),
      total_models: z.optional(z.number()),
      authenticated: z.optional(z.boolean()),
      warning: z.optional(z.string()),
      capabilities: z.optional(
        z.record(
          z.string(),
          z.object({ fast: z.optional(z.boolean()), reasoning: z.optional(z.boolean()) }),
        ),
      ),
    }),
  ),
});
export type ModelOptions = z.infer<typeof ModelOptionsSchema>;

/** Connection lifecycle as the UI cares about it. */
export type ConnState = 'connecting' | 'open' | 'closed' | 'reconnecting';
