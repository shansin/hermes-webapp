/**
 * The session's filesystem checkpoints as a list you can act on.
 *
 * `/rollback` used to be a text dump in the transcript — hashes and times to
 * read, then a command to type back. Here each checkpoint is a row: tap it to
 * see what restoring it would undo (the diff against the working tree, which
 * is what `rollback.diff` computes), then restore one file or all of them.
 *
 * Restoring is armed with a second tap rather than a dialog — one more sheet
 * stacked on this one is the hand-off case `useHistoryDismiss` exists for, and
 * a second tap on the same spot is as deliberate on a phone. The whole-tree
 * restore says what else it does, because the backend does it unasked: when
 * the checkpoint is from the latest turn it also drops that turn
 * (`history_removed`), so the transcript is reloaded afterwards. It is refused mid-turn; a single file
 * is not. See `api/checkpoints.ts` for the wire facts.
 *
 * Lazy (`ChatScreen` mounts it only while open) and opened through
 * `openCheckpoints()` in `store/ui.ts`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { Loader } from '../shared/misc';
import { Markdown } from './MarkdownAsync';
import { useSession } from '../../store/session';
import { closeCheckpoints, useUi } from '../../store/ui';
import { fetchHistory } from '../../api/gateway';
import {
  checkpointDiff,
  listCheckpoints,
  restoreCheckpoint,
  type Checkpoint,
  type CheckpointDiff,
} from '../../api/checkpoints';
import {
  checkpointAtTime,
  checkpointLabel,
  checkpointTime,
  diffFiles,
  diffSummary,
} from '../../lib/checkpoints';
import { buzz } from '../../lib/haptics';

/** `rollback.diff` cuts the patch here. */
const DIFF_CAP = 4000;
/** How long an armed restore button waits for its second tap. */
const ARM_MS = 4000;

const faint = { fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)' } as const;

