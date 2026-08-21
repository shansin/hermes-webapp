/**
 * Wire types for the Hermes JSON-RPC gateway.
 *
 * Shapes here were captured from live frames rather than inferred: the gateway
 * has no published schema, so each payload below was observed on the wire.
 * Everything is validated with a permissive zod schema (`.passthrough()` /
 * optional fields) — a Hermes upgrade that adds a field must not break the app,
 * and an unknown event type is surfaced in the dev panel rather than thrown.
 */
import { z } from 'zod';

// --- envelopes ---------------------------------------------------------------

export const RpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

/** Every gateway event arrives as `method: "event"` with a typed params body. */
export const RpcEventSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('event'),
  params: z
    .object({
      type: z.string(),
      session_id: z.string().optional(),
      payload: z.unknown().optional(),
    })
    .passthrough(),
});
export type RpcEvent = z.infer<typeof RpcEventSchema>;

// --- payloads (observed) -----------------------------------------------------

export const UsageSchema = z
  .object({
    model: z.string().optional(),
    input: z.number().optional(),
    output: z.number().optional(),
    reasoning: z.number().optional(),
    total: z.number().optional(),
    calls: z.number().optional(),
    context_used: z.number().optional(),
    context_max: z.number().optional(),
    context_percent: z.number().optional(),
    compressions: z.number().optional(),
    active_subagents: z.number().optional(),
  })
  .passthrough();
export type Usage = z.infer<typeof UsageSchema>;

export const TextDeltaSchema = z.object({ text: z.string() }).passthrough();

/** `tool.start` — args aren't known yet, only a human-readable `context`. */
export const ToolStartSchema = z
  .object({
    tool_id: z.string(),
    name: z.string(),
    context: z.string().optional(),
  })
  .passthrough();

/** `tool.complete` — carries the resolved args plus the tool's return value. */
export const ToolCompleteSchema = z
  .object({
    tool_id: z.string(),
    name: z.string(),
    args: z.record(z.unknown()).optional(),
    duration_s: z.number().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

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
export const SubagentEventSchema = z
  .object({
    goal: z.string().optional(),
    task_count: z.number().optional(),
    task_index: z.number().optional(),
    subagent_id: z.string().optional(),
    parent_id: z.string().optional(),
    child_session_id: z.string().optional(),
    depth: z.number().optional(),
    model: z.string().optional(),
    tool_name: z.string().optional(),
    /** Human-readable preview of what the child is doing right now. */
    text: z.string().optional(),
    status: z.string().optional(),
    summary: z.string().optional(),
    duration_seconds: z.number().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    files_read: z.array(z.string()).optional(),
    files_written: z.array(z.string()).optional(),
  })
  .passthrough();
export type SubagentEvent = z.infer<typeof SubagentEventSchema>;

export const MessageCompleteSchema = z
  .object({
    text: z.string().optional(),
    reasoning: z.string().optional(),
    status: z.string().optional(),
    usage: UsageSchema.optional(),
  })
  .passthrough();

/**
 * `approval.request` — the gateway derives `choices` from the permission flags,
 * so it is present in practice, but we default it defensively: an approval
 * sheet with no buttons would wedge the turn.
 */
export const ApprovalRequestSchema = z
  .object({
    tool: z.string().optional(),
    name: z.string().optional(),
    command: z.string().optional(),
    description: z.string().optional(),
    reason: z.string().optional(),
    risk: z.string().optional(),
    choices: z.array(z.string()).default(['once', 'deny']),
    allow_permanent: z.boolean().optional(),
    smart_denied: z.boolean().optional(),
  })
  .passthrough();
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
export const ClarifyQuestionSchema = z
  .object({
    qid: z.string().optional(),
    question: z.string().default(''),
    // Null, not merely absent, is how the gateway spells an open-ended
    // question — one to be answered with free text rather than a choice.
    choices: z.array(z.string()).nullish(),
    multi_select: z.boolean().optional(),
  })
  .passthrough();

export const ClarifyRequestSchema = z
  .object({
    request_id: z.string(),
    question: z.string().optional(),
    choices: z.array(z.string()).nullish(),
    multi_select: z.boolean().optional(),
    questions: z.array(ClarifyQuestionSchema).optional(),
    /** Answers already locked in, replayed when a reconnect restores a batch. */
    answers: z.record(z.string()).optional(),
  })
  .passthrough();
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

export const SessionInfoSchema = z
  .object({
    model: z.string().optional(),
    provider: z.string().optional(),
    reasoning_effort: z.string().optional(),
    approval_mode: z.string().optional(),
    fast: z.boolean().optional(),
    yolo: z.boolean().optional(),
    tools: z.record(z.array(z.string())).optional(),
    skills: z.record(z.array(z.string())).optional(),
    cwd: z.string().optional(),
  })
  .passthrough();
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const SessionTitleSchema = z
  .object({ session_id: z.string().optional(), title: z.string() })
  .passthrough();

export const StatusUpdateSchema = z
  .object({ kind: z.string().optional(), text: z.string().optional() })
  .passthrough();

// --- session.create / history ------------------------------------------------

export const SessionCreateResultSchema = z
  .object({
    session_id: z.string(),
    stored_session_id: z.string().optional(),
    message_count: z.number().optional(),
    messages: z.array(z.unknown()).optional(),
    info: SessionInfoSchema.optional(),
    /**
     * A question the agent is already parked on. Resuming is the only way back
     * to it: `clarify.request` fired while this client was detached, and the
     * gateway replays the pending prompt here rather than re-emitting it.
     */
    pending_clarify: ClarifyRequestSchema.optional(),
  })
  .passthrough();
export type SessionCreateResult = z.infer<typeof SessionCreateResultSchema>;

/** One entry of `session.history`. `role: "tool"` rows describe a tool call. */
export const HistoryMessageSchema = z
  .object({
    role: z.string(),
    text: z.string().optional(),
    name: z.string().optional(),
    context: z.string().optional(),
    reasoning: z.string().optional(),
    /**
     * The call's resolved arguments. Present on replayed `tool` rows and worth
     * keeping: `context` is only an 80-char preview, so a clarify restored
     * from history would otherwise show a truncated question and no choices.
     */
    args: z.record(z.unknown()).optional(),
    /** What the call returned. Absent from `session.history`; the REST copy has it. */
    result: z.unknown().optional(),
  })
  .passthrough();
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

export const SessionHistorySchema = z
  .object({ count: z.number().optional(), messages: z.array(HistoryMessageSchema) })
  .passthrough();

export const ContextBreakdownSchema = z
  .object({
    categories: z.array(
      z.object({ id: z.string(), label: z.string(), tokens: z.number(), color: z.string().optional() }),
    ),
    context_max: z.number().optional(),
    context_used: z.number().optional(),
    context_percent: z.number().optional(),
    estimated_total: z.number().optional(),
    model: z.string().optional(),
  })
  .passthrough();
export type ContextBreakdown = z.infer<typeof ContextBreakdownSchema>;

export const ModelOptionsSchema = z
  .object({
    providers: z.array(
      z
        .object({
          slug: z.string(),
          name: z.string(),
          is_current: z.boolean().optional(),
          models: z.array(z.string()).default([]),
          total_models: z.number().optional(),
          authenticated: z.boolean().optional(),
          warning: z.string().optional(),
          capabilities: z
            .record(z.object({ fast: z.boolean().optional(), reasoning: z.boolean().optional() }))
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type ModelOptions = z.infer<typeof ModelOptionsSchema>;

/** Connection lifecycle as the UI cares about it. */
export type ConnState = 'connecting' | 'open' | 'closed' | 'reconnecting';
