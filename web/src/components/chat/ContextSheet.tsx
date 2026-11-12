/**
 * Context-window breakdown: where the tokens actually went.
 *
 * Also the place to compact a conversation, since running out of context is
 * the problem this sheet is opened to diagnose — and the home for the turn
 * controls that previously lived only behind slash commands (`/save`,
 * `/title`, `/undo`, `/compress`, `/goal`, `/bg`, `/rollback`, `/retry`,
 * `/reload-mcp`, `/reload-skills`): each rendered structured output into the
 * transcript as text, with no button anywhere. Approvals are not here: the
 * mode is global and lives once, in `ModelSheet`.
 *
 * Queue is not here any more. As a button it ran `/queue` with no prompt and
 * told you to type one next, and queueing is now the composer's own mid-turn
 * send mode, next to Steer and Redirect. Background kept its place but takes
 * its prompt inline, for the same reason.
 */
import { useEffect, useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { useSession } from '../../store/session';
import { useUi, openCheckpoints } from '../../store/ui';
import {
  compressSession,
  saveSession,
  titleSession,
  undoTurns,
  askSideQuestion,
} from '../../api/gateway';
import { execCommand } from '../../api/commands';
import { formatTokens } from '../shared/misc';
import { buzz } from '../../lib/haptics';
import { describeMcpReload, MCP_CONFIRM_TEXT, reloadMcp, reloadSkills } from '../../lib/reloads';
import { startBackground } from '../../store/turnControl';

/** The gateway returns CSS variables the dashboard defines; map to our tokens. */
const CATEGORY_COLOR: Record<string, string> = {
  system_prompt: '#8b7fd4',
  tool_definitions: '#4dabf7',
  subagent_definitions: '#63c5b0',
  memory: '#ffbf00',
  conversation: '#4caf50',
  files: '#ff8c69',
};

export function ContextSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const usage = useSession((s) => s.usage);
  const breakdown = useSession((s) => s.contextBreakdown);
  const sessionId = useSession((s) => s.sessionId);
  const info = useSession((s) => s.info);
  const running = useSession((s) => s.running);
  const addNotice = useSession((s) => s.addNotice);
  const refreshUsage = useSession((s) => s.refreshUsage);
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState('');
  const [title, setTitle] = useState('');
  const [action, setAction] = useState<string | null>(null);

  useEffect(() => {
    if (open) void refreshUsage();
  }, [open, refreshUsage]);

  const max = breakdown?.context_max ?? usage?.context_max ?? 0;
  const used = breakdown?.context_used ?? usage?.context_used ?? 0;
  const pct = max ? Math.min(100, (used / max) * 100) : 0;

  const compact = async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    buzz('tap');
    try {
      const topic = focus.trim();
      await compressSession(sessionId, topic || undefined);
      addNotice(
        topic ? `Context compressed — kept focus on “${topic}”.` : 'Context compressed.',
        'info',
        '/compress',
      );
      toast('Conversation compacted', 'success');
      setFocus('');
      void refreshUsage();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Compaction failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Run a turn control and report it in the transcript, not a toast: the
   * answer belongs to the conversation, and a toast is gone before a long
   * `/status` can be read. Mirrors `useSlashRunner`'s exec path.
   */
  const runTurn = async (name: string, fn: () => Promise<string>) => {
    if (!sessionId || action) return;
    setAction(name);
    buzz('tap');
    try {
      addNotice(await fn(), 'info', name);
    } catch (err) {
      addNotice(err instanceof Error ? err.message : 'command failed', 'error', name);
      buzz('warn');
    } finally {
      setAction(null);
    }
  };

  const runExec = async (command: string, arg = '') => {
    if (!sessionId || action) return;
    setAction(command);
    buzz('tap');
    try {
      const { output, warning, dispatch } = await execCommand(sessionId, command, arg);
      if (warning) addNotice(warning, 'error', command);
      if (dispatch) {
        if (dispatch.notice) addNotice(dispatch.notice, 'info', command);
        else if (dispatch.message) addNotice(dispatch.display || dispatch.message, 'info', command);
        else addNotice(dispatch.output?.trim() || '(no output)', 'info', command);
      } else {
        addNotice(output?.trim() || '(no output)', 'info', command);
      }
    } catch (err) {
      addNotice(err instanceof Error ? err.message : 'command failed', 'error', command);
      buzz('warn');
    } finally {
      setAction(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Context window">
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7, fontSize: 'var(--type-body-md)' }}>
          <span style={{ color: 'var(--text-dim)' }}>
            {used.toLocaleString()} / {max.toLocaleString()} tokens
          </span>
          <strong style={{ color: pct > 85 ? 'var(--warn)' : 'var(--text)' }}>
            {Math.round(pct)}%
          </strong>
        </div>

        {/* Stacked bar of the categories, in the order Hermes reports them. */}
        <div
          style={{
            height: 12,
            borderRadius: 999,
            background: 'var(--bg-elev-2)',
            overflow: 'hidden',
            display: 'flex',
          }}
        >
          {breakdown?.categories.map((c) => (
            <div
              key={c.id}
              style={{
                width: `${max ? (c.tokens / max) * 100 : 0}%`,
                background: CATEGORY_COLOR[c.id] ?? 'var(--text-faint)',
              }}
              title={`${c.label}: ${c.tokens.toLocaleString()}`}
            />
          ))}
        </div>
      </div>

      {breakdown?.categories.map((c) => (
        <div
          key={c.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '8px 0',
            borderBottom: '1px solid var(--border-soft)',
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              background: CATEGORY_COLOR[c.id] ?? 'var(--text-faint)',
              flexShrink: 0,
            }}
          />
          <span style={{ flex: 1, fontSize: 'var(--type-body-md)' }}>{c.label}</span>
          <span style={{ color: 'var(--text-dim)', fontSize: 'var(--type-detail)', fontFamily: 'var(--mono)' }}>
            {formatTokens(c.tokens)}
          </span>
        </div>
      ))}

      {usage && (
        <div style={{ marginTop: 14, fontSize: 'var(--type-detail)', color: 'var(--text-faint)' }}>
          {usage.calls != null && <div>API calls this session: {usage.calls}</div>}
          {usage.compressions ? <div>Compactions: {usage.compressions}</div> : null}
          {usage.model && <div>Model: {usage.model}</div>}
          {info?.model && info.model !== usage.model && <div>Live model: {info.model}</div>}
        </div>
      )}

      <input
        className="field"
        style={{ marginTop: 12 }}
        placeholder="Compact keeping focus on… (optional)"
        value={focus}
        onChange={(e) => setFocus(e.target.value)}
        aria-label="Compaction focus topic"
      />
      <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={compact} disabled={busy || !sessionId}>
        {busy ? 'Compacting…' : 'Compact conversation'}
      </button>

      {sessionId && (
        <>
          <div className="group-head" style={{ marginTop: 18 }}>
            TURN
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn--sm"
              style={{ flex: 1 }}
              disabled={action != null}
              onClick={() => void runTurn('/save', () => saveSession(sessionId))}
            >
              {action === '/save' ? 'Saving…' : 'Save'}
            </button>
            <button
              className="btn btn--sm"
              style={{ flex: 1 }}
              disabled={action != null || running}
              onClick={() => void runTurn('/undo', () => undoTurns(sessionId).then((t) => t || 'Nothing to undo.'))}
              title={running ? 'Interrupt the running turn first' : 'Drop the last exchange'}
            >
              {action === '/undo' ? 'Undoing…' : 'Undo turn'}
            </button>
            <button
              className="btn btn--sm"
              style={{ flex: 1 }}
              disabled={action != null}
              onClick={() => void runExec('/retry')}
            >
              {action === '/retry' ? 'Retrying…' : 'Retry'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              className="field"
              style={{ flex: 1 }}
              placeholder="Rename this session…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Session title"
            />
            <button
              className="btn btn--sm"
              disabled={action != null || !title.trim()}
              onClick={() =>
                void runTurn('/title', () =>
                  titleSession(sessionId, title.trim()).then((msg) => {
                    setTitle('');
                    return msg;
                  }),
                )
              }
            >
              {action === '/title' ? '…' : 'Set'}
            </button>
          </div>

          <div className="group-head" style={{ marginTop: 18 }}>
            DIRECTOR
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button className="btn btn--sm" disabled={action != null} onClick={() => void runExec('/status')}>
              Status
            </button>
            <button className="btn btn--sm" disabled={action != null} onClick={() => void runExec('/goal')}>
              Goal
            </button>
            <button className="btn btn--sm" disabled={action != null} onClick={() => void runExec('/agents')}>
              Agents
            </button>
            <button className="btn btn--sm" disabled={action != null} onClick={() => {
                // The browsable sheet, not `/rollback`'s text dump.
                onClose();
                openCheckpoints();
              }}>
              Checkpoints
            </button>
          </div>
          <SideQuestion sessionId={sessionId} />
          <Background sessionId={sessionId} />
          <p style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', margin: '10px 2px 0', lineHeight: 1.5 }}>
            Answers land in the transcript. To queue, steer or redirect a
            running turn, type in the composer while it works.
          </p>

          <div className="group-head" style={{ marginTop: 18 }}>
            TOOLS
          </div>
          <Reloads sessionId={sessionId} />
        </>
      )}
    </Sheet>
  );
}

/**
 * A question about the conversation that does not become part of it.
 *
 * `prompt.btw` answers off a snapshot with a detached agent, so it works while
 * a turn is still running — the one moment a normal message would only queue —
 * and it leaves the history and the prompt cache exactly as they were. The
 * answer comes back on its own as `btw.complete` and lands as a notice.
 */
function SideQuestion({ sessionId }: { sessionId: string | null }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const addNotice = useSession((s) => s.addNotice);

  const ask = async () => {
    const q = text.trim();
    if (!sessionId || !q || sending) return;
    setSending(true);
    buzz('tap');
    try {
      await askSideQuestion(sessionId, q);
      setText('');
    } catch (err) {
      addNotice(err instanceof Error ? err.message : 'Could not ask that', 'error', 'Side question');
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
      <input
        className="field"
        style={{ flex: 1, minWidth: 0 }}
        placeholder="Ask on the side — not added to the chat"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void ask();
        }}
      />
      <button className="btn btn--sm" disabled={!sessionId || !text.trim() || sending} onClick={() => void ask()}>
        {sending ? 'Asking…' : 'Ask'}
      </button>
    </div>
  );
}

