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
 *  - A turn can already be running when this store first hears of the session,
 *    and `message.start` will never arrive to say so. `applyLiveState` takes
 *    the gateway's own answer from `session.resume`; `LIVE_TURN_EVENTS` infers
 *    it from anything else the turn emits. Both exist because `running` gates
 *    the stop button, the working indicator and — the expensive one — whether
 *    the next message is queued or fired at a session that will reject it.
 */
import { create } from 'zustand';
import {
  ApprovalRequestSchema,
  ClarifyRequestSchema,
  normalizeClarify,
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
  type ClarifyPrompt,
  type ClarifyRequest,
  type ContextBreakdown,
  type HistoryMessage,
  type SessionCreateResult,
  type SessionInfo,
  type Usage,
} from '../ws/types';
import { hermes } from '../ws/client';
import { undoTurns } from '../api/gateway';
import { clarifyQuestionsOf, indexClarifyResults } from '../lib/clarifyExchange';
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
  /**
   * The question the agent is parked on. Keyed like `approval` so a sheet left
   * over from an earlier prompt cannot answer a newer one.
   */
  clarify: (ClarifyPrompt & { id: number }) | null;
  /**
   * Clarify answers, by question text.
   *
   * A cache with a specific job: `session.history` keeps what a tool was
   * called with and drops what it returned, and every reconnect rebuilds the
   * transcript from exactly that projection. Without somewhere to keep them,
   * an answer recovered on resume — or watched live — survives until the
   * first blip and then reverts to "Not answered", which on a phone is
   * seconds.
   */
  clarifyAnswers: Record<string, unknown>;
  error: string | null;

  /**
   * A message typed while a turn was still running, held until it finishes.
   * Only one is kept: a second send replaces it, which matches what the box
   * shows and avoids silently building a queue nobody can see or edit.
   */
  queued: { text: string; display?: string } | null;
  /** True while a rewind (retry / edit) is in flight. */
  rewinding: boolean;

  /**
   * The user half of a turn that is running right now, when history does not
   * have it yet.
   *
   * Hermes flushes a turn to SQLite when it ends, so a session resumed
   * mid-turn replays a transcript that stops at the *previous* turn: the
   * prompt being answered is not in it, and neither are any mid-turn
   * corrections. `session.resume` carries them in `inflight`, and this is
   * where they wait — `loadHistory` grafts them back onto the end of every
   * transcript it builds, because a reconnect rebuilds from the same
   * projection that dropped them and would otherwise lose them again.
   */
  inflightPrompt: { user: string; corrections: string[] } | null;

  // --- actions
  reset: () => void;
  adoptSession: (r: {
    sessionId: string;
    storedSessionId?: string;
    info?: SessionInfo;
    pendingClarify?: ClarifyRequest;
  }) => void;
  /**
   * Adopt the live-turn state a `session.create` / `session.resume` answered
   * with: whether a turn is running, what it is answering, the reply so far,
   * and anything it is blocked on. Separate from `adoptSession` because the
   * reconnect path reattaches to a session it already holds — the identity is
   * unchanged there, the turn state is the whole point of asking.
   */
  applyLiveState: (result: SessionCreateResult) => void;
  loadHistory: (messages: HistoryMessage[], opts?: { resync?: boolean }) => void;
  applyEvent: (params: { type: string; session_id?: string; payload?: unknown }) => void;
  submitPrompt: (text: string, opts?: { display?: string }) => Promise<void>;
  addNotice: (text: string, tone?: 'info' | 'error', label?: string) => void;
  clearQueued: () => void;
  retryLast: () => Promise<void>;
  applyResync: (messages: HistoryMessage[], opts?: { running?: boolean }) => void;
  /** Graft clarify answers back onto a replayed transcript. */
  restoreClarifyAnswers: (stored: { role?: string; content?: unknown }[]) => void;
  resendFailed: (messageId: string) => Promise<void>;
  editTurn: (messageId: string, newText: string) => Promise<void>;
  interrupt: () => Promise<void>;
  respondApproval: (choice: string, all?: boolean) => Promise<void>;
  /** Answer the pending clarify. Keys are `qid`s; a lone question uses ''. */
  respondClarify: (answers: Record<string, string>) => Promise<void>;
  refreshUsage: () => Promise<void>;
  setTitle: (t: string) => void;
}