function when(timestamp: string): string {
  const t = checkpointTime(timestamp);
  if (t == null) return timestamp || 'Unknown time';
  return new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function CheckpointsSheet() {
  const request = useUi((s) => s.checkpoints);
  const toast = useUi((s) => s.toast);
  const sessionId = useSession((s) => s.sessionId);
  const running = useSession((s) => s.running);

  const [list, setList] = useState<{ enabled: boolean; checkpoints: Checkpoint[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const since = request?.since ?? null;
  const highlighted = useMemo(
    () => (list && since != null ? checkpointAtTime(list.checkpoints, since) : null),
    [list, since],
  );

  useEffect(() => {
    if (!request || !sessionId) return;
    let alive = true;
    setList(null);
    setError(null);
    listCheckpoints(sessionId)
      .then((res) => {
        if (!alive) return;
        setList(res);
        if (since != null) setOpen(checkpointAtTime(res.checkpoints, since)?.hash ?? null);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : 'Could not list checkpoints'));
    return () => {
      alive = false;
    };
  }, [request, sessionId, since]);

  return (
    <Sheet open={request != null} title="Checkpoints" onClose={closeCheckpoints}>
      {!sessionId ? (
        <p style={faint}>No conversation is open.</p>
      ) : error ? (
        <p style={{ ...faint, color: 'var(--error)' }}>{error}</p>
      ) : !list ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
          <Loader />
        </div>
      ) : !list.enabled ? (
        <p style={faint}>
          Checkpoints are off for this agent — <code>checkpoints.enabled</code> in its config.yaml.
        </p>
      ) : list.checkpoints.length === 0 ? (
        <p style={faint}>
          None yet. One is taken just before the agent first changes a file in a turn.
        </p>
      ) : (
        <>
          {since != null && (
            <p style={{ ...faint, margin: '0 2px 10px' }}>
              {highlighted
                ? 'The highlighted checkpoint holds your files as they were at that message.'
                : 'Nothing has been checkpointed since that message — the agent has not changed files since.'}
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {list.checkpoints.map((c) => (
              <CheckpointRow
                key={c.hash}
                checkpoint={c}
                sessionId={sessionId}
                highlighted={c.hash === highlighted?.hash}
                expanded={open === c.hash}
                onToggle={() => setOpen((cur) => (cur === c.hash ? null : c.hash))}
                running={running}
                onRestored={(msg) => {
                  toast(msg, 'success');
                  closeCheckpoints();
                }}
                onError={(msg) => toast(msg, 'error')}
              />
            ))}
          </div>
          <p style={{ ...faint, margin: '12px 2px 0', lineHeight: 1.5 }}>
            A diff shows what restoring would undo: the checkpoint against your files now.
          </p>
        </>
      )}
    </Sheet>
  );
}

interface RowProps {
  checkpoint: Checkpoint;
  sessionId: string;
  highlighted: boolean;
  expanded: boolean;
  onToggle: () => void;
  running: boolean;
  onRestored: (message: string) => void;
  onError: (message: string) => void;
}

function CheckpointRow({ checkpoint: c, sessionId, highlighted, expanded, onToggle, running, onRestored, onError }: RowProps) {
  const [diff, setDiff] = useState<CheckpointDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  /** Which restore is armed: '' for the whole tree, else a file path. */
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!expanded || diff) return;
    let alive = true;
    checkpointDiff(sessionId, c.hash)
      .then((d) => alive && setDiff(d))
      .catch((err) => alive && setDiffError(err instanceof Error ? err.message : 'Could not load the diff'));
    return () => {
      alive = false;
    };
  }, [expanded, diff, sessionId, c.hash]);

  useEffect(() => () => {
    if (disarm.current) clearTimeout(disarm.current);
  }, []);

  const files = diff ? diffFiles(diff) : [];
  const summary = diff ? diffSummary(diff.stat) : '';

  const restore = async (file: string) => {
    if (armed !== file) {
      buzz('tap');
      setArmed(file);
      if (disarm.current) clearTimeout(disarm.current);
      disarm.current = setTimeout(() => setArmed(null), ARM_MS);
      return;
    }
    setArmed(null);
    setBusy(true);
    buzz('warn');
    try {
      const res = await restoreCheckpoint(sessionId, c.hash, file || undefined);
      if (!res.success) {
        onError(res.error || res.reason || 'Restore failed');
        return;
      }
      const restored = res.restored_files?.length;
      const skipped = res.skipped_user_edits?.length;
      let msg = file
        ? `Restored ${file}`
        : `Restored ${restored ? `${restored} file${restored === 1 ? '' : 's'}` : 'files'}`;
      if (skipped) msg += ` — kept ${skipped} you edited yourself`;
      if (!file && res.history_removed) {
        msg += '. The latest turn was removed from the chat.';
        // The handler rewound the transcript server-side; show what is left.
        // Only if this conversation is still the one on screen.
        const sid = useSession.getState().sessionId;
        if (sid === sessionId) {
          try {
            const history = await fetchHistory(sessionId);
            if (useSession.getState().sessionId === sessionId) useSession.getState().loadHistory(history);
          } catch {
            // The next reconnect resyncs it.
          }
        }
      }
      onRestored(msg);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="card"
      style={{
        padding: 0,
        borderColor: highlighted ? 'var(--accent)' : undefined,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          width: '100%',
          gap: 10,
          alignItems: 'baseline',
          padding: '12px 14px',
          textAlign: 'left',
          background: 'none',
          border: 0,
          color: 'inherit',
          font: 'inherit',
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {checkpointLabel(c.message)}
          </span>
          <span style={faint}>
            {when(c.timestamp)}
            {summary && expanded ? ` · ${summary}` : ''}
          </span>
        </span>
        <code style={faint}>{c.hash.slice(0, 7)}</code>
      </button>

      {expanded && (
        <div style={{ padding: '0 14px 14px' }}>
          {diffError ? (
            <p style={{ ...faint, color: 'var(--error)' }}>{diffError}</p>
          ) : !diff ? (
            <Loader size="sm" />
          ) : !diff.diff.trim() && !diff.stat.trim() ? (
            <p style={faint}>Your files already match this checkpoint.</p>
          ) : (
            <>
              {files.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                  {files.map((f) => (
                    <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <code style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', fontSize: 'var(--type-body-sm)' }}>
                        {f}
                      </code>
                      <button
                        className={`btn btn--sm${armed === f ? ' btn--armed' : ''}`}
                        disabled={busy}
                        onClick={() => void restore(f)}
                      >
                        {armed === f ? 'Tap to confirm' : 'Restore'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Markdown>{'```diff\n' + diff.diff.replace(/```/g, '``​`') + '\n```'}</Markdown>
              {diff.diff.length >= DIFF_CAP && <p style={faint}>The diff is cut short here.</p>}
            </>
          )}
          <button
            className={`btn${armed === '' ? ' btn--danger' : ''}`}
            style={{ width: '100%', marginTop: 10 }}
            disabled={busy || running}
            onClick={() => void restore('')}
          >
            {busy ? 'Restoring…' : armed === '' ? 'Tap again — restores every file' : 'Restore all files'}
          </button>
          <p style={{ ...faint, margin: '6px 2px 0', lineHeight: 1.45 }}>
            {running
              ? 'Whole restores wait for the current turn to finish. Single files can be restored now.'
              : 'Files you have edited yourself since are kept. A checkpoint from the latest turn also removes that turn from the conversation.'}
          </p>
        </div>
      )}
    </div>
  );
}