/**
 * A prompt for a detached agent, run beside the conversation rather than in it
 * (`prompt.background`). Its answer comes back into the transcript via
 * `startBackground`'s own listener.
 */
function Background({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const addNotice = useSession((s) => s.addNotice);

  const go = async () => {
    const prompt = text.trim();
    if (!prompt || sending) return;
    setSending(true);
    buzz('tap');
    try {
      await startBackground(sessionId, prompt);
      setText('');
      addNotice(prompt, 'info', 'Background — running; the answer lands here');
    } catch (err) {
      addNotice(err instanceof Error ? err.message : 'Could not start that', 'error', 'Background');
      buzz('warn');
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
      <input
        className="field"
        style={{ flex: 1, minWidth: 0 }}
        placeholder="Run in the background — keep chatting"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void go();
        }}
        aria-label="Background prompt"
      />
      <button className="btn btn--sm" disabled={!text.trim() || sending} onClick={() => void go()}>
        {sending ? 'Starting…' : 'Run'}
      </button>
    </div>
  );
}

/**
 * Pick up MCP servers and skills changed on disk, without a terminal.
 *
 * The MCP reload asks the backend first and confirms only if told to: an
 * install with `approvals.mcp_reload_confirm` off reloads on the first tap,
 * one with it on arms the button and explains what the second tap costs.
 */
