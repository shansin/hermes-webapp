/**
 * Server→client requests the session store has accepted and not yet answered.
 *
 * Separate from `session.ts` because it holds no store state: a map of the
 * `respond` capabilities bound to the sockets the requests arrived on, and the
 * one function that answers through them or, failing that, over the socket
 * that is live now. The store routes requests in and clears them on
 * `request.cancel`; this module only keeps and answers them.
 */
import { hermes, CONTROL_TIMEOUT_MS, type ServerRequest } from '../ws/client';

/**
 * Server requests this client has accepted and not yet answered, by `srq-` id.
 *
 * Held outside the store because what is held is a capability — the
 * `respond` bound to the socket the request arrived on — not something to
 * render. A request for a conversation other than the one on screen is held
 * here unanswered rather than declined: declining withdraws it and fails the
 * agent's tool call, while holding it leaves it in the session's
 * `open_requests` for the resume that opens that conversation again.
 */
export const liveRequests = new Map<string, ServerRequest>();

/**
 * Answer a server request: the response frame if its socket is still live,
 * otherwise `request.answer` over the one that is. Resolves to false when the
 * backend says the request already ended.
 */
export async function answerServerRequest(id: string, result: Record<string, unknown>): Promise<boolean> {
  const req = liveRequests.get(id);
  liveRequests.delete(id);
  if (req?.respond(result)) return true;
  const res = await hermes.call<{ status?: string }>(
    'request.answer',
    { id, result },
    { timeoutMs: CONTROL_TIMEOUT_MS },
  );
  return res?.status !== 'expired';
}
