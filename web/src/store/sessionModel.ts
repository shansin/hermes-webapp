/**
 * The session store's message model, and the pure helpers that fold events
 * and history into it.
 *
 * Separate from `session.ts` because none of this touches the store: it is
 * the shape of a transcript and the functions that build or patch one, all of
 * them testable without zustand, a socket or a gateway. The store imports it
 * and re-exports the types, so `import { type ChatMessage } from
 * '../store/session'` keeps working everywhere.
 */
import {
  MessageCompleteSchema,
  SubagentEventSchema,
  ToolCompleteSchema,
  ToolStartSchema,
  type Usage,
} from '../ws/types';
import { clarifyQuestionsOf, indexClarifyResults } from '../lib/clarifyExchange';

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
  | {
      kind: 'notice';
      id: string;
      text: string;
      tone: 'info' | 'error';
      label?: string;
      /** An in-app route that fixes what the notice reports. */
      action?: { label: string; to: string };
      at: MessageTime;
    }
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

/** A `prompt.submit` lost with its socket — see the store's `lostSubmit`. */
export interface LostSubmit {
  /** The bubble it was sent from. */
  id: string;
  text: string;
  display?: string;
  at: MessageTime;
}

/**
 * Settle a lost submit once the gateway says the session is idle.
 *
 * History decides: a last user turn with this text means it went through
 * and has since finished, so `messages` stands. Otherwise it never arrived,
 * and its bubble is marked failed — or put back, marked, when the transcript
 * being installed no longer has it, because what someone typed must survive
 * a dropped connection.
 */
export function settleLostSubmit(
  messages: ChatMessage[],
  history: { role: string; text?: string | null }[],
  lost: LostSubmit,
): ChatMessage[] {
  const lastUser = lastIndexOf(history, (m) => m.role === 'user');
  if (lastUser >= 0 && history[lastUser]!.text === lost.text) return messages;
  if (messages.some((m) => m.id === lost.id)) {
    return replaceLast(
      messages,
      (m) => m.id === lost.id && m.kind === 'user',
      (m) => ({ ...m, failed: true }),
    );
  }
  return [
    ...messages,
    { kind: 'user', id: lost.id, text: lost.text, displayText: lost.display, at: lost.at, failed: true },
  ];
}

/** Events a replay must not fold in again — see `applyReplay`. */
export const NOT_REPLAYED = new Set(['message.start', 'message.delta', 'reasoning.delta', 'thinking.delta']);

/**
 * Fill in clarify results from the remembered answers.
 *
 * Applied on every history load, because every history load comes from the
 * projection that dropped them. Matching is by question text — never by
 * position — so a transcript that gained or lost a row cannot slide a real
 * answer under a question it does not belong to.
 */
export function withClarifyAnswers(
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
export function answersFrom(result: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [question, value] of indexClarifyResults([{ role: 'tool', content: result }])) {
    out[question] = value;
  }
  return out;
}

