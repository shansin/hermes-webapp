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
  SubagentEventSchema,
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
import { undoTurns } from '../api/gateway';
import { buzz } from '../lib/haptics';

/**
 * When a message happened, or null when that isn't known.
 *
 * Replayed history carries no timestamps — `session.history` projects role and
 * text only — so restored messages get null rather than the moment the app
 * loaded them, which would be a plausible-looking lie on every line.
 */
export type MessageTime = number | null;

export type ChatMessage =
  /**
   * `displayText` exists for skill/bundle commands: `command.dispatch` hands
   * back an expanded, model-facing prompt, but the transcript must keep
   * showing the short invocation the user actually typed.
   */
  | {
      kind: 'user';
      id: string;
      text: string;
      displayText?: string;
      at: MessageTime;
      /**
       * The submit RPC rejected, so the gateway never saw this turn. The
       * bubble stays in the transcript — losing what someone typed is the
       * worst possible response to a dropped connection — and offers to send
       * it again.
       */
      failed?: boolean;
    }
  /** Local output — slash-command results, and why one wouldn't run. */
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'error'; label?: string; at: MessageTime }
  | {
      kind: 'assistant';
      id: string;
      text: string;
      reasoning?: string;
      at: MessageTime;
      usage?: Usage;
      interrupted?: boolean;
    }
  /**
   * A delegated child agent. One card per spawn, updated in place as its
   * `subagent.*` events arrive — the child's own reply body never reaches the
   * parent, so the card shows progress and a final summary, not a transcript.
   */
  | {
      kind: 'subagent';
      id: string;
      /** Stable key across the spawn's events. */
      agentId: string;
      goal: string;
      model?: string;
      depth?: number;
      /** What it's doing right now, from the latest tool/thinking event. */
      activity?: string;
      summary?: string;
      status: 'running' | 'done';
      durationS?: number;
      tokens?: number;
      filesWritten?: string[];
      at: MessageTime;
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
      at: MessageTime;
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

  /**
   * A message typed while a turn was still running, held until it finishes.
   * Only one is kept: a second send replaces it, which matches what the box
   * shows and avoids silently building a queue nobody can see or edit.
   */
  queued: { text: string; display?: string } | null;
  /** True while a rewind (retry / edit) is in flight. */
  rewinding: boolean;

  // --- actions
  reset: () => void;
  adoptSession: (r: { sessionId: string; storedSessionId?: string; info?: SessionInfo }) => void;
  loadHistory: (messages: HistoryMessage[], opts?: { resync?: boolean }) => void;
  applyEvent: (params: { type: string; session_id?: string; payload?: unknown }) => void;
  submitPrompt: (text: string, opts?: { display?: string }) => Promise<void>;
  addNotice: (text: string, tone?: 'info' | 'error', label?: string) => void;
  clearQueued: () => void;
  retryLast: () => Promise<void>;
  applyResync: (messages: HistoryMessage[]) => void;
  resendFailed: (messageId: string) => Promise<void>;
  editTurn: (messageId: string, newText: string) => Promise<void>;
  interrupt: () => Promise<void>;
  respondApproval: (choice: string, all?: boolean) => Promise<void>;
  refreshUsage: () => Promise<void>;
  setTitle: (t: string) => void;
}

let seq = 0;
const nextId = () => `m${++seq}`;

/** Approval sheets are keyed so a stale sheet can't answer a newer request. */
let approvalSeq = 0;

function lastIndexOf<T>(items: T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return i;
  return -1;
}

type Get = () => SessionState;
type Set = (partial: Partial<SessionState>) => void;

/**
 * Rewind the conversation to the user message at `idx` and run it again.
 *
 * Retry and edit-and-regenerate are the same operation: both drop everything
 * from a user turn onward and resubmit — retry resends what was there, edit
 * substitutes new text. `undoTurns` counts in *user turns*, so the count is how
 * many user messages sit at or after `idx`, not how many entries do.
 *
 * The backend is the source of truth for what got dropped, so the local
 * transcript is only truncated once the rewind has actually succeeded.
 */
async function rewind(get: Get, set: Set, idx: number, replacement?: string): Promise<void> {
  const { sessionId, messages, running, rewinding } = get();
  const target = messages[idx];
  if (!sessionId || rewinding || target?.kind !== 'user') return;
  if (running) {
    set({ error: 'Stop the current turn before editing or retrying.' });
    return;
  }

  const turns = messages.slice(idx).filter((m) => m.kind === 'user').length;
  set({ rewinding: true, error: null });
  try {
    const prefill = await undoTurns(sessionId, turns);
    set({ messages: messages.slice(0, idx) });
    const text = replacement ?? (prefill || target.text);
    // A skill command keeps showing its short invocation, not the expansion —
    // but only when resending it unchanged. Edited text is its own message.
    await get().submitPrompt(text, replacement ? undefined : { display: target.displayText });
  } catch (err) {
    set({ error: err instanceof Error ? err.message : 'Could not rewind the conversation' });
  } finally {
    set({ rewinding: false });
  }
}

