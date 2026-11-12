/**
 * `session.branch`: fork the live session into a new stored child.
 *
 * Shapes from `tui_gateway/contracts/sessions.py` (`SessionBranchParams`,
 * `SessionBranchResult`) and `tui_gateway/methods_session_branch.py`
 * (`_branch_live`). Three things about it:
 *
 *  - It answers with a **new live session** — a gateway handle *and* a stored
 *    id, the same pair `session.create` returns — plus the copied rows in the
 *    `session.history` projection, so the child can be shown without a second
 *    round trip. `parent` is the parent's stored id.
 *  - The child's row is written before the call returns (`_persist_branch`),
 *    unlike a `session.create` draft, so it can be resumed straight away.
 *  - `idempotency_key` makes a retry after a lost response return the *same*
 *    child rather than a second one (#65410), so the key is generated per
 *    intent and reused by a retry of it.
 *
 * It is one of the gateway's long handlers (built in a worker pool, agent
 * construction included), hence the long timeout.
 */
import * as z from 'zod/mini';
import { hermes } from '../ws/client';
import { HistoryMessageSchema, SessionInfoSchema } from '../ws/types';

export const BranchResultSchema = z.looseObject({
  session_id: z.string(),
  stored_session_id: z.string(),
  title: z.optional(z.nullable(z.string())),
  parent: z.optional(z.nullable(z.string())),
  message_count: z.optional(z.number()),
  messages: z.optional(z.array(HistoryMessageSchema)),
  info: z.optional(SessionInfoSchema),
});
export type BranchResult = z.infer<typeof BranchResultSchema>;

const BRANCH_TIMEOUT_MS = 60_000;

export async function branchSession(
  sessionId: string,
  count: number,
  idempotencyKey: string,
): Promise<BranchResult> {
  const raw = await hermes.call(
    'session.branch',
    { session_id: sessionId, count, idempotency_key: idempotencyKey },
    { timeoutMs: BRANCH_TIMEOUT_MS },
  );
  return BranchResultSchema.parse(raw);
}