let seq = 0;
const nextId = () => `m${++seq}`;

/** Approval sheets are keyed so a stale sheet can't answer a newer request. */
let approvalSeq = 0;
let clarifySeq = 0;

/**
 * Fill in clarify results from the remembered answers.
 *
 * Applied on every history load, because every history load comes from the
 * projection that dropped them. Matching is by question text — never by
 * position — so a transcript that gained or lost a row cannot slide a real
 * answer under a question it does not belong to.
 */
function withClarifyAnswers(
  messages: ChatMessage[],
  answers: Record<string, unknown>,
): ChatMessage[] {
  if (!Object.keys(answers).length) return messages;

  return messages.map((m) => {
    if (m.kind !== 'tool' || m.name !== 'clarify' || m.result !== undefined) return m;
    for (const question of clarifyQuestionsOf(m.args)) {
      const result = answers[question];
      if (result !== undefined) return { ...m, result };
    }
    return m;
  });
}

/** The remembered-answer entries a clarify result is worth filing under. */
function answersFrom(result: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [question, value] of indexClarifyResults([{ role: 'tool', content: result }])) {
    out[question] = value;
  }
  return out;
}

function lastIndexOf<T>(items: T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return i;
  return -1;
}

/**
 * Replace one message, from the end, and touch nothing else.
 *
 * The events that update a message in place — a tool finishing, a subagent
 * reporting — used to `map` the whole array, calling the predicate on every
 * historical message and allocating a new one of them per event. In a long
 * tool-heavy session that is O(transcript) work per tool call, on the same
 * socket handler as the token deltas.
 *
 * Searching backwards is what makes the common case cheap rather than merely
 * cheaper: the thing being updated is nearly always the last tool card or the
 * one before it, so the scan stops within a few steps of the end regardless of
 * how long the transcript is.
 *
 * Returns the original array when nothing matches, so `set` is handed the same
 * reference and every subscriber's identity check holds. That matters here:
 * a `tool.complete` for a tool card this client never saw (a resume mid-run,
 * a duplicate frame) previously rewrote the array anyway and re-rendered the
 * whole transcript to change nothing.
 */