function Reloads({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState<'mcp' | 'skills' | null>(null);
  const [armed, setArmed] = useState(false);
  const addNotice = useSession((s) => s.addNotice);

  const mcp = async () => {
    if (busy) return;
    setBusy('mcp');
    buzz('tap');
    try {
      const res = await reloadMcp(sessionId, { confirm: armed });
      if (res.status === 'confirm_required') {
        setArmed(true);
        return;
      }
      setArmed(false);
      addNotice(describeMcpReload(res), 'info', '/reload-mcp');
    } catch (err) {
      setArmed(false);
      addNotice(err instanceof Error ? err.message : 'MCP reload failed', 'error', '/reload-mcp');
      buzz('warn');
    } finally {
      setBusy(null);
    }
  };

  const skills = async () => {
    if (busy) return;
    setBusy('skills');
    buzz('tap');
    try {
      addNotice(await reloadSkills(sessionId), 'info', '/reload-skills');
    } catch (err) {
      addNotice(err instanceof Error ? err.message : 'Skills reload failed', 'error', '/reload-skills');
      buzz('warn');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className={`btn btn--sm${armed ? ' btn--danger' : ''}`}
          style={{ flex: 1 }}
          disabled={busy != null}
          onClick={() => void mcp()}
        >
          {busy === 'mcp' ? 'Reloading…' : armed ? 'Reload anyway' : 'Reload MCP'}
        </button>
        <button className="btn btn--sm" style={{ flex: 1 }} disabled={busy != null} onClick={() => void skills()}>
          {busy === 'skills' ? 'Rescanning…' : 'Reload skills'}
        </button>
      </div>
      {armed && (
        <p role="status" style={{ fontSize: 'var(--type-body-sm)', color: 'var(--warn)', margin: '8px 2px 0', lineHeight: 1.5 }}>
          {MCP_CONFIRM_TEXT}
        </p>
      )}
    </>
  );
}
