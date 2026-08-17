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
