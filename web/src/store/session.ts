/**
 * Chat/session state driven by gateway events.
 *
 * The gateway streams a turn as: `message.start` → many `reasoning.delta` /
 * `message.delta` → `tool.start` / `tool.complete` → `message.complete`.
 * This store folds that into a stable message list the UI can render.
 *
 * Design notes:
 *  - Deltas are accumulated into `streamingText` rather than into the message
 *    array, so a token arriving 30×/second doesn't rewrite the whole list.
 *  - Tool calls are their own message kind, interleaved in arrival order, which
 *    is what makes the transcript read correctly.
 *  - `reasoning.delta` carries the model's chain of thought; `thinking.delta`
 *    is only a decorative "pondering…" placeholder and is shown as a status,
 *    never as content.
 */
import { create } from 'zustand';
import {
  ApprovalRequestSchema,
  ContextBreakdownSchema,
  MessageCompleteSchema,
  SessionInfoSchema,
  SessionTitleSchema,
  StatusUpdateSchema,
  TextDeltaSchema,
  ToolCompleteSchema,
  ToolStartSchema,
  UsageSchema,
  type ApprovalRequest,
  type ContextBreakdown,
  type HistoryMessage,
  type SessionInfo,
  type Usage,
} from '../ws/types';
import { hermes } from '../ws/client';
import { buzz } from '../lib/haptics';

export type ChatMessage =
  | { kind: 'user'; id: string; text: string; at: number }
  | {
      kind: 'assistant';
      id: string;
      text: string;
      reasoning?: string;
      at: number;
      usage?: Usage;
      interrupted?: boolean;
    }
  | {
      kind: 'tool';
      id: string;
      toolId: string;
      name: string;
      context?: string;
      args?: Record<string, unknown>;
      result?: unknown;
      durationS?: number;
      status: 'running' | 'done';
      at: number;
    };

interface SessionState {
  /** Gateway session handle (8-hex), distinct from the stored session id. */
  sessionId: string | null;
  /** Persistent id used by the REST session endpoints. */
  storedSessionId: string | null;
  title: string;
  info: SessionInfo | null;
  messages: ChatMessage[];

  running: boolean;
  streamingText: string;
  streamingReasoning: string;
  /** Decorative placeholder from `thinking.delta`, e.g. "pondering…". */
  thinkingHint: string;
  statusLine: string;

  usage: Usage | null;
  contextBreakdown: ContextBreakdown | null;
  approval: (ApprovalRequest & { id: number }) | null;
  error: string | null;

  // --- actions
  reset: () => void;
  adoptSession: (r: { sessionId: string; storedSessionId?: string; info?: SessionInfo }) => void;
  loadHistory: (messages: HistoryMessage[]) => void;
  applyEvent: (params: { type: string; session_id?: string; payload?: unknown }) => void;
  submitPrompt: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  respondApproval: (choice: string, all?: boolean) => Promise<void>;
  refreshUsage: () => Promise<void>;
  setTitle: (t: string) => void;
}

let seq = 0;
const nextId = () => `m${++seq}`;

/** Approval sheets are keyed so a stale sheet can't answer a newer request. */
let approvalSeq = 0;

