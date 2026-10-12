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
import type { Usage } from '../ws/types';
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
