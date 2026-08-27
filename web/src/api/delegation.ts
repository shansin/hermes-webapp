/**
 * Delegated children that are running right now.
 *
 * The gap this closes: a **background** delegation is invisible to everything
 * else in the app. `delegate_task` in background mode returns
 * `{status: "dispatched", count: 3}` and detaches — the children get no
 * session rows (so `/api/sessions` cannot see them, and neither can the
 * Activity pane, which leads with session rows for exactly this case), and
 * `tools/async_delegation.py` relays no `subagent.*` events (so the transcript
 * gets no cards). Three researchers ran for minutes with one `delegate_task`
 * tool card as the only sign of them, and nothing arrived until
 * `background.complete` fired at the end. A *synchronous* delegation does emit
 * the events and does get cards, which is what made the difference look like a
 * bug rather than two code paths.
 *
 * `delegation.status` is the registry both paths write to. It answers with the
 * goal, the tool the child is inside, how many it has run, and the parent
 * session that owns it — `list_active_subagents()` in `tools/delegate_tool.py`,
 * exposed as a gateway method.
 *
 * **Socket-only, unlike the rest of the Activity data.** There is no REST
 * route for it, and it reads the gateway's process memory rather than a store:
 * a running subagent does not outlive the process, so there is nothing for a
 * cached copy to be right about. The consequence to know is that these rows
 * are absent — not stale — while the socket is down, which is why the pane
 * still leads with the sources that survive it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { hermes, CONTROL_TIMEOUT_MS } from '../ws/client';
import { useUi } from '../store/ui';

/**
 * One live child. Every field beyond the id is optional on purpose: the
 * registry is assembled from whatever the child has reported so far, so a
 * subagent that has not called a tool yet carries no `last_tool` and one
 * dispatched a moment ago may not have its `goal` echoed back.
 */
export const ActiveSubagentSchema = z
  .object({
    subagent_id: z.string(),
    parent_id: z.string().nullish(),
    depth: z.number().nullish(),
    goal: z.string().nullish(),
    delegation_id: z.string().nullish(),
    model: z.string().nullish(),
    /** Epoch seconds. */
    started_at: z.number().nullish(),
    status: z.string().nullish(),
    tool_count: z.number().nullish(),
    /** The session whose turn dispatched this child. */
    owner_agent_session_id: z.string().nullish(),
    last_tool: z.string().nullish(),
  })
  .passthrough();
export type ActiveSubagent = z.infer<typeof ActiveSubagentSchema>;

export const DelegationStatusSchema = z
  .object({
    active: z.array(ActiveSubagentSchema).default([]),
    paused: z.boolean().optional(),
    max_spawn_depth: z.number().optional(),
    max_concurrent_children: z.number().optional(),
  })
  .passthrough();
export type DelegationStatus = z.infer<typeof DelegationStatusSchema>;

export async function fetchDelegationStatus(): Promise<DelegationStatus> {
  const raw = await hermes.call('delegation.status', {}, { timeoutMs: CONTROL_TIMEOUT_MS });
  return DelegationStatusSchema.parse(raw);
}

/** Still working, as opposed to winding down. Unknown counts as running. */
export function isRunning(child: ActiveSubagent): boolean {
  const status = (child.status ?? '').toLowerCase();
  return status !== 'done' && status !== 'complete' && status !== 'completed' && status !== 'error';
}

export const DELEGATION_KEY = ['delegation', 'status'] as const;

/**
 * Poll rates, chosen the way `activePollMs` chooses its own: fast enough that
 * a child's tool changing is visible, slow enough that an idle install is not
 * asking a question whose answer is "nothing" every few seconds. Nothing
 * running is the common case and gets the slow rate.
 *
 * A running child is *not* polled harder when the socket is live, unlike
 * sessions: no event announces a background child's progress, so the poll is
 * the only thing that can notice it, socket or no socket.
 */
function pollMs(data: DelegationStatus | undefined): number {
  return (data?.active ?? []).some(isRunning) ? 6_000 : 30_000;
}

export function useDelegations(enabled = true) {
  /* From the store rather than `hermes.state`: this has to re-render when the
     socket comes back, and the client's own field is not reactive. */
  const socketLive = useUi((s) => s.connection) === 'open';
  return useQuery({
    queryKey: DELEGATION_KEY,
    queryFn: fetchDelegationStatus,
    enabled: enabled && socketLive,
    refetchInterval: (q) => pollMs(q.state.data),
    // A delegation that ended between polls should stop being shown, not be
    // held over from the last answer while the query refetches.
    staleTime: 0,
  });
}

/**
 * Stop one child without touching its siblings.
 *
 * The batch keeps running: `subagent.interrupt` resolves this id in the
 * delegation registry and interrupts that agent alone, which is the whole
 * reason it takes an id rather than a session. `found: false` means the child
 * had already finished — worth saying, because the row is about to vanish and
 * "nothing happened" would otherwise look like a failure.
 */
export async function interruptSubagent(subagentId: string): Promise<{ found: boolean }> {
  const raw = await hermes.call<{ found?: boolean }>(
    'subagent.interrupt',
    { subagent_id: subagentId },
    { timeoutMs: CONTROL_TIMEOUT_MS },
  );
  return { found: raw?.found === true };
}

/**
 * Redirect a child mid-run, without stopping it.
 *
 * The text is appended to the child's last tool result at its next iteration
 * boundary, so the in-flight call is never cut. **Queued is not delivered**:
 * a child already past its final tool batch has no boundary left to drain
 * into, and the gateway reports that as `missed_steer` on the parent's
 * completion entry rather than failing here. So the honest thing to tell
 * someone is that it was sent, not that it was applied.
 *
 * `sessionId` is the gateway handle of the conversation doing the steering,
 * and it is not optional: the method resolves steering authority from it
 * (`_current_session_steer_authority`) and answers `rejected` — not an error —
 * when the caller does not own the child. Which is also why a rejection is
 * surfaced rather than swallowed: nothing else on screen would change.
 */
export async function steerSubagent(
  subagentId: string,
  text: string,
  sessionId: string,
): Promise<{ queued: boolean }> {
  const raw = await hermes.call<{ status?: string }>(
    'subagent.steer',
    { subagent_id: subagentId, text, session_id: sessionId },
    { timeoutMs: CONTROL_TIMEOUT_MS },
  );
  return { queued: raw?.status === 'queued' };
}

/** Both controls change the registry, so both refresh it. */
export function useSubagentControls() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: DELEGATION_KEY });

  return {
    interrupt: useMutation({
      mutationFn: (subagentId: string) => interruptSubagent(subagentId),
      onSettled: refresh,
    }),
    steer: useMutation({
      mutationFn: ({
        subagentId,
        text,
        sessionId,
      }: {
        subagentId: string;
        text: string;
        sessionId: string;
      }) => steerSubagent(subagentId, text, sessionId),
      onSettled: refresh,
    }),
  };
}