export const useSession = create<SessionState>((set, get) => ({
  sessionId: null,
  storedSessionId: null,
  title: '',
  info: null,
  messages: [],
  running: false,
  streamingText: '',
  streamingReasoning: '',
  thinkingHint: '',
  statusLine: '',
  usage: null,
  contextBreakdown: null,
  approval: null,
  error: null,

  reset: () =>
    set({
      sessionId: null,
      storedSessionId: null,
      title: '',
      info: null,
      messages: [],
      running: false,
      streamingText: '',
      streamingReasoning: '',
      thinkingHint: '',
      statusLine: '',
      usage: null,
      contextBreakdown: null,
      approval: null,
      error: null,
    }),

  adoptSession: ({ sessionId, storedSessionId, info }) =>
    set({
      sessionId,
      storedSessionId: storedSessionId ?? null,
      info: info ?? null,
      error: null,
    }),

  loadHistory: (messages) => {
    const out: ChatMessage[] = [];
    for (const m of messages) {
      const at = Date.now();
      if (m.role === 'user') {
        out.push({ kind: 'user', id: nextId(), text: m.text ?? '', at });
      } else if (m.role === 'assistant') {
        out.push({
          kind: 'assistant',
          id: nextId(),
          text: m.text ?? '',
          reasoning: m.reasoning,
          at,
        });
      } else if (m.role === 'tool') {
        // Replayed history has no tool_id and no result — only what was called.
        out.push({
          kind: 'tool',
          id: nextId(),
          toolId: `hist-${seq}`,
          name: m.name ?? 'tool',
          context: m.context,
          status: 'done',
          at,
        });
      }
    }
    set({ messages: out });
  },

  applyEvent: ({ type, payload }) => {
    const s = get();

    switch (type) {
      case 'message.start':
        set({
          running: true,
          streamingText: '',
          streamingReasoning: '',
          thinkingHint: '',
          statusLine: '',
        });
        return;

      case 'message.delta': {
        const p = TextDeltaSchema.safeParse(payload);
        if (p.success) set({ streamingText: s.streamingText + p.data.text, thinkingHint: '' });
        return;
      }

      case 'reasoning.delta': {
        const p = TextDeltaSchema.safeParse(payload);
        if (p.success) set({ streamingReasoning: s.streamingReasoning + p.data.text });
        return;
      }

      case 'thinking.delta': {
        // Decorative only — never appended to the transcript.
        const p = TextDeltaSchema.safeParse(payload);
        if (p.success) set({ thinkingHint: p.data.text });
        return;
      }

      case 'tool.generating': {
        const name = (payload as { name?: string } | null)?.name;
        set({ statusLine: name ? `Preparing ${name}…` : 'Preparing tool…' });
        return;
      }

      case 'tool.start': {
        const p = ToolStartSchema.safeParse(payload);
        if (!p.success) return;
        buzz('tool');
        set({
          statusLine: '',
          messages: [
            ...s.messages,
            {
              kind: 'tool',
              id: nextId(),
              toolId: p.data.tool_id,
              name: p.data.name,
              context: p.data.context,
              status: 'running',
              at: Date.now(),
            },
          ],
        });
        return;
      }

      case 'tool.complete': {
        const p = ToolCompleteSchema.safeParse(payload);
        if (!p.success) return;
        set({
          messages: s.messages.map((m) =>
            m.kind === 'tool' && m.toolId === p.data.tool_id
              ? {
                  ...m,
                  status: 'done' as const,
                  args: p.data.args,
                  result: p.data.result,
                  durationS: p.data.duration_s,
                }
              : m,
          ),
        });
        return;
      }

      case 'message.complete': {
        const p = MessageCompleteSchema.safeParse(payload);
        const text = p.success ? (p.data.text ?? s.streamingText) : s.streamingText;
        const reasoning = p.success ? p.data.reasoning : s.streamingReasoning;
        const usage = p.success ? p.data.usage : undefined;
        const interrupted = p.success && p.data.status === 'interrupted';

        buzz('done');
        set({
          running: false,
          streamingText: '',
          streamingReasoning: '',
          thinkingHint: '',
          statusLine: '',
          usage: usage ?? s.usage,
          messages: [
            ...s.messages,
            {
              kind: 'assistant',
              id: nextId(),
              text,
              reasoning: reasoning || undefined,
              usage,
              interrupted,
              at: Date.now(),
            },
          ],
        });
        return;
      }

      case 'approval.request': {
        const p = ApprovalRequestSchema.safeParse(payload);
        if (!p.success) return;
        buzz('approval');
        set({ approval: { ...p.data, id: ++approvalSeq } });
        return;
      }

      case 'session.info': {
        const p = SessionInfoSchema.safeParse(payload);
        if (p.success) set({ info: p.data });
        return;
      }

      case 'session.title': {
        const p = SessionTitleSchema.safeParse(payload);
        if (p.success) {
          set({
            title: p.data.title,
            storedSessionId: p.data.session_id ?? s.storedSessionId,
          });
        }
        return;
      }

      case 'session.usage': {
        const p = UsageSchema.safeParse(payload);
        if (p.success) set({ usage: p.data });
        return;
      }

      case 'status.update': {
        const p = StatusUpdateSchema.safeParse(payload);
        if (p.success) set({ statusLine: p.data.text ?? '' });
        return;
      }

      case 'control.error': {
        const msg = (payload as { message?: string } | null)?.message;
        set({ error: msg ?? 'Gateway error', running: false });
        return;
      }

      default:
        return;
    }
  },

  submitPrompt: async (text) => {
    const { sessionId } = get();
    if (!sessionId || !text.trim()) return;

    set((st) => ({
      messages: [...st.messages, { kind: 'user', id: nextId(), text, at: Date.now() }],
      running: true,
      error: null,
      streamingText: '',
      streamingReasoning: '',
    }));

    try {
      await hermes.call('prompt.submit', { session_id: sessionId, text });
    } catch (err) {
      set({ running: false, error: err instanceof Error ? err.message : 'submit failed' });
    }
  },

  interrupt: async () => {
    const { sessionId } = get();
    if (!sessionId) return;
    try {
      await hermes.call('session.interrupt', { session_id: sessionId });
      buzz('warn');
    } catch {
      // A turn that already finished rejects here; nothing to surface.
    }
  },

  respondApproval: async (choice, all = false) => {
    const { sessionId, approval } = get();
    if (!sessionId || !approval) return;
    set({ approval: null });
    try {
      await hermes.call('approval.respond', { session_id: sessionId, choice, all });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'approval failed' });
    }
  },

  refreshUsage: async () => {
    const { sessionId } = get();
    if (!sessionId) return;
    try {
      const [usage, breakdown] = await Promise.all([
        hermes.call('session.usage', { session_id: sessionId }),
        hermes.call('session.context_breakdown', { session_id: sessionId }).catch(() => null),
      ]);
      const u = UsageSchema.safeParse(usage);
      const b = breakdown ? ContextBreakdownSchema.safeParse(breakdown) : null;
      set({
        usage: u.success ? u.data : get().usage,
        contextBreakdown: b?.success ? b.data : get().contextBreakdown,
      });
    } catch {
      // Usage is decorative; a failure must not disturb the chat.
    }
  },

  setTitle: (t) => set({ title: t }),
}));
