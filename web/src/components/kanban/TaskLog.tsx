/**
 * The worker's stdout.
 *
 * This exists because every other window onto a run can be shut. A summary is
 * written only by a worker that finished tidily; a session is findable only if
 * the auxiliary model got round to titling it or the run stamped its id; a
 * crashed spawn leaves neither. The log needs the worker to have been
 * *started*, which is the weakest precondition on offer — so when the sheet
 * cannot find the conversation, this is what it can still show, and "the run
 * left no trace" stops being something the app has to claim.
 *
 * Collapsed by default and fetched only when opened: it is a debugging view,
 * and the tail alone is tens of kilobytes of ANSI-framed terminal output that
 * nobody scrolling past a task wants paid for.
 */
import { useState } from 'react';
import { useTaskLog } from '../../api/kanban';
import { Loader } from '../shared/misc';
import { buzz } from '../../lib/haptics';

/** Terminal output is written for a terminal. Strip the escape codes. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[A-Za-z]/g, '');
}

export function TaskLog({ taskId, board }: { taskId: string; board: string | null }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useTaskLog(taskId, open, board);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        className="btn btn--sm"
        style={{ width: '100%', justifyContent: 'space-between' }}
        onClick={() => {
          buzz('tap');
          setOpen((v) => !v);
        }}
      >
        <span style={{ color: 'var(--text-dim)' }}>{open ? 'Hide worker log' : 'Worker log'}</span>
        <span style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)' }}>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: 8 }}>
          {isLoading ? (
            <Loader size="sm" muted />
          ) : error ? (
            /* A 404 here is the ordinary case, not a failure: it means the
               worker was never spawned. Saying so is the whole answer. */
            <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)' }}>
              {(error as { status?: number }).status === 404
                ? 'No log — a worker has never been spawned for this card.'
                : error instanceof Error
                  ? error.message
                  : 'Could not read the log.'}
            </div>
          ) : !data?.exists || !data.content.trim() ? (
            <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)' }}>
              The log file is empty.
            </div>
          ) : (
            <>
              {data.truncated && (
                <div
                  style={{
                    fontSize: 'var(--type-label-sm)',
                    color: 'var(--text-faint)',
                    marginBottom: 4,
                  }}
                >
                  Showing the end of a {Math.round(data.size_bytes / 1024)} KB log.
                </div>
              )}
              <pre
                style={{
                  margin: 0,
                  maxHeight: 320,
                  overflow: 'auto',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border-soft)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 10,
                  fontFamily: 'var(--mono)',
                  fontSize: 'var(--type-label-sm)',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {plain(data.content)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
