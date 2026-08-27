/**
 * The delegated children this conversation has running right now.
 *
 * A **background** delegation leaves no trace in the transcript. It returns
 * `{status: "dispatched", count: 3}`, the parent's turn ends immediately, and
 * the children emit no `subagent.*` events — so the store never builds a
 * `subagent` card for them and the conversation shows one `delegate_task` tool
 * call while three agents work for several minutes. Nothing arrives until
 * `background.complete` at the very end. This is that missing half, read from
 * the registry over `delegation.status` and filtered to this session.
 *
 * It sits at the end of the transcript rather than under the `delegate_task`
 * card, for two reasons: the card can be a long way up the scroll by the time
 * you come back to look, and a replayed transcript loses the tool result that
 * would say which `delegation_id` the card started — so anchoring to it would
 * put the block in the right place only in the session that opened it.
 *
 * Cards the store already built are skipped, which is what keeps a
 * *synchronous* delegation from being drawn twice: those do emit events, and
 * `SubagentCard` is the better rendering of one because it also holds the
 * summary the child ends with.
 *
 * Both controls act on one child, not the batch — that is the point of them.
 * They are here rather than on the Activity pane deliberately: that screen is
 * read-only by design, and stopping or redirecting an agent is a decision that
 * needs the conversation it belongs to.
 */
import { memo, useState } from 'react';
import {
  isRunning,
  useDelegations,
  useSubagentControls,
  type ActiveSubagent,
} from '../../api/delegation';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { relTime } from '../shared/misc';
import { buzz } from '../../lib/haptics';

export const LiveDelegations = memo(function LiveDelegations() {
  const storedSessionId = useSession((s) => s.storedSessionId);
  const messages = useSession((s) => s.messages);
  const { data } = useDelegations();

  const children = (data?.active ?? []).filter(
    (c) =>
      isRunning(c) &&
      // Ours. A child names the session whose turn dispatched it, and one
      // socket carries every conversation — without this the block would show
      // another chat's researchers.
      Boolean(storedSessionId) &&
      c.owner_agent_session_id === storedSessionId &&
      // Already drawn from its own events.
      !messages.some(
        (m) => m.kind === 'subagent' && m.agentId === c.subagent_id && m.status === 'running',
      ),
  );

  if (children.length === 0) return null;

  return (
    <div className="delegation">
      <div className="delegation__head">
        {children.length} delegated agent{children.length === 1 ? '' : 's'} running in the
        background
      </div>
      {children.map((child) => (
        <LiveChild key={child.subagent_id} child={child} />
      ))}
    </div>
  );
});

function LiveChild({ child }: { child: ActiveSubagent }) {
  const [steering, setSteering] = useState(false);
  const [text, setText] = useState('');
  const sessionId = useSession((s) => s.sessionId);
  const toast = useUi((s) => s.toast);
  const { interrupt, steer } = useSubagentControls();

  const tools = child.tool_count ?? 0;
  const busy = interrupt.isPending || steer.isPending;

  const send = async () => {
    const body = text.trim();
    if (!body || !sessionId) return;
    try {
      const { queued } = await steer.mutateAsync({
        subagentId: child.subagent_id,
        text: body,
        sessionId,
      });
      setText('');
      setSteering(false);
      /**
       * "Sent", never "applied". The text lands at the child's next iteration
       * boundary, and one already past its last tool batch has nowhere to put
       * it — the gateway reports that afterwards, on the parent's completion
       * entry, so promising delivery here would be a promise this cannot see
       * kept.
       */
      toast(queued ? 'Sent to the agent' : 'That agent would not take it', queued ? 'info' : 'warn');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not steer that agent', 'error');
    }
  };

  return (
    <div className="subagent subagent--running delegation__child">
      <div className="subagent__head">
        <span className="subagent__icon" aria-hidden>
          ⑃
        </span>
        <div className="subagent__main">
          <div className="subagent__goal">{child.goal || 'Delegated agent'}</div>
          <div className="subagent__meta">
            <span>{child.last_tool ? `running ${child.last_tool}` : 'starting up'}</span>
            {tools > 0 && (
              <span>
                {tools} tool{tools === 1 ? '' : 's'}
              </span>
            )}
            {child.started_at != null && <span>{relTime(child.started_at)}</span>}
            {child.model && <span>{child.model}</span>}
          </div>
        </div>
        <span className="tool__pulse" />
      </div>

      <div className="delegation__actions">
        <button
          className="btn btn--ghost btn--sm"
          disabled={busy}
          onClick={() => {
            buzz('tap');
            setSteering((v) => !v);
          }}
        >
          {steering ? 'Cancel' : 'Steer'}
        </button>
        <button
          className="btn btn--ghost btn--sm delegation__stop"
          disabled={busy}
          onClick={async () => {
            buzz('warn');
            try {
              const { found } = await interrupt.mutateAsync(child.subagent_id);
              /* A child that had already finished is not a failure, but it is
                 also not a stop — and the row is about to disappear either
                 way, which on its own would read as "it worked". */
              if (!found) toast('That agent had already finished', 'info');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Could not stop that agent', 'error');
            }
          }}
        >
          Stop
        </button>
      </div>

      {steering && (
        <div className="delegation__steer">
          <textarea
            className="delegation__input"
            rows={2}
            autoFocus
            value={text}
            placeholder="Redirect this agent — it keeps working"
            onChange={(e) => setText(e.target.value)}
            /* Same rule as the composer: Enter is a newline, Ctrl/Cmd+Enter
               sends. A redirect is a sentence more often than a word. */
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            className="btn btn--sm"
            disabled={!text.trim() || steer.isPending}
            onClick={() => void send()}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