export function lastIndexOf<T>(items: T[], pred: (item: T) => boolean): number {
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
export function replaceLast<T>(items: T[], pred: (item: T) => boolean, update: (item: T) => T): T[] {
  const idx = lastIndexOf(items, pred);
  if (idx === -1) return items;
  const next = items.slice();
  next[idx] = update(items[idx]!);
  return next;
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
export const LIVE_TURN_EVENTS = new Set([
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
export function deltaText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const t = (payload as { text?: unknown }).text;
  return typeof t === 'string' ? t : null;
}

/*
 * Per-event transcript folds.
 *
 * The pure half of the store's `applyEvent`: each takes the state it reads and
 * the event payload, and returns the patch to apply — or null for a payload
 * that failed its schema, which the store then ignores outright. What stays in
 * the store is what is not pure: haptics, the session filter, and releasing a
 * queued prompt once a turn ends. Ids come in through `newId` so the store
 * keeps one sequence for every message it ever made.
 */

/** The slice of store state a turn's events fold over. */
export interface TurnState {
  messages: ChatMessage[];
  streamingText: string;
  streamingReasoning: string;
  usage: Usage | null;
  clarifyAnswers: Record<string, unknown>;
  profile: string | null;
}

/** What a fold may change. */
export interface TurnPatch {
  messages?: ChatMessage[];
  running?: boolean;
  streamingText?: string;
  streamingReasoning?: string;
  thinkingHint?: string;
  statusLine?: string;
  usage?: Usage | null;
  clarifyAnswers?: Record<string, unknown>;
  inflightPrompt?: null;
  clarify?: null;
  approval?: null;
}

type NewId = () => string;

export function foldToolStart(s: TurnState, payload: unknown, newId: NewId): TurnPatch | null {
  const p = ToolStartSchema.safeParse(payload);
  if (!p.success) return null;
  return {
    statusLine: '',
    messages: [
      ...s.messages,
      {
        kind: 'tool',
        id: newId(),
        toolId: p.data.tool_id,
        name: p.data.name,
        context: p.data.context,
        status: 'running',
        at: Date.now(),
      },
    ],
  };
}

export function foldToolComplete(s: TurnState, payload: unknown): TurnPatch | null {
  const p = ToolCompleteSchema.safeParse(payload);
  if (!p.success) return null;
  const patch: TurnPatch = {
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
  };

  /**
   * Remember a clarify's answer the moment it lands. The row itself already
   * carries it, but the next reconnect rebuilds this transcript from
   * `session.history`, which does not — so watching a question get answered
   * and then losing that answer to a passing blip is the same bug as never
   * recovering it on resume.
   */
  if (p.data.name === 'clarify' && p.data.result !== undefined) {
    patch.clarifyAnswers = { ...s.clarifyAnswers, ...answersFrom(p.data.result) };
  }
  return patch;
}

/** The end of a turn. `interrupted` decides whether a queued prompt may follow. */
export function foldMessageComplete(
  s: TurnState,
  payload: unknown,
  newId: NewId,
): { patch: TurnPatch; interrupted: boolean } {
  const p = MessageCompleteSchema.safeParse(payload);
  const text = p.success ? (p.data.text ?? s.streamingText) : s.streamingText;
  const reasoning = p.success ? p.data.reasoning : s.streamingReasoning;
  const usage = p.success ? p.data.usage : undefined;
  const interrupted = p.success && p.data.status === 'interrupted';

  const patch: TurnPatch = {
    running: false,
    /**
     * The turn is over, so anything it was parked on is moot — it was
     * answered, interrupted, or hit the gateway's own timeout and
     * auto-proceeded. Leaving either sheet up would be worse than the bug it
     * replaced: a modal that cannot be dismissed, over a turn that has already
     * moved on.
     *
     * `approval` belongs here for exactly the same reason and was missing,
     * which made the ordinary way out of an approval the one that trapped you:
     * an `approval.request` is deliberately not dismissible, so a person who
     * does not want to grant it reaches for Stop — and `session.interrupt`
     * ends the turn with a `message.complete` that cleared the clarify beside
     * it and left the approval sheet standing over a finished conversation,
     * with no button on it that could still do anything. Only starting or
     * resuming another session got out of it.
     */
    clarify: null,
    approval: null,
    streamingText: '',
    streamingReasoning: '',
    thinkingHint: '',
    statusLine: '',
    usage: usage ?? s.usage,
    // The turn's prompt is in the transcript now, either as the bubble that
    // submitted it or as the one grafted on resume.
    inflightPrompt: null,
    messages: [
      /**
       * Nothing can still be running once the turn is over.
       *
       * A tool card is cleared by its own `tool.complete`, which is a single
       * event that a dropped socket, an interrupt or a gateway that never
       * emitted it all lose — and the card then pulses for ever, on a
       * conversation that finished, because nothing else ever looked at it
       * again.
       */
      ...s.messages.map((m) =>
        (m.kind === 'tool' || m.kind === 'subagent') && m.status === 'running'
          ? { ...m, status: 'done' as const }
          : m,
      ),
      {
        kind: 'assistant',
        id: newId(),
        text,
        reasoning: reasoning || undefined,
        usage,
        interrupted,
        at: Date.now(),
      },
    ],
  };
  return { patch, interrupted };
}

/**
 * One `subagent.*` event onto its card. `created` is true when the event had
 * no card to update — a `tool`/`complete` with no preceding `start` still
 * deserves one.
 */
export function foldSubagent(
  s: TurnState,
  type: string,
  payload: unknown,
  newId: NewId,
): { patch: TurnPatch; created: boolean } | null {
  const p = SubagentEventSchema.safeParse(payload);
  if (!p.success) return null;
  const d = p.data;
  // Identity fields are all optional. Fall back through the ids the gateway
  // might send, then to a single flat card, so an older emitter degrades to
  // one card rather than a new card per event.
  const agentId = d.subagent_id || d.child_session_id || 'subagent';
  const existing = s.messages.find((m) => m.kind === 'subagent' && m.agentId === agentId);
  const tokens =
    d.input_tokens != null || d.output_tokens != null ? (d.input_tokens ?? 0) + (d.output_tokens ?? 0) : undefined;

  if (!existing) {
    return {
      created: true,
      patch: {
        messages: [
          ...s.messages,
          {
            kind: 'subagent',
            id: newId(),
            agentId,
            goal: d.goal || d.text || 'Delegated task',
            model: d.model,
            depth: d.depth,
            activity: type === 'subagent.complete' ? undefined : (d.tool_name ?? d.text),
            summary: d.summary,
            status: type === 'subagent.complete' ? 'done' : 'running',
            durationS: d.duration_seconds,
            tokens,
            filesWritten: d.files_written,
            at: Date.now(),
          },
        ],
      },
    };
  }

  return {
    created: false,
    patch: {
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
              tokens: tokens ?? m.tokens,
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
    },
  };
}

/**
 * A failure outside a turn, as a notice. `provider_not_configured` is the one
 * with a fix in this app: no model provider is set up, and the Models screen
 * is where one is chosen.
 */
export function foldError(s: TurnState, payload: unknown, newId: NewId): TurnPatch {
  const p = payload as { message?: unknown; code?: unknown } | undefined;
  const text = typeof p?.message === 'string' && p.message ? p.message : 'Something went wrong.';
  const action =
    p?.code === 'provider_not_configured'
      ? { label: 'Set up a model', to: s.profile ? `/models?profile=${encodeURIComponent(s.profile)}` : '/models' }
      : undefined;
  return {
    messages: [
      ...s.messages,
      { kind: 'notice', id: newId(), text, tone: 'error', label: 'Hermes', action, at: Date.now() },
    ],
  };
}

/** The answer to a side question (`prompt.btw`), as a notice. */
export function foldBtwComplete(s: TurnState, payload: unknown, newId: NewId): TurnPatch {
  const p = payload as { question?: unknown; text?: unknown } | undefined;
  const text = typeof p?.text === 'string' ? p.text : '';
  const question = typeof p?.question === 'string' ? p.question : '';
  const failed = text.startsWith('error: ');
  return {
    messages: [
      ...s.messages,
      {
        kind: 'notice',
        id: newId(),
        text: text || '(no answer)',
        tone: failed ? 'error' : 'info',
        label: question ? `Side question — ${question}` : 'Side question',
        at: Date.now(),
      },
    ],
  };
}
