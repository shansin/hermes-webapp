/**
 * Context-window breakdown: where the tokens actually went.
 *
 * Also the place to compact a conversation, since running out of context is
 * the problem this sheet is opened to diagnose — and the home for the turn
 * controls that previously lived only behind slash commands (`/save`,
 * `/title`, `/undo`, `/compress`, `/approvals`, `/goal`, `/queue`,
 * `/background`, `/rollback`, `/retry`): each rendered structured output into
 * the transcript as text, with no button anywhere.
 */
import { useEffect, useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import {
  compressSession,
  saveSession,
  setApprovalMode,
  titleSession,
  undoTurns,
} from '../../api/gateway';
import { execCommand } from '../../api/commands';
import { formatTokens } from '../shared/misc';
import { buzz } from '../../lib/haptics';

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
            APPROVALS
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {['suggest', 'auto', 'never'].map((mode) => (
              <button
                key={mode}
                className={`chip${(info?.approval_mode ?? '') === mode ? ' chip--active' : ''}`}
                disabled={action != null}
                onClick={() =>
                  void runTurn('/approvals', async () => {
                    await setApprovalMode(sessionId, mode);
                    return `Approval mode: ${mode}.`;
                  })
                }
                aria-pressed={(info?.approval_mode ?? '') === mode}
              >
                {action === '/approvals' && (info?.approval_mode ?? '') !== mode ? '…' : mode}
              </button>
            ))}
            <button
              className="btn btn--sm"
              style={{ marginLeft: 'auto' }}
              disabled={action != null}
              onClick={() => void runExec('/approvals')}
            >
              Show
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
            <button className="btn btn--sm" disabled={action != null} onClick={() => void runExec('/queue')}>
              Queue
            </button>
            <button className="btn btn--sm" disabled={action != null} onClick={() => void runExec('/background')}>
              Background
            </button>
            <button className="btn btn--sm" disabled={action != null} onClick={() => void runExec('/agents')}>
              Agents
            </button>
            <button className="btn btn--sm" disabled={action != null} onClick={() => void runExec('/rollback')}>
              Checkpoints
            </button>
          </div>
          <p style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', margin: '10px 2px 0', lineHeight: 1.5 }}>
            Answers land in the transcript. Queue and Background take their prompt
            as the next message you send — type it after tapping, or run{' '}
            <code>/queue your prompt</code> from the composer.
          </p>
        </>
      )}
    </Sheet>
  );
}
