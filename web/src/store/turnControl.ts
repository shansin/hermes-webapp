/**
 * What a message sent *while a turn is running* does, and the side-channel
 * runs that never become the next message at all.
 *
 * The gateway runs one turn per session, and a send mid-turn used to have one
 * meaning here: hold it locally and fire it when the turn ends (`queued` in
 * `store/session.ts`). Hermes offers two more, and both are better answers to
 * "no, not like that" than waiting for the agent to finish the wrong thing:
 *
 *  - **Steer** — `session.steer`. The text is handed to the agent after its
 *    current tool batch, without interrupting anything (`AIAgent.steer`,
 *    `agent/interrupt_control.py`). Answers `{status: "queued"}` when accepted
 *    and `{status: "rejected"}` when the session is idle or the agent refused
 *    — a *successful* reply, so an unread status is a guidance that silently
 *    went nowhere.
 *  - **Redirect** — `session.redirect`. Cancels only the model request in
 *    flight; finished tool work stays, the partial reply becomes context, the
 *    text is appended as a real user message and the turn carries on from
 *    there. Mid-tool it degrades to a steer (Hermes never kills a tool for
 *    this). `{status: "redirected"}` in place; `"queued"` when the turn was
 *    still being built or compressing, so the backend made it the next turn
 *    instead; `"rejected"` when the reply finished first.
 *
 * Both are text-only on the backend's side (a media payload falls through to
 * its queue path), so a send carrying a picture always takes the local queue.
 * Anything not accepted falls back to that queue too, and says so in a toast:
 * the message is never dropped, and the person learns it did not land the way
 * they chose. Mirrors `handleBusyInput` in Hermes' own TUI.
 *
 * The mode is a per-device preference, hydrated synchronously like
 * `store/ui.ts` so the switch never paints the wrong choice for a frame.
 */
import { create } from 'zustand';
import { hermes, CONTROL_TIMEOUT_MS } from '../ws/client';
import { sessionEpoch, useSession } from './session';
import { useUi } from './ui';
import { buzz } from '../lib/haptics';

export type SendMode = 'queue' | 'steer' | 'redirect';

export const SEND_MODES: readonly { id: SendMode; label: string; hint: string }[] = [
  { id: 'queue', label: 'Queue', hint: 'Sends when this turn finishes' },
  { id: 'steer', label: 'Steer', hint: 'Slips in after the current step, nothing stops' },
  { id: 'redirect', label: 'Redirect', hint: 'Cuts the reply short, keeps the work, answers this' },
];

const MODE_KEY = 'hermes.sendMode';

const isMode = (v: unknown): v is SendMode => v === 'queue' || v === 'steer' || v === 'redirect';

function readMode(): SendMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return isMode(v) ? v : 'queue';
  } catch {
    return 'queue';
  }
}

interface SendModeState {
  mode: SendMode;
  setMode: (mode: SendMode) => void;
}

export const useSendMode = create<SendModeState>((set) => ({
  mode: readMode(),
  setMode: (mode) => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
    set({ mode });
  },
}));

/** What became of a mid-turn send — returned for tests, the UI reads the store. */
export type SendOutcome = 'queued' | 'steered' | 'redirected' | 'queued-next-turn' | 'fell-back';

const VERB: Record<Exclude<SendMode, 'queue'>, string> = { steer: 'Steer', redirect: 'Redirect' };

/**
 * Send `text` into a running turn the way `mode` says.
 *
 * `opts.display` is only ever set when pictures ride along, and those must
 * queue (see the header), so its presence forces the local queue.
 */
export async function sendWhileRunning(
  mode: SendMode,
  text: string,
  opts?: { display?: string },
): Promise<SendOutcome> {
  const session = useSession.getState();
  const { sessionId } = session;
  if (!sessionId || !text.trim()) return 'queued';

  if (mode === 'queue' || opts?.display) {
    await session.submitPrompt(text, opts);
    return 'queued';
  }

  const token = sessionEpoch();
  const verb = VERB[mode];
  const toast = useUi.getState().toast;

  /** Not taken: hold it like any mid-turn send, and say that is what happened. */
  const fallBack = async (why: string): Promise<SendOutcome> => {
    if (sessionEpoch() !== token) return 'fell-back';
    const { running, submitPrompt } = useSession.getState();
    toast(
      running
        ? `${why} — queued for after this turn`
        : `${why} — the turn had finished, sent as a new message`,
      'warn',
    );
    buzz('warn');
    await submitPrompt(text, opts);
    return 'fell-back';
  };

  let status: unknown;
  try {
    const res = await hermes.call<{ status?: unknown } | null>(
      mode === 'steer' ? 'session.steer' : 'session.redirect',
      { session_id: sessionId, text },
      { timeoutMs: CONTROL_TIMEOUT_MS },
    );
    status = res?.status;
  } catch (err) {
    const reason = err instanceof Error && err.message ? err.message : 'failed';
    return fallBack(`${verb} failed (${reason})`);
  }

  if (sessionEpoch() !== token) return 'fell-back';
  const { addNotice } = useSession.getState();

  // `session.steer` reports an accepted steer as "queued": it waits for the
  // agent's next step, not for the next turn.
  if (mode === 'steer' && status === 'queued') {
    addNotice(text, 'info', 'Steer — reaches the agent after its current step');
    return 'steered';
  }
  if (mode === 'redirect' && status === 'redirected') {
    addNotice(text, 'info', 'Redirect — the reply picks up from here');
    return 'redirected';
  }
  if (mode === 'redirect' && status === 'queued') {
    addNotice(text, 'info', 'Queued by Hermes — the turn was not ready to redirect, this runs next');
    return 'queued-next-turn';
  }
  return fallBack(`${verb} not accepted`);
}

/**
 * Run `text` as a background task beside the conversation (`prompt.background`).
 *
 * A detached agent runs it on its own thread and replies `{task_id}` at once;
 * the answer arrives much later as `background.complete {task_id, text}` on
 * this session (`_spawn_side_agent`, `tui_gateway/methods_prompt.py`). The
 * session store does not fold that event — it belongs to no turn — and the
 * app-wide toast only says *that* it finished, so this waits for its own
 * task id and drops the answer into the transcript, provided the same
 * conversation is still on screen. A task that never reports keeps a single
 * listener for the life of the page, which is cheaper than guessing a timeout
 * for work that can legitimately run for an hour.
 */
export async function startBackground(sessionId: string, text: string): Promise<string> {
  const prompt = text.trim();
  const res = await hermes.call(
    'prompt.background',
    { session_id: sessionId, text: prompt },
    { timeoutMs: CONTROL_TIMEOUT_MS },
  );
  return watchBackground(res, prompt);
}

/**
 * The listening half of `startBackground`, for a `prompt.background` answer
 * obtained some other way (the `/bg` command calls through the slash runner).
 * Returns the task id, or '' when the reply carried none.
 */
export function watchBackground(result: unknown, prompt: string): string {
  const taskId = (result as { task_id?: unknown } | null)?.task_id;
  if (typeof taskId !== 'string' || !taskId) return '';
  const token = sessionEpoch();
  const label = `Background — ${prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt}`;
  const off = hermes.onEvent(({ type, payload }) => {
    if (type !== 'background.complete') return;
    const p = (payload ?? {}) as { task_id?: unknown; text?: unknown };
    if (p.task_id !== taskId) return;
    off();
    if (sessionEpoch() !== token) return;
    const answer = typeof p.text === 'string' ? p.text : '';
    useSession
      .getState()
      .addNotice(answer || '(no answer)', answer.startsWith('error: ') ? 'error' : 'info', label);
  });
  return taskId;
}