/** The `text` of a streaming delta, or null when the payload isn't one. */
function deltaText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const t = (payload as { text?: unknown }).text;
  return typeof t === 'string' ? t : null;
}

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
  queued: null,
  rewinding: false,

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
      queued: null,
      rewinding: false,
    }),

  adoptSession: ({ sessionId, storedSessionId, info }) =>
    set({
      sessionId,
      storedSessionId: storedSessionId ?? null,
      info: info ?? null,
      error: null,
    }),

  /**
   * Replace the transcript with the server's copy.
   *
   * `resync` marks the case where this is the *same* conversation being
   * reconciled after a dropped socket, rather than a different one being
   * opened. That distinction is worth carrying: a reconciliation should not
   * throw away what the user can already see — the clock times on messages
   * this session produced, or a message they typed and have not sent yet.
   */
  loadHistory: (messages, opts) => {
    const prior = opts?.resync ? get().messages : [];

    /**
     * The time already known for the message at this position, when the
     * server's copy agrees with what we are showing. History carries no
     * timestamps of its own — see `MessageTime` — so without this a
     * reconnect would strip the clock off every message in the session.
     */
    const priorTime = (i: number, kind: ChatMessage['kind'], text: string): MessageTime => {
      const old = prior[i];
      if (!old || old.kind !== kind) return null;
      if (kind === 'tool') return old.kind === 'tool' && old.name === text ? old.at : null;
      return 'text' in old && old.text === text ? old.at : null;
    };

    const out: ChatMessage[] = [];
    for (const [i, m] of messages.entries()) {
      if (m.role === 'user') {
        const text = m.text ?? '';
        out.push({ kind: 'user', id: nextId(), text, at: priorTime(i, 'user', text) });
      } else if (m.role === 'assistant') {
        const text = m.text ?? '';
        out.push({
          kind: 'assistant',
          id: nextId(),
          text,
          reasoning: m.reasoning,
          at: priorTime(i, 'assistant', text),
        });
      } else if (m.role === 'tool') {
        // Replayed history has no tool_id and no result — only what was called.
        const name = m.name ?? 'tool';
        out.push({
          kind: 'tool',
          id: nextId(),
          toolId: `hist-${seq}`,
          name,
          context: m.context,
          status: 'done',
          at: priorTime(i, 'tool', name),
        });
      }
    }

    set({ messages: out, queued: opts?.resync ? get().queued : null });
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

      // The two delta cases are the only events on a per-token path — 30–60×
      // a second for the length of a turn. `TextDeltaSchema` is a
      // `.passthrough()` object, so validating here allocated a fresh copy of
      // every delta payload; a shape check costs nothing and rejects exactly
      // the same things. The rest of the events stay on zod, where the
      // frequency is low and the payloads are worth checking properly.
      case 'message.delta': {
        const text = deltaText(payload);
        if (text !== null) set({ streamingText: s.streamingText + text, thinkingHint: '' });
        return;
      }

      case 'reasoning.delta': {
        const text = deltaText(payload);
        if (text !== null) set({ streamingReasoning: s.streamingReasoning + text });
        return;
      }

      case 'thinking.delta': {
        // Decorative only — never appended to the transcript, and just as
        // frequent as the deltas above, so it gets the same cheap check.
        const text = deltaText(payload);
        if (text !== null) set({ thinkingHint: text });
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

        // Release a message typed during the turn. An interrupted turn is the
        // one case we hold it back: the user stopped the agent, so firing the
        // next prompt at them immediately is the opposite of what they asked
        // for — it stays in the composer for them to send or discard.
        const { queued } = get();
        if (queued && !interrupted) {
          set({ queued: null });
          void get().submitPrompt(queued.text, { display: queued.display });
        }
        return;
      }

      case 'subagent.start':
      case 'subagent.tool':
      case 'subagent.thinking':
      case 'subagent.complete': {
        const p = SubagentEventSchema.safeParse(payload);
        if (!p.success) return;
        const d = p.data;
        // Identity fields are all optional. Fall back through the ids the
        // gateway might send, then to a single flat card, so an older emitter
        // degrades to one card rather than a new card per event.
        const agentId = d.subagent_id || d.child_session_id || 'subagent';
        const existing = s.messages.find(
          (m) => m.kind === 'subagent' && m.agentId === agentId,
        );

        if (!existing) {
          // A `tool`/`complete` with no preceding `start` still deserves a card.
          buzz('tool');
          set({
            messages: [
              ...s.messages,
              {
                kind: 'subagent',
                id: nextId(),
                agentId,
                goal: d.goal || d.text || 'Delegated task',
                model: d.model,
                depth: d.depth,
                activity: type === 'subagent.complete' ? undefined : (d.tool_name ?? d.text),
                summary: d.summary,
                status: type === 'subagent.complete' ? 'done' : 'running',
                durationS: d.duration_seconds,
                tokens:
                  d.input_tokens != null || d.output_tokens != null
                    ? (d.input_tokens ?? 0) + (d.output_tokens ?? 0)
                    : undefined,
                filesWritten: d.files_written,
                at: Date.now(),
              },
            ],
          });
          return;
        }

        set({
          messages: s.messages.map((m) => {
            if (m.kind !== 'subagent' || m.agentId !== agentId) return m;
            if (type === 'subagent.complete') {
              return {
                ...m,
                status: 'done' as const,
                activity: undefined,
                summary: d.summary || d.text || m.summary,
                durationS: d.duration_seconds ?? m.durationS,
                tokens:
                  d.input_tokens != null || d.output_tokens != null
                    ? (d.input_tokens ?? 0) + (d.output_tokens ?? 0)
                    : m.tokens,
                filesWritten: d.files_written ?? m.filesWritten,
              };
            }
            return {
              ...m,
              goal: d.goal || m.goal,
              model: d.model ?? m.model,
              activity: d.tool_name ?? d.text ?? m.activity,
            };
          }),
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

  submitPrompt: async (text, opts) => {
    const { sessionId, running } = get();
    if (!sessionId || !text.trim()) return;

    // The gateway runs one turn per session, so a message sent mid-turn would
    // be rejected. Hold it instead and send it when the turn completes.
    if (running) {
      buzz('tap');
      set({ queued: { text, display: opts?.display } });
      return;
    }

    // Held so the catch below can mark this exact bubble rather than guessing
    // at the last user message, which a queued send could have moved on from.
    const id = nextId();
    set((st) => ({
      messages: [
        ...st.messages,
        { kind: 'user', id, text, displayText: opts?.display, at: Date.now() },
      ],
      running: true,
      error: null,
      streamingText: '',
      streamingReasoning: '',
    }));

    try {
      await hermes.call('prompt.submit', { session_id: sessionId, text });
    } catch (err) {
      set((st) => ({
        running: false,
        error: err instanceof Error ? err.message : 'submit failed',
        messages: st.messages.map((m) =>
          m.id === id && m.kind === 'user' ? { ...m, failed: true } : m,
        ),
      }));
    }
  },

  addNotice: (text, tone = 'info', label) =>
    set((st) => ({
      messages: [...st.messages, { kind: 'notice', id: nextId(), text, tone, label, at: Date.now() }],
    })),

  clearQueued: () => set({ queued: null }),

  retryLast: async () => {
    const { messages } = get();
    const idx = lastIndexOf(messages, (m) => m.kind === 'user');
    if (idx < 0) return;
    await rewind(get, set, idx, undefined);
  },

  /**
   * Send a message whose submit rejected.
   *
   * Deliberately not a `rewind`: that asks the gateway to undo turns, and a
   * failed submit means the gateway never recorded one. The bubble is simply
   * dropped and resubmitted, so there is nothing on the server to unwind.
   */
  resendFailed: async (messageId) => {
    const { messages, running } = get();
    const target = messages.find((m) => m.id === messageId);
    if (!target || target.kind !== 'user' || !target.failed || running) return;
    set({
      messages: messages.filter((m) => m.id !== messageId),
      error: null,
    });
    await get().submitPrompt(target.text, { display: target.displayText });
  },

  editTurn: async (messageId, newText) => {
    const { messages } = get();
    const idx = messages.findIndex((m) => m.id === messageId && m.kind === 'user');
    if (idx < 0 || !newText.trim()) return;
    await rewind(get, set, idx, newText);
  },

  /**
   * Reconcile with the server after the socket came back.
   *
   * A turn interrupted by a dropped connection leaves a half-written bubble
   * and `running` stuck true — the `message.complete` that would have ended it
   * was emitted while nothing was listening. The server's history is the only
   * thing that knows how the turn actually ended, so it wins.
   *
   * The streaming buffers are cleared rather than kept: whatever they hold is
   * either already in the history we just loaded, or belongs to a turn still
   * being written, which will stream in again from wherever it has got to.
   */
  applyResync: (messages) => {
    const current = get().messages;

    // The server's copy can legitimately be *behind* ours. A prompt submitted
    // just as the socket dropped exists as a bubble here but was never
    // recorded there, and adopting a shorter history would wipe it off the
    // screen — losing what someone typed to fix a display glitch.
    if (messages.length < current.length) {
      set({ error: null });
      return;
    }

    /**
     * Whether the conversation actually moved on while we were away. A turn
     * that finished in the gap shows up here as an extra message; one still
     * being written does not, because the reply only joins the transcript when
     * it completes.
     */
    const advanced = messages.length > current.length;

    get().loadHistory(messages, { resync: true });

    // Only tear down the live turn once the server shows it ended. Clearing
    // unconditionally would blank a reply that is still streaming and merely
    // hasn't been recorded yet.
    set(
      advanced
        ? {
            running: false,
            streamingText: '',
            streamingReasoning: '',
            thinkingHint: '',
            statusLine: '',
            error: null,
          }
        : { error: null },
    );
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
