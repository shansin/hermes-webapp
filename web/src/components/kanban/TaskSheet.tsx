/**
 * Task detail: edit fields, reassign, dispatch, read run history, add comments.
 *
 * Two of those were missing and both were the same omission — everything the
 * *dispatcher* cares about was read-only here. A card's assignee decides
 * whether any agent will ever claim it (see the note in `NewTaskSheet`: an
 * unassigned card is skipped silently, for ever), and it could be set once at
 * creation and never corrected. And a card sitting in Ready waits for the next
 * dispatch tick with no way to say "now", which is the thing you want most
 * from a board you are watching.
 */
import { useEffect, useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { relTime } from '../shared/misc';
import {
  COLUMNS,
  COLUMN_LABEL,
  useAddComment,
  useDeleteTask,
  useDispatch,
  useTask,
  useUpdateTask,
  type Column,
} from '../../api/kanban';
import { useProfiles } from '../../api/profiles';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

export function TaskSheet({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const { data, isLoading } = useTask(taskId);
  const update = useUpdateTask();
  const del = useDeleteTask();
  const addComment = useAddComment();
  const dispatch = useDispatch();
  const profiles = useProfiles().data?.profiles ?? [];
  const toast = useUi((s) => s.toast);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [comment, setComment] = useState('');
  const [dirty, setDirty] = useState(false);

  // Load the server's values whenever a different task is opened.
  useEffect(() => {
    if (data?.task) {
      setTitle(data.task.title);
      setBody(data.task.body ?? '');
      setDirty(false);
    }
  }, [data?.task.id, data?.task]);

  if (!taskId) return null;

  const task = data?.task;

  const save = async () => {
    if (!task) return;
    try {
      await update.mutateAsync({ id: task.id, title, body });
      buzz('done');
      setDirty(false);
      toast('Saved', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error');
    }
  };

  const move = async (status: Column) => {
    if (!task) return;
    buzz('tap');
    try {
      await update.mutateAsync({ id: task.id, status });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not move', 'error');
    }
  };

  const setPriority = async (priority: number) => {
    if (!task) return;
    buzz('tap');
    try {
      await update.mutateAsync({ id: task.id, priority });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed', 'error');
    }
  };

  const reassign = async (name: string) => {
    if (!task) return;
    buzz('tap');
    try {
      await update.mutateAsync({ id: task.id, assignee: name });
      toast(`Assigned to ${name}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not reassign', 'error');
    }
  };

  /**
   * Hand this one card to the dispatcher now.
   *
   * Scoped to the task rather than the bare `/dispatch` sweep: from a sheet
   * showing one card, a button that might start something else entirely is a
   * trap. A dispatch that claims nothing is not an error — the card may be in
   * a column the dispatcher does not draw from, or already claimed — so it is
   * reported plainly rather than as a failure.
   */
  const runNow = async () => {
    if (!task) return;
    buzz('tap');
    try {
      await dispatch.mutateAsync(task.id);
      buzz('done');
      toast('Handed to the dispatcher', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not dispatch', 'error');
    }
  };

  const postComment = async () => {
    if (!task || !comment.trim()) return;
    try {
      await addComment.mutateAsync({ id: task.id, body: comment.trim() });
      setComment('');
      buzz('tap');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Comment failed', 'error');
    }
  };

  const remove = async () => {
    if (!task) return;
    try {
      await del.mutateAsync(task.id);
      toast('Task deleted', 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error');
    }
  };

  return (
    <Sheet open onClose={onClose} title={task ? task.id : 'Task'}>
      {isLoading || !task ? (
        <div style={{ color: 'var(--text-faint)' }}>Loading…</div>
      ) : (
        <>
          <input
            className="field"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setDirty(true);
            }}
            style={{ fontWeight: 600, marginBottom: 9 }}
          />

          <textarea
            className="field"
            value={body}
            placeholder="Description…"
            rows={4}
            onChange={(e) => {
              setBody(e.target.value);
              setDirty(true);
            }}
            style={{ resize: 'vertical', marginBottom: 9 }}
          />

          {dirty && (
            <button className="btn btn--primary" style={{ width: '100%', marginBottom: 14 }} onClick={save}>
              Save changes
            </button>
          )}

          <Label>STATUS</Label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            {COLUMNS.map((c) => (
              <button
                key={c}
                className={`chip${task.status === c ? ' chip--active' : ''}`}
                onClick={() => void move(c)}
              >
                {COLUMN_LABEL[c]}
              </button>
            ))}
          </div>

          <Label>PRIORITY</Label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {[0, 1, 2, 3].map((p) => (
              <button
                key={p}
                className={`chip${task.priority === p ? ' chip--active' : ''}`}
                onClick={() => void setPriority(p)}
              >
                {['none', 'low', 'high', 'urgent'][p]}
              </button>
            ))}
          </div>

          <Label>ASSIGNED TO</Label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {/* The card's current assignee first, even when no profile by that
                name exists any more — otherwise a card assigned to a deleted
                profile shows nothing selected and looks unassigned, which is a
                different and much less recoverable problem. */}
            {[
              ...(task.assignee && !profiles.some((p) => p.name === task.assignee)
                ? [task.assignee]
                : []),
              ...profiles.map((p) => p.name),
            ].map((name) => (
              <button
                key={name}
                className={`chip${task.assignee === name ? ' chip--active' : ''}`}
                onClick={() => void reassign(name)}
                disabled={update.isPending}
              >
                {name}
              </button>
            ))}
          </div>
          {!task.assignee && (
            /* Not a warning for its own sake: Hermes' dispatcher buckets an
               unassigned card as `skipped_unassigned` every tick and reports
               nothing, so this is the only place the app can say why a task
               that looks queued will never start. */
            <div style={{ fontSize: 12, color: 'var(--warn)', marginBottom: 14 }}>
              Nobody is assigned — the dispatcher skips this card without reporting it.
            </div>
          )}
          {task.assignee && <div style={{ marginBottom: 14 }} />}

          {task.status === 'ready' ? (
            <button
              className="btn"
              style={{ width: '100%', marginBottom: 14 }}
              onClick={() => void runNow()}
              disabled={dispatch.isPending || !task.assignee}
            >
              {dispatch.isPending ? 'Dispatching…' : 'Run now'}
            </button>
          ) : (
            task.status !== 'running' && (
              <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 14 }}>
                Move this card to Ready to hand it to the dispatcher.
              </div>
            )
          )}

          {task.last_failure_error && (
            <div
              style={{
                background: 'color-mix(in srgb, var(--error) 12%, transparent)',
                border: '1px solid var(--error)',
                borderRadius: 'var(--radius-sm)',
                padding: 10,
                fontSize: 12.5,
                marginBottom: 14,
                fontFamily: 'var(--mono)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {task.last_failure_error}
            </div>
          )}

          {data.runs.length > 0 && (
            <>
              <Label>RUNS</Label>
              <div style={{ marginBottom: 14 }}>
                {data.runs.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      padding: '7px 0',
                      borderBottom: '1px solid var(--border-soft)',
                      fontSize: 13,
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background:
                          r.outcome === 'completed'
                            ? 'var(--ok)'
                            : r.status === 'running'
                              ? 'var(--accent)'
                              : 'var(--error)',
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {r.summary || r.outcome || r.status}
                    </span>
                    <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>
                      {relTime(r.started_at)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          <Label>COMMENTS</Label>
          <div style={{ marginBottom: 10 }}>
            {data.comments.map((c) => (
              <div key={c.id} style={{ padding: '7px 0', borderBottom: '1px solid var(--border-soft)' }}>
                <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 2 }}>
                  {c.author} · {relTime(c.created_at)}
                </div>
                <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{c.body}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 7, marginBottom: 16 }}>
            <input
              className="field"
              placeholder="Add a comment…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void postComment();
              }}
            />
            <button className="btn btn--sm" onClick={postComment} disabled={!comment.trim()}>
              Post
            </button>
          </div>

          <button className="btn btn--danger" style={{ width: '100%' }} onClick={remove}>
            Delete task
          </button>
        </>
      )}
    </Sheet>
  );
}

function Label({ children }: { children: string }) {
  return (
    <div style={{ fontSize: 12, color: 'var(--text-faint)', fontWeight: 650, marginBottom: 6 }}>
      {children}
    </div>
  );
}
