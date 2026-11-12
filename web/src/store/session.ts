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
  SessionInfoSchema,
  SessionTitleSchema,
  StatusUpdateSchema,
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
import { hermes, ConnectionLost, type ServerRequest } from '../ws/client';
import { undoTurns } from '../api/gateway';
import { indexClarifyResults } from '../lib/clarifyExchange';
import { buzz } from '../lib/haptics';
import {
  LIVE_TURN_EVENTS,
  NOT_REPLAYED,
  deltaText,
  foldBtwComplete,
  foldError,
  foldMessageComplete,
  foldSubagent,
  foldToolComplete,
  foldToolStart,
  lastIndexOf,
  replaceLast,
  settleLostSubmit,
  withClarifyAnswers,
  type ChatMessage,
  type LostSubmit,
  type StoredRef,
} from './sessionModel';
import { answerServerRequest, liveRequests } from './serverRequests';
import { rememberSession } from '../lib/lastSession';

export type { ChatMessage, MessageTime, StoredRef } from './sessionModel';

interface SessionState {
  /** Gateway session handle (8-hex), distinct from the stored session id. */
  sessionId: string | null;
  /** Persistent id used by the REST session endpoints. */
  storedSessionId: string | null;
  /**
   * A chat made by `session.create` that has not sent anything yet. Hermes
   * mints it a stored id at once but keeps the row lazy, and a cold start
   * never resumes it — so its draft is filed under the shared new-chat key
   * rather than an id nothing will reopen (`lib/drafts.ts`).
   */
  pristine: boolean;
  /**
   * Which profile's store holds this conversation, or null for the active one.
   *
   * Kept here rather than read from the URL each time, because the URL stops
   * carrying it: `ChatScreen` clears its `?resume=&profile=` intent the moment
   * a resume lands, so that a reconnect does not resume all over again. Every
   * later per-session call then addressed the *active* profile — the reconnect
   * `session.resume` above all, which a phone makes constantly — and the
   * routes 404 for a session in another profile, which reads as "deleted".
   * The rule in CLAUDE.md is that the profile travels with the id everywhere;
   * this is where it travels.
   */
  profile: string | null;
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
  /**
   * `srqId` is set when the approval arrived as a server request, which is the
   * only way a live one arrives now; absent, it came from a resume's
   * `pending_approval` and is answered over `approval.respond`.
   */
  approval: (ApprovalRequest & { id: number; srqId?: string }) | null;
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
  /** True while a fork (`lib/forkFlow.ts`) is being made. */
  forking: boolean;
  /**
   * The title of the conversation this one was forked from, when it was
   * forked on this screen. Only from `session.branch`'s own answer: a stored
   * row's `parent_session_id` is also how a *compression* continuation points
   * at its predecessor, so reading lineage off a resumed row would label
   * every long conversation a fork.
   */
  forkedFrom: string | null;

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

  /**
   * A `prompt.submit` whose socket died before it answered — sent or not,
   * nobody knows yet. Its bubble is left unmarked until the reconnect's
   * `session.resume` (running → it went through) or history (is it there?)
   * settles it; stamping it failed on the spot offered a resend of a prompt
   * the agent was already answering, which then bounced off the busy session.
   */
  lostSubmit: LostSubmit | null;

