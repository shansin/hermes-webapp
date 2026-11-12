/**
 * Answering an approval from the lock screen.
 *
 * An approval blocks the agent's turn until somebody answers it, and the
 * "waiting for you" banner (`push/sessions.ts`) used to be able to do only one
 * thing about that: open the app, which then has to cold-start, reconnect,
 * resume the session and raise the sheet before the answer can be given. For
 * "yes, run that once", that is a lot of phone.
 *
 * ## Why the proxy can answer at all
 *
 * The approval reaches a client as a server→client request on the socket that
 * owns the session — which the proxy's listener never does, and must never
 * try to (it would take the session away from the phone; see the header of
 * `push/sessions.ts`). But that request is only the *delivery*. The wait itself
 * is owned by the approval tool's queue (`tools/approval.py`,
 * `_gateway_queues`), and `approval.respond` resolves that queue entry from any
 * socket: it looks the session up by its live handle, falls back to the
 * `request_id` against every live session's pending approvals and then to the
 * stored id (`_approval_respond_session_fallback` in
 * `tui_gateway/methods_prompt.py`). Resolving the entry withdraws the request
 * from the owning client with `request.cancel` (`_emit_approval_request` in
 * `tui_gateway/server.py`: "the client answered by RPC, another surface
 * resolved it"), so an app that is open meanwhile drops its sheet rather than
 * showing a question that has been answered. Hermes' own hosted-room bridge
 * answers exactly this way (`tui_gateway/hosted_room_server_rpc.py`).
 *
 * Nothing here advertises `server_requests` on the listener's socket, which
 * would make it a candidate to *receive* approvals it cannot render — it only
 * makes an ordinary RPC call.
 *
 * ## Only the two safe answers
 *
 * The banner offers "Approve once" and "Deny" and the route accepts nothing
 * else. `session` and `always` widen what the agent may do without asking
 * again; that decision deserves the full sheet with the command in front of
 * you, which a lock-screen banner (deliberately carrying no command text —
 * `approval.pending` returns it unredacted) is not.
 */
import { log } from '../log.js';
import { callGateway } from './rpc.js';

export type ApprovalChoice = 'once' | 'deny';

export type ApprovalAnswer =
  /** The choice reached the waiting agent. */
  | { status: 'resolved'; resolved: number }
  /** Nothing was pending any more — answered elsewhere, timed out, or interrupted. */
  | { status: 'expired' }
  /** The listener's socket is down or the backend did not answer. */
  | { status: 'unreachable' };

interface LiveRow {
  id?: unknown;
  session_key?: unknown;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * The session's current live handle, or null.
 *
 * `approval.respond` would find the session from its stored key alone (the
 * fallback above), but only after rejecting the stored key as a stale handle —
 * which Hermes logs as a warning on every call. Looking the handle up first is
 * one cheap call and keeps that log meaning what it says.
 */
async function liveHandle(sessionKey: string): Promise<string | null> {
  const body = await callGateway<{ sessions?: unknown[] }>('session.active_list', {});
  for (const raw of body?.sessions ?? []) {
    const row = raw as LiveRow;
    if (str(row.session_key) === sessionKey) return str(row.id);
  }
  return null;
}

/**
 * Deliver one decision to the agent waiting on `sessionKey`.
 *
 * `requestId` pins the answer to the approval the banner described; without
 * it the oldest pending one is answered, which is the same thing whenever only
 * one is waiting.
 */
export async function answerApproval(
  sessionKey: string,
  choice: ApprovalChoice,
  requestId: string | null,
): Promise<ApprovalAnswer> {
  const handle = await liveHandle(sessionKey);
  const result = await callGateway<{ resolved?: unknown }>('approval.respond', {
    session_id: handle ?? sessionKey,
    choice,
    all: false,
    ...(requestId ? { request_id: requestId } : {}),
  });
  if (!result) return { status: 'unreachable' };

  const resolved = typeof result.resolved === 'number' ? result.resolved : 0;
  log.info(`Approval ${choice} from a notification: ${sessionKey} (${resolved} resolved).`);
  return resolved > 0 ? { status: 'resolved', resolved } : { status: 'expired' };
}

/**
 * The approval a waiting session is blocked on, for the banner — or null when
 * it is waiting on something else (a clarify, a secret) or cannot be asked.
 *
 * `session.active_list` folds every kind of wait into one `waiting`, so this is
 * the call that tells an approval apart. Addressed by the live handle, which
 * the caller has from the same listing.
 */
export async function pendingApproval(
  liveId: string,
): Promise<{ requestId: string | null; description: string | null } | null> {
  const body = await callGateway<{ approvals?: unknown[] }>('approval.pending', { session_id: liveId });
  const first = (Array.isArray(body?.approvals) ? body.approvals[0] : null) as
    | { request_id?: unknown; description?: unknown; tool_name?: unknown }
    | null
    | undefined;
  if (!first) return null;
  return {
    requestId: str(first.request_id),
    description: str(first.description) ?? str(first.tool_name),
  };
}
