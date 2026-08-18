/**
 * A delegated child agent.
 *
 * Distinct from a tool card on purpose — a subagent is another agent doing its
 * own reasoning, not a single call. The indented left border says "this
 * happened one level down", which is the whole point of showing it at all.
 *
 * There's no expandable body: the gateway never relays the child's reply text
 * to the parent session (only its goal, tools, and a final summary), so there
 * is nothing further to reveal.
 */
import { memo } from 'react';
import { formatTokens } from '../shared/misc';
import type { ChatMessage } from '../../store/session';

type Subagent = Extract<ChatMessage, { kind: 'subagent' }>;

export const SubagentCard = memo(function SubagentCard({ msg }: { msg: Subagent }) {
  const running = msg.status === 'running';

  return (
    <div className={`subagent${running ? ' subagent--running' : ''}`}>
      <div className="subagent__head">
        <span className="subagent__icon" aria-hidden>
          ⑃
        </span>
        <div className="subagent__main">
          <div className="subagent__goal">{msg.goal}</div>
          <div className="subagent__meta">
            <span>{running ? 'Delegated agent' : 'Delegated agent · done'}</span>
            {msg.model && <span>{msg.model}</span>}
            {msg.depth != null && msg.depth > 0 && <span>depth {msg.depth}</span>}
            {msg.durationS != null && <span>{msg.durationS.toFixed(1)}s</span>}
            {msg.tokens != null && <span>{formatTokens(msg.tokens)} tok</span>}
          </div>
        </div>
        {running && <span className="tool__pulse" />}
      </div>

      {running && msg.activity && <div className="subagent__activity">{msg.activity}</div>}

      {msg.summary && <div className="subagent__summary">{msg.summary}</div>}

      {msg.filesWritten && msg.filesWritten.length > 0 && (
        <div className="subagent__files">
          {msg.filesWritten.length} file{msg.filesWritten.length === 1 ? '' : 's'} written
          <div className="subagent__filelist">{msg.filesWritten.join(', ')}</div>
        </div>
      )}
    </div>
  );
});