  // --- actions
  reset: () => void;
  adoptSession: (r: {
    sessionId: string;
    storedSessionId?: string;
    /** Null (or absent) means the gateway's active profile. */
    profile?: string | null;
    info?: SessionInfo;
    pendingClarify?: ClarifyRequest;
    /** True only for a chat `session.create` just made. */
    pristine?: boolean;
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
  /** Route a server→client request; false declines it (→ `-32601`). */
  applyServerRequest: (req: ServerRequest) => boolean;
  /** `request.cancel`: the backend withdrew a request (timeout, interrupt, another surface answered). */
  cancelServerRequest: (id: string) => void;
  /** Start noting which events arrive live, ahead of `applyReplay`. */
  beginReplayWindow: () => void;
  /**
   * Fold in the running turn's events from `session.events.since`. False when
   * the ring no longer reaches back to the turn's start.
   */
  applyReplay: (events: unknown[]) => boolean;
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

/**
 * Haptics for events, muted while a replay folds in events that happened
 * minutes ago — a dozen tool cards restored at once should not arrive as a
 * dozen buzzes.
 */
let replayMuted = false;
const vibrate: typeof buzz = (...args) => {
  if (!replayMuted) buzz(...args);
};

/**
 * The lowest `seq` applied live since the replay window opened; `null` while
 * no window is open. See `applyReplay`.
 */
let replayFloor: number | null = null;

/** Approval sheets are keyed so a stale sheet can't answer a newer request. */
let approvalSeq = 0;
let clarifySeq = 0;

type Get = () => SessionState;
type Set = (partial: Partial<SessionState>) => void;

/**
 * Which conversation the store is on, as a counter: bumped by `reset` and by
 * `adoptSession` taking a different handle.
 *
 * Every async action captures it before its first `await` and checks it after
 * each one. Without that, a reply landing after the user switched sessions
 * wrote into the new one — a rewind put A's truncated transcript into B and
 * then submitted A's prompt to B; a failed submit stamped an error on B. The
 * gateway handle alone is not enough to compare: leaving a conversation and
 * coming back can resume the very same live handle.
 */
let epoch = 0;
export const sessionEpoch = (): number => epoch;
const stillOn = (token: number): boolean => token === epoch;

/**
 * Put a server request on screen, if it belongs to the session on screen.
 * `quiet` skips the buzz, for one re-delivered rather than freshly raised.
 */
function showServerRequest(get: Get, set: Set, req: ServerRequest, quiet: boolean): void {
  const s = get();
  const sid = typeof req.params.session_id === 'string' ? req.params.session_id : undefined;
  if (!s.sessionId || (sid && sid !== s.sessionId)) return;

  if (req.method === 'approval') {
    const p = ApprovalRequestSchema.safeParse(req.params);
    if (!p.success) return;
    // A replay of the request already on screen keeps its sheet (and its
    // armed "always" button) rather than flashing a new one.
    if (s.approval?.srqId === req.id) return;
    if (!quiet) vibrate('approval');
    set({ approval: { ...p.data, id: ++approvalSeq, srqId: req.id } });
    return;
  }

  // The request id stands in for clarify's own: it is what the answer is
  // correlated on, and the params no longer carry a `request_id`.
  const p = ClarifyRequestSchema.safeParse({ ...req.params, request_id: req.id });
  if (!p.success) return;
  if (s.clarify?.requestId === req.id) return;
  if (!quiet) vibrate('approval');
  set({ clarify: { ...normalizeClarify(p.data), id: ++clarifySeq } });
}

/**
 * The row id and authoring time newer Hermes puts on a history row — see
 * `StoredRef`. Read off the loose object rather than the schema, and only
 * when they are the types they claim to be.
 */
function storedRef(m: HistoryMessage): StoredRef {
  const { row_id: rowId, timestamp } = m as { row_id?: unknown; timestamp?: unknown };
  return {
    ...(typeof rowId === 'number' ? { rowId } : {}),
    ...(typeof timestamp === 'number' && timestamp > 0 ? { storedAt: timestamp * 1000 } : {}),
  };
}

/** This conversation was just active; see `lib/lastSession.ts`. */
function noteActivity(get: Get): void {
  const { storedSessionId, profile } = get();
  rememberSession(storedSessionId, profile);
}

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
  const token = sessionEpoch();
  set({ rewinding: true, error: null });
  try {
    const prefill = await undoTurns(sessionId, turns);
    // Switched away while the undo was out: this transcript and this prompt
    // belong to a conversation no longer on screen.
    if (!stillOn(token)) return;
    set({ messages: messages.slice(0, idx) });
    const text = replacement ?? (prefill || target.text);
    // A skill command keeps showing its short invocation, not the expansion —
    // but only when resending it unchanged. Edited text is its own message.
    await get().submitPrompt(text, replacement ? undefined : { display: target.displayText });
  } catch (err) {
    if (stillOn(token)) set({ error: err instanceof Error ? err.message : 'Could not rewind the conversation' });
  } finally {
    if (stillOn(token)) set({ rewinding: false });
  }
}

export const useSession = create<SessionState>((set, get) => ({
  sessionId: null,
  storedSessionId: null,
  pristine: false,
  profile: null,
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
  forking: false,
  forkedFrom: null,
  inflightPrompt: null,
  lostSubmit: null,

  reset: () => {
    epoch++;
    set({
      sessionId: null,
      storedSessionId: null,
      pristine: false,
      profile: null,
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
      forking: false,
      forkedFrom: null,
      inflightPrompt: null,
      lostSubmit: null,
    });
  },

  adoptSession: ({ sessionId, storedSessionId, profile, info, pendingClarify, pristine }) => {
    if (sessionId !== get().sessionId) epoch++;
    set({
      sessionId,
      storedSessionId: storedSessionId ?? null,
      pristine: pristine ?? false,
      profile: profile ?? null,
      info: info ?? null,
      error: null,
      // Restored rather than merely noted: the agent is still blocked on it,
      // and this client is now the only thing that can answer.
      clarify: pendingClarify
        ? { ...normalizeClarify(pendingClarify), id: ++clarifySeq }
        : null,
    });
  },

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

    if (running) {
      // A turn is in flight, so a submit lost with its socket got through.
      next.lostSubmit = null;
    } else {
      /**
       * Idle, on the gateway's word, so nothing on screen may still look
       * live. The reply buffers are what a `message.complete` lost in the gap
       * would have cleared — `StreamingTail` draws them whether or not a turn
       * is running, so a reconnect onto a rebuilt runtime left the half-written
       * reply frozen under the transcript — and the same goes for a card the
       * turn never got to complete.
       */
      next.streamingText = '';
      next.streamingReasoning = '';
      next.thinkingHint = '';
      next.statusLine = '';
      if (s.messages.some((m) => (m.kind === 'tool' || m.kind === 'subagent') && m.status === 'running')) {
        next.messages = s.messages.map((m) =>
          (m.kind === 'tool' || m.kind === 'subagent') && m.status === 'running'
            ? { ...m, status: 'done' as const }
            : m,
        );
      }
    }

    /**
     * The resume's `open_requests`, which the client handed to
     * `applyServerRequest` just before this — while `doResume` had the store
     * on no session at all, or a reconnect onto a rebuilt runtime still held
     * the old handle, so they were held rather than shown. Attach them now
     * the session is adopted: the copy below has no `srqId`, so it can be
     * answered but never withdrawn, and `request.cancel` left its sheet up.
     */
    const open = (result as { open_requests?: unknown }).open_requests;
    if (Array.isArray(open)) {
      for (const entry of open as { id?: unknown }[]) {
        const req = typeof entry?.id === 'string' ? liveRequests.get(entry.id) : undefined;
        if (req) showServerRequest(get, set, req, true);
      }
    }

    /**
     * Both blocking prompts, restored for the same reason: the event fired at
     * a client that was not there, and the agent is still parked on it. An
     * approval was previously dropped outright — `pending_approval` was read
     * nowhere — which left the turn stopped with nothing on screen to release
     * it, from an app that looked perfectly healthy.
     */
    if (result.pending_approval) {
      const p = ApprovalRequestSchema.safeParse(result.pending_approval);
      // The same approval also comes back in `open_requests`, delivered just
      // before this as a server request. That copy can be answered with a
      // response frame and withdrawn by `request.cancel`; this one cannot, so
      // it only stands in when no server request is on screen.
      if (p.success && !get().approval?.srqId) next.approval = { ...p.data, id: ++approvalSeq };
    }
    if (result.pending_clarify) {
      const p = ClarifyRequestSchema.safeParse(result.pending_clarify);
      // Likewise never over the server request's own copy.
      const shown = get().clarify;
      if (p.success && !(shown && liveRequests.has(shown.requestId))) {
        next.clarify = { ...normalizeClarify(p.data), id: ++clarifySeq };
      }
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
     * The message already on screen at this position, when the server's copy
     * agrees with it. Its time and its id carry over: history has no
     * timestamps of its own — see `MessageTime` — so without this a reconnect
     * stripped the clock off every message, and a fresh id per row remounted
     * every `MessageRow` on every reconnect (markdown parsed again, expanded
     * cards collapsed, measured sizes lost) to show the same transcript.
     */
    const priorMatch = (i: number, kind: ChatMessage['kind'], text: string): ChatMessage | null => {
      const old = prior[i];
      if (!old || old.kind !== kind) return null;
      if (kind === 'tool') return old.kind === 'tool' && old.name === text ? old : null;
      return 'text' in old && old.text === text ? old : null;
    };

    const out: ChatMessage[] = [];
    for (const [i, m] of messages.entries()) {
      if (m.role === 'user') {
        const text = m.text ?? '';
        const old = priorMatch(i, 'user', text);
        out.push({ kind: 'user', id: old?.id ?? nextId(), text, at: old?.at ?? null, ...storedRef(m) });
      } else if (m.role === 'assistant') {
        const text = m.text ?? '';
        const old = priorMatch(i, 'assistant', text);
        out.push({
          kind: 'assistant',
          id: old?.id ?? nextId(),
          text,
          reasoning: m.reasoning,
          at: old?.at ?? null,
          ...storedRef(m),
        });
      } else if (m.role === 'tool') {
        // Replayed history has no tool_id and no result — only what was
        // called, and the arguments it was called with.
        const name = m.name ?? 'tool';
        const old = priorMatch(i, 'tool', name);
        out.push({
          kind: 'tool',
          id: old?.id ?? nextId(),
          toolId: old?.kind === 'tool' ? old.toolId : `hist-${seq}`,
          name,
          context: m.context,
          args: m.args,
          result: m.result,
          status: 'done',
          at: old?.at ?? null,
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
    const { inflightPrompt, running, lostSubmit } = get();
    if (running && inflightPrompt) {
      for (const text of [inflightPrompt.user, ...inflightPrompt.corrections]) {
        if (!text || out.some((m) => m.kind === 'user' && m.text === text)) continue;
        out.push({ kind: 'user', id: nextId(), text, at: null });
      }
    }

    // Idle now, so history is the last word on a submit lost with its socket.
    const settled = lostSubmit && !running ? settleLostSubmit(out, messages, lostSubmit) : out;

    set({
      messages: withClarifyAnswers(settled, get().clarifyAnswers),
      queued: opts?.resync ? get().queued : null,
      ...(lostSubmit && !running ? { lostSubmit: null } : {}),
    });
  },

  /**
   * Approval and clarify, as the backend now raises them.
   *
   * Only those two are accepted; `sudo`, `secret` and the rest have no UI
   * here, and declining them is what makes the backend fail them at once
   * rather than hold the agent for minutes. A request for a conversation that
   * is not on screen is accepted and held, not shown — see `liveRequests`.
   */
  applyServerRequest: (req) => {
    if (req.method !== 'approval' && req.method !== 'clarify') return false;
    liveRequests.set(req.id, req);
    showServerRequest(get, set, req, req.replayed);
    return true;
  },

  cancelServerRequest: (id) => {
    liveRequests.delete(id);
    const s = get();
    if (s.approval?.srqId === id) set({ approval: null });
    if (s.clarify?.requestId === id) set({ clarify: null });
  },

  beginReplayWindow: () => {
    replayFloor = Number.POSITIVE_INFINITY;
  },

  /**
   * Restore what a running turn did while the socket was down.
   *
   * A reconnect mid-turn rebuilds the transcript from history, and history
   * ends at the turn *before*: the agent writes a turn when it finishes. So
   * every tool card of the turn still running — including the ones that were
   * on screen before the drop — vanished on reconnect, and stayed gone until
   * the turn ended. Hermes keeps each session's recent event frames in a ring
   * (`session.events.since`); this replays the current turn from it.
   *
   * Three choices make that safe to apply on top of a live socket:
   *
   *  - **From the turn's own `message.start`**, found in the ring rather than
   *    remembered. A client that never saw it (opened mid-turn, page reloaded)
   *    replays correctly too, and a ring that has evicted it — a long turn,
   *    hundreds of deltas — returns false and changes nothing, which is the
   *    behaviour before this existed.
   *  - **Not the deltas.** `session.resume`'s `inflight` already restored the
   *    reply so far, and appending the same tokens again would print it twice.
   *    Reasoning is skipped for the same reason; what was on screen stays.
   *  - **Not what already arrived live.** Events keep flowing while the
   *    `events.since` round trip is out, and they are in the ring too.
   *    `beginReplayWindow` starts noting the lowest `seq` applied live, and
   *    anything at or above it is left out here.
   *  - **Not a turn that is over.** The window opens only after the history
   *    fetch, so a `message.complete` that arrived live before it is below
   *    the floor; replaying from the start then printed the turn's cards and
   *    its reply a second time over the copy history (or that live event)
   *    had already put there. Idle, or a completion in the ring, and there is
   *    nothing left to restore. A card already on screen is likewise not
   *    started again — a resync that kept the local transcript keeps them.
   */
  applyReplay: (events) => {
    const floor = replayFloor ?? Number.POSITIVE_INFINITY;
    replayFloor = null;

    const frames = events.filter(
      (e): e is { type: string; session_id?: string; payload?: unknown; seq?: unknown } =>
        Boolean(e) && typeof (e as { type?: unknown }).type === 'string',
    );
    let start = -1;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i]!.type === 'message.start') {
        start = i;
        break;
      }
    }
    if (start < 0) return false;

    const turn = frames.slice(start + 1);
    if (!get().running || turn.some((f) => f.type === 'message.complete')) return false;

    const onScreen = (payload: unknown): boolean => {
      const id = (payload as { tool_id?: unknown } | null)?.tool_id;
      return typeof id === 'string' && get().messages.some((m) => m.kind === 'tool' && m.toolId === id);
    };

    replayMuted = true;
    try {
      for (const frame of turn) {
        if (NOT_REPLAYED.has(frame.type)) continue;
        if (typeof frame.seq === 'number' && frame.seq >= floor) continue;
        if (frame.type === 'tool.start' && onScreen(frame.payload)) continue;
        get().applyEvent(frame);
      }
    } finally {
      replayMuted = false;
    }
    return true;
  },

  applyEvent: (params) => {
    const { type, session_id, payload } = params;
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

    const seqNo = (params as { seq?: unknown }).seq;
    if (replayFloor !== null && !replayMuted && typeof seqNo === 'number') {
      replayFloor = Math.min(replayFloor, seqNo);
    }

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
          lostSubmit: null,
          streamingText: '',
          streamingReasoning: '',
          thinkingHint: '',
          statusLine: '',
        });
        return;

      // The two delta cases are the only events on a per-token path — 30–60×
      // a second for the length of a turn. `TextDeltaSchema` is a
      // `.loose()` object, so validating here allocated a fresh copy of
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
        const patch = foldToolStart(s, payload, nextId);
        if (!patch) return;
        vibrate('tool');
        set(patch);
        return;
      }

      case 'tool.complete': {
        const patch = foldToolComplete(s, payload);
        if (patch) set(patch);
        return;
      }

      case 'message.complete': {
        const { patch, interrupted } = foldMessageComplete(s, payload, nextId);
        vibrate('done');
        set(patch);
        noteActivity(get);

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
        const folded = foldSubagent(s, type, payload, nextId);
        if (!folded) return;
        if (folded.created) vibrate('tool');
        set(folded.patch);
        return;
      }

      case 'approval.request': {
        const p = ApprovalRequestSchema.safeParse(payload);
        if (!p.success) return;
        vibrate('approval');
        set({ approval: { ...p.data, id: ++approvalSeq } });
        return;
      }

      case 'clarify.request': {
        const p = ClarifyRequestSchema.safeParse(payload);
        if (!p.success) return;
        vibrate('approval');
        set({ clarify: { ...normalizeClarify(p.data), id: ++clarifySeq } });
        return;
      }

      /**
       * A failure outside a turn: the agent could not be built, a model
       * switch or a compression failed. These were dropped outright — the
       * switch fell through as an unknown type — so a session whose agent
       * never came up just sat there, and the first sign was a prompt that
       * went nowhere. A failure *inside* a turn arrives on that turn's own
       * terminal frame instead, so this does not touch `running`.
       */
      case 'error':
        set(foldError(s, payload, nextId));
        return;

      /**
       * The answer to a side question (`prompt.btw`). It belongs to no turn —
       * it was answered off a snapshot — so it lands as a notice rather than
       * a message, and leaves `running` and the stream alone.
       */
      case 'btw.complete':
        set(foldBtwComplete(s, payload, nextId));
        return;

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
    if (get().pristine) set({ pristine: false });

    // The gateway runs one turn per session, so a message sent mid-turn would
    // be rejected. Hold it instead and send it when the turn completes.
    if (running) {
      vibrate('tap');
      set({ queued: { text, display: opts?.display } });
      return;
    }

    // Held so the catch below can mark this exact bubble rather than guessing
    // at the last user message, which a queued send could have moved on from.
    const id = nextId();
    const at = Date.now();
    const token = sessionEpoch();
    set((st) => ({
      messages: [
        ...st.messages,
        { kind: 'user', id, text, displayText: opts?.display, at },
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
      if (stillOn(token)) noteActivity(get);
    } catch (err) {
      // Another conversation by now; this bubble is not on screen to mark.
      if (!stillOn(token)) return;
      // The socket went with the frame possibly delivered: let the reconnect
      // say whether the turn is running before calling the send a failure.
      if (err instanceof ConnectionLost) {
        set({ lostSubmit: { id, text, display: opts?.display, at } });
        return;
      }
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
      const { lostSubmit, running } = get();
      set(
        lostSubmit && !running
          ? { error: null, lostSubmit: null, messages: settleLostSubmit(current, messages, lostSubmit) }
          : { error: null },
      );
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
      vibrate('warn');
    } catch {
      // A turn that already finished rejects here; nothing to surface.
    }
  },

  /**
   * Answer the pending approval.
   *
   * The sheet is cleared first so the turn is not covered while the round trip
   * lands — and **put back if the call fails**, which is the half that was
   * missing. An `approval.request` blocks the agent until it is answered and
   * nothing re-emits it: a rejected `approval.respond` (a timeout, a socket
   * that went while the sheet was open) left the turn parked with the only
   * control that could release it gone from the screen. There is a recovery
   * path through `session.resume`'s `pending_approval`, but it only runs on a
   * *reconnect* — and the socket failing one call is not the same as the
   * socket dropping, so the common case reached it never.
   *
   * Restoring the same object keeps its `id`, which is what stops a revived
   * sheet from answering a request that has since been replaced.
   */
  respondApproval: async (choice, all = false) => {
    const { sessionId, approval } = get();
    if (!sessionId || !approval) return;
    const token = sessionEpoch();
    set({ approval: null });
    try {
      if (approval.srqId) {
        const live = await answerServerRequest(approval.srqId, { choice, all });
        if (!live && stillOn(token)) get().addNotice('That approval had already ended — the agent moved on without it.', 'info');
        return;
      }
      const requestId = (approval as { request_id?: unknown }).request_id;
      await hermes.call('approval.respond', {
        session_id: sessionId,
        choice,
        all,
        ...(typeof requestId === 'string' ? { request_id: requestId } : {}),
      });
    } catch (err) {
      // A sheet for a conversation no longer on screen must not reappear here.
      if (!stillOn(token)) return;
      set({
        error: err instanceof Error ? err.message : 'approval failed',
        // Only if nothing newer has arrived in the meantime.
        approval: get().approval ?? approval,
      });
    }
  },

  /**
   * Answer the pending clarify and let the parked turn continue.
   *
   * One response for the whole request: `{answer}` for a single question,
   * `{answers}` keyed by `qid` for a batch. An empty string is "skip". This
   * replaced one `clarify.respond` call per question, a method the backend no
   * longer has — per-question locking still exists (`clarify.lock`), but it is
   * for keeping early answers across a timeout, which a sheet answered in one
   * go has no use for.
   *
   * The sheet is cleared first. The turn resumes the moment the answer lands,
   * so holding a modal over the reply while awaiting the round trip would
   * cover the thing the person just asked for.
   */
  respondClarify: async (answers) => {
    const { sessionId, clarify } = get();
    if (!sessionId || !clarify) return;
    const token = sessionEpoch();
    set({ clarify: null });

    const batch = clarify.questions.some((q) => q.qid);
    const result = batch
      ? {
          answers: Object.fromEntries(
            clarify.questions.map((q) => [q.qid ?? '', answers[q.qid ?? ''] ?? '']),
          ),
        }
      : { answer: answers[''] ?? '' };

    try {
      const live = await answerServerRequest(clarify.requestId, result);
      /**
       * `expired` rather than an error: the question's wait already ended, so
       * the agent moved on without this. Saying so beats a silent no-op, since
       * the person just made a choice and would otherwise watch it change
       * nothing.
       */
      if (!live && stillOn(token)) get().addNotice('That question timed out — the agent moved on without an answer.', 'info');
    } catch (err) {
      /**
       * Put the question back. Same reasoning as `respondApproval`: the agent
       * is parked on it, and a cleared sheet after a failed send leaves no way
       * to finish answering and nothing on screen saying anything went wrong
       * beyond a banner.
       */
      if (!stillOn(token)) return;
      set({
        error: err instanceof Error ? err.message : 'Could not send that answer',
        clarify: get().clarify ?? clarify,
      });
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
    const token = sessionEpoch();
    try {
      const [usage, breakdown] = await Promise.all([
        hermes.call('session.usage', { session_id: sessionId }),
        hermes.call('session.context_breakdown', { session_id: sessionId }).catch(() => null),
      ]);
      // Another session's meter must not land on this one.
      if (!stillOn(token)) return;
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