function replaceLast<T>(items: T[], pred: (item: T) => boolean, update: (item: T) => T): T[] {
  const idx = lastIndexOf(items, pred);
  if (idx === -1) return items;
  const next = items.slice();
  next[idx] = update(items[idx]!);
  return next;
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

/**
 * Events that only ever occur inside a turn.
 *
 * Two kinds of event are deliberately absent. `message.complete` and
 * `tool.complete` can each be the last thing a finished turn emits, and a
 * completion must never be the reason the UI decides work has started. And
 * `status.update` is not turn-scoped at all: a manual `/compress` is refused
 * while a turn is running and emits one anyway, so trusting it would light the
 * stop button on an idle session with no `message.complete` coming to put it
 * out again.
 */
const LIVE_TURN_EVENTS = new Set([
  'message.delta',
  'reasoning.delta',
  'thinking.delta',
  'tool.generating',
  'tool.start',
  'subagent.start',
  'subagent.tool',
  'subagent.thinking',
  'approval.request',
  'clarify.request',
]);

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
  clarify: null,
  clarifyAnswers: {},
  error: null,
  queued: null,
  rewinding: false,
  inflightPrompt: null,

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
      clarify: null,
      clarifyAnswers: {},
      error: null,
      queued: null,
      rewinding: false,
      inflightPrompt: null,
    }),

  adoptSession: ({ sessionId, storedSessionId, info, pendingClarify }) =>
    set({
      sessionId,
      storedSessionId: storedSessionId ?? null,
      info: info ?? null,
      error: null,
      // Restored rather than merely noted: the agent is still blocked on it,
      // and this client is now the only thing that can answer.
      clarify: pendingClarify
        ? { ...normalizeClarify(pendingClarify), id: ++clarifySeq }
        : null,
    }),

  /**
   * Take the gateway's word for what this session is doing.
   *
   * `running` only ever came from `message.start` or from submitting a prompt
   * here, so any client that arrived after a turn began believed the session
   * was idle for the rest of it: no stop button, no working indicator, and the
   * next message sent at a busy session instead of queued behind the turn.
   * The phone hits this constantly — backgrounding a PWA long enough for the
   * OS to discard the page is the ordinary case, not an edge one.
   *
   * The reply so far is merged rather than assigned: on a reconnect this
   * client may already hold *more* of the turn than the snapshot does (deltas
   * kept arriving while the resume was in flight), and both are the same text
   * accumulated from the same stream, so the longer one is the newer one.
   */
  applyLiveState: (result) => {
    const running = result.running === true;
    const inflight = result.inflight ?? null;
    const s = get();

    const partial = inflight?.assistant ?? '';
    const next: Partial<SessionState> = {
      running,
      inflightPrompt:
        running && inflight?.user
          ? { user: inflight.user, corrections: inflight.corrections ?? [] }
          : null,
    };

    if (running && partial.length > s.streamingText.length) next.streamingText = partial;

    /**
     * Both blocking prompts, restored for the same reason: the event fired at
     * a client that was not there, and the agent is still parked on it. An
     * approval was previously dropped outright — `pending_approval` was read
     * nowhere — which left the turn stopped with nothing on screen to release
     * it, from an app that looked perfectly healthy.
     */
    if (result.pending_approval) {
      const p = ApprovalRequestSchema.safeParse(result.pending_approval);
      if (p.success) next.approval = { ...p.data, id: ++approvalSeq };
    }
    if (result.pending_clarify) {
      const p = ClarifyRequestSchema.safeParse(result.pending_clarify);
      if (p.success) next.clarify = { ...normalizeClarify(p.data), id: ++clarifySeq };
    }

    // A prompt the gateway accepted for the next turn. Shown in the same strip
    // as one held here, since from the composer they are the same wait — but
    // never over one held here: that one has not been sent anywhere yet, and
    // it may carry a `display` the server's copy cannot know about.
    if (result.queued?.user && !s.queued) next.queued = { text: result.queued.user };

    set(next);
  },

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
        // Replayed history has no tool_id and no result — only what was
        // called, and the arguments it was called with.
        const name = m.name ?? 'tool';
        out.push({
          kind: 'tool',
          id: nextId(),
          toolId: `hist-${seq}`,
          name,
          context: m.context,
          args: m.args,
          result: m.result,
          status: 'done',
          at: priorTime(i, 'tool', name),
        });
      }
    }

    /**
     * Put the running turn's prompt back on the end.
     *
     * `session.history` answers from the session store, and Hermes writes a
     * turn there when it ends — so a transcript fetched mid-turn describes the
     * conversation as it was *before* the prompt was sent. Reopening the app
     * while the agent was working showed the previous turn and nothing else:
     * not the question being answered, not the reply so far.
     *
     * Only the prompt is recoverable this way, and only from the snapshot
     * `session.resume` carried (the reply so far goes to `streamingText`, and
     * the tool calls of this turn are simply not recorded anywhere yet — which
     * is why nothing here tries to reconstruct a running tool card).
     *
     * Deduplicated against what history did return, because a turn that
     * completes between the resume and the fetch lands in both.
     */
    const { inflightPrompt, running } = get();
    if (running && inflightPrompt) {
      for (const text of [inflightPrompt.user, ...inflightPrompt.corrections]) {
        if (!text || out.some((m) => m.kind === 'user' && m.text === text)) continue;
        out.push({ kind: 'user', id: nextId(), text, at: null });
      }
    }

    set({
      messages: withClarifyAnswers(out, get().clarifyAnswers),
      queued: opts?.resync ? get().queued : null,
    });
  },

  applyEvent: ({ type, session_id, payload }) => {
    const s = get();

    /**
     * Only this conversation's events.
     *
     * There is one socket for the whole app and the gateway broadcasts every
     * session over it. Without this check, a turn still streaming in the
     * session you just left goes on writing into the session you just opened —
     * its deltas, its tool cards, its `message.complete` — because the store
     * only ever looked at `type`. That is the reported symptom: start a turn,
     * switch conversations, and watch the other agent's reply appear in front
     * of you.
     *
     * Events without a `session_id` are the global ones — `gateway.ready`,
     * `sessions.changed`, `cron.changed` — and must still pass. Only those two
     * shapes exist on the wire; every conversation-scoped event observed
     * carries the gateway session handle that `adoptSession` stores.
     *
     * A null `sessionId` fails this too, which is deliberate. `reset()` clears
     * it and the resume round trip that follows is a window during which the
     * outgoing session is still streaming; anything arriving then belongs to a
     * conversation that is no longer on screen. Nothing is lost by dropping
     * it: `adoptSession` supplies `info` from the RPC result, and the title is
     * restored explicitly on resume.
     */
    if (session_id && session_id !== s.sessionId) return;

    /**
     * Anything arriving from a turn means a turn is running.
     *
     * `message.start` is the event that says so, and it is the one event a
     * client that arrived late can never see. `session.resume` answers with
     * `running` and covers that properly; this is the backstop for everything
     * it cannot — a session adopted by a path that never resumed, a gateway
     * that answered without the flag, a socket that reattached mid-turn. The
     * cost of being wrong is one spurious stop button until the turn ends;
     * the cost of the old default was sending the next message at a session
     * the gateway then rejected as busy.
     */
    if (!s.running && LIVE_TURN_EVENTS.has(type)) set({ running: true });

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

        /**
         * Remember a clarify's answer the moment it lands. The row itself
         * already carries it, but the next reconnect rebuilds this transcript
         * from `session.history`, which does not — so watching a question get
         * answered and then losing that answer to a passing blip is the same
         * bug as never recovering it on resume.
         */
        if (p.data.name === 'clarify' && p.data.result !== undefined) {
          set({ clarifyAnswers: { ...s.clarifyAnswers, ...answersFrom(p.data.result) } });
        }

        set({
          messages: replaceLast(
            s.messages,
            (m) => m.kind === 'tool' && m.toolId === p.data.tool_id,
            (m) => ({
              ...m,
              status: 'done' as const,
              args: p.data.args,
              result: p.data.result,
              durationS: p.data.duration_s,
            }),
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
          /**
           * The turn is over, so any question it was parked on is moot — it
           * was answered, interrupted, or hit the gateway's clarify timeout
           * and auto-proceeded. Leaving the sheet up would be worse than the
           * bug it replaced: a modal that cannot be dismissed, over a turn
           * that has already moved on.
           */
          clarify: null,
          streamingText: '',
          streamingReasoning: '',
          thinkingHint: '',
          statusLine: '',
          usage: usage ?? s.usage,
          // The turn's prompt is in the transcript now, either as the bubble
          // that submitted it or as the one grafted on resume.
          inflightPrompt: null,
          messages: [
            /**
             * Nothing can still be running once the turn is over.
             *
             * A tool card is cleared by its own `tool.complete`, which is a
             * single event that a dropped socket, an interrupt or a gateway
             * that never emitted it all lose — and the card then pulses for
             * ever, on a conversation that finished, because nothing else ever
             * looked at it again.
             */
            ...s.messages.map((m) =>
              (m.kind === 'tool' || m.kind === 'subagent') && m.status === 'running'
                ? { ...m, status: 'done' as const }
                : m,
            ),
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
          messages: replaceLast(
            s.messages,
            (m) => m.kind === 'subagent' && m.agentId === agentId,
            (m) => {
              if (m.kind !== 'subagent') return m;
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
            },
          ),
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

      case 'clarify.request': {
        const p = ClarifyRequestSchema.safeParse(payload);
        if (!p.success) return;
        buzz('approval');
        set({ clarify: { ...normalizeClarify(p.data), id: ++clarifySeq } });
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
      // This turn's prompt is now a bubble of its own; a snapshot of the last
      // one must not be grafted on again by the next reconnect.
      inflightPrompt: null,
    }));

    try {
      await hermes.call('prompt.submit', { session_id: sessionId, text });
    } catch (err) {
      set((st) => ({
        running: false,
        error: err instanceof Error ? err.message : 'submit failed',
        messages: replaceLast(
          st.messages,
          (m) => m.id === id && m.kind === 'user',
          (m) => ({ ...m, failed: true }),
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
   *
   * `opts.running` is the gateway's own answer, from the `session.resume` that
   * reattached this socket, and it supersedes the length heuristic below —
   * which is a guess, and a wrong one in a case that happens constantly: a
   * turn that completes and another that starts (or a `session.compress`, or
   * a subagent's rows landing) all grow the transcript while a turn is very
   * much still running, and the guess reads that growth as "the turn ended"
   * and takes the stop button away mid-turn.
   */
  applyResync: (messages, opts) => {
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
    const ended =
      typeof opts?.running === 'boolean' ? !opts.running : messages.length > current.length;

    get().loadHistory(messages, { resync: true });

    // Only tear down the live turn once the server shows it ended. Clearing
    // unconditionally would blank a reply that is still streaming and merely
    // hasn't been recorded yet.
    set(
      ended
        ? {
            running: false,
            streamingText: '',
            streamingReasoning: '',
            thinkingHint: '',
            statusLine: '',
            inflightPrompt: null,
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

  /**
   * Answer the pending clarify and let the parked turn continue.
   *
   * A batch is sent one call per question because that is how the gateway
   * locks them: it completes the request only once every `qid` has an answer,
   * and a call without a `question_id` would resolve the whole batch with a
   * single value. Sequential rather than parallel — the calls mutate one
   * server-side entry under a lock, and the last one is what releases the
   * agent thread.
   *
   * The sheet is cleared first. The turn resumes the moment the final call
   * lands, so holding a modal over the reply while awaiting the round trip
   * would cover the thing the person just asked for.
   */
  respondClarify: async (answers) => {
    const { sessionId, clarify } = get();
    if (!sessionId || !clarify) return;
    set({ clarify: null });

    try {
      for (const question of clarify.questions) {
        const answer = answers[question.qid ?? ''] ?? '';
        const params: Record<string, unknown> = {
          session_id: sessionId,
          request_id: clarify.requestId,
          answer,
        };
        if (question.qid) params.question_id = question.qid;

        const res = await hermes.call<{ status?: string }>('clarify.respond', params);
        /**
         * `expired` rather than an error: the gateway keeps answering a
         * request whose wait already timed out, so the agent moved on without
         * this. Saying so beats a silent no-op, since the person just made a
         * choice and would otherwise watch it change nothing.
         */
        if (res?.status === 'expired') {
          get().addNotice('That question timed out — the agent moved on without an answer.', 'info');
          return;
        }
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not send that answer' });
    }
  },

  /**
   * Put the answers back into a resumed conversation.
   *
   * `session.history` keeps what a tool was called with but not what it
   * returned, so a replayed clarify arrives as a question with no answer under
   * it. The stored transcript has the results; this matches them back on by
   * question text and leaves anything it cannot match alone.
   */
  restoreClarifyAnswers: (stored) => {
    const byQuestion = indexClarifyResults(stored);
    if (!byQuestion.size) return;

    // Kept as well as applied. Every reconnect reloads the transcript from the
    // projection that dropped these, so applying them once would hold only
    // until the first blip.
    const answers = { ...get().clarifyAnswers, ...Object.fromEntries(byQuestion) };
    set({ clarifyAnswers: answers, messages: withClarifyAnswers(get().messages, answers) });
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
