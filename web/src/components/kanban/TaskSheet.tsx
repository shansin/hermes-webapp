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
 *
 * The sheet since grew the three lanes a card can *stop* in, which is the other
 * half of watching a board — a card that is moving needs nothing from you:
 *
 * - **Blocked** is the agent asking a question. `BlockedPanel` answers it and
 *   releases the card in one action, in the order that makes the answer count.
 * - **Triage** is a card that has not been specified yet, and unless the
 *   gateway's `auto_decompose` is on, nothing promotes it — no sweep, no cron,
 *   only `specify` or `decompose`. It is where a new card now lands, so leaving
 *   those two off the screen would mean every task typed here stopping on
 *   arrival.
 * - **Running with a dead worker** is the one that looks like progress. The
 *   claim outlives the process, so the card sits in Running with a heartbeat
 *   that stopped and the dispatcher will not touch it until the TTL expires.
 *   Reclaim is the way out and there was no other.
 *
 * Ordering follows that: whatever is *asked of you* goes above the fields,
 * because a sheet you have to scroll to find the question in is a sheet where
 * the question gets missed. Everything that configures a *future* run — the
 * model, the depth, the links, the notifications — goes below them, and the
 * forensics (history, worker log) below that.
 */
import { useEffect, useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { relTime, SkeletonList } from '../shared/misc';
import { Markdown } from '../chat/MarkdownAsync';
import {
  COLUMNS,
  COLUMN_LABEL,
  latestRunHints,
  runSessionId,
  useAddComment,
  useBoard,
  useDecomposeTask,
  useDeleteTask,
  useDispatch,
  useEstimateTask,
  useHomeChannels,
  useHomeSubscription,
  useReassignTask,
  useReclaimTask,
  useSpecifyTask,
  useTask,
  useTaskSession,
  useTerminateRun,
  useUpdateTask,
  type Column,
  type Task,
  type TaskPatch,
  type TaskRun,
} from '../../api/kanban';
import { useKanbanConfig } from '../../api/kanbanAdmin';
import { useProfiles } from '../../api/profiles';
import { ProfileField } from '../shared/ProfileSelect';
import { Switch } from '../shared/misc';
import { BlockedPanel } from './BlockedPanel';
import { TaskAttachments } from './TaskAttachments';
import { TaskEvents } from './TaskEvents';
import { TaskLinks } from './TaskLinks';
import { TaskLog } from './TaskLog';
import { TaskOverrides } from './TaskOverrides';
import { useNavigate } from 'react-router-dom';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

/**
 * How long a claimed run may go without a heartbeat before the card is called
 * stuck. Hermes writes one roughly every 30s, so a couple of minutes is well
 * clear of a slow tool call and well short of the claim TTL, which is the
 * window in which nothing on the board explains the silence.
 */
const STUCK_AFTER_S = 150;

export function TaskSheet({
  taskId,
  board,
  onClose,
  onOpenTask,
}: {
  taskId: string | null;
  /** Which board the card lives on. Null addresses the server's current one. */
  board?: string | null;
  onClose: () => void;
  /** Follow a link to a parent or a subtask without leaving the board. */
  onOpenTask?: (id: string) => void;
}) {
  const slug = board ?? null;
  const { data, isLoading } = useTask(taskId, slug);
  const update = useUpdateTask(slug);
  const del = useDeleteTask(slug);
  const addComment = useAddComment(slug);
  const dispatch = useDispatch(slug);
  const specify = useSpecifyTask(slug);
  const decompose = useDecomposeTask(slug);
  const reclaim = useReclaimTask(slug);
  const reassign = useReassignTask(slug);
  const terminate = useTerminateRun(slug);
  const estimate = useEstimateTask(slug);
  const profiles = useProfiles().data?.profiles ?? [];
  const boardData = useBoard({ board: slug });
  const config = useKanbanConfig();
  const navigate = useNavigate();
  const toast = useUi((s) => s.toast);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [comment, setComment] = useState('');
  const [dirty, setDirty] = useState(false);
  const [editingBody, setEditingBody] = useState(false);

  // Load the server's values whenever a different task is opened.
  useEffect(() => {
    if (data?.task) {
      setTitle(data.task.title);
      setBody(data.task.body ?? '');
      setDirty(false);
      setEditingBody(false);
    }
  }, [data?.task.id, data?.task]);

  if (!taskId) return null;

  const task = data?.task;

  const patch = (p: TaskPatch) => update.mutateAsync({ id: taskId, ...p });

  const save = async () => {
    if (!task) return;
    try {
      await patch({ title, body });
      buzz('done');
      setDirty(false);
      setEditingBody(false);
      toast('Saved', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error');
    }
  };

  const move = async (status: Column | 'archived') => {
    if (!task) return;
    buzz('tap');
    try {
      const res = await patch({ status });
      /* Hermes may land the card somewhere else than asked — `ready` on a card
         with an unfinished parent becomes `todo`, an unblock restores the phase
         it was blocked from. Only mention it when the two differ, so the common
         case stays silent. */
      if (res.task.status !== status) {
        toast(`Moved to ${COLUMN_LABEL[res.task.status as Column] ?? res.task.status}`, 'success');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not move', 'error');
    }
  };

  const setPriority = async (priority: number) => {
    if (!task) return;
    buzz('tap');
    try {
      await patch({ priority });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed', 'error');
    }
  };

  /**
   * Move the card to another agent, releasing a live claim if it has one.
   *
   * `PATCH {assignee}` — what this used to do — **409s on a claimed card**,
   * which is the exact moment you most want to move it: it is running as the
   * wrong agent right now. The dedicated route takes `reclaim_first` and does
   * both halves server-side in the order that works.
   */
  const reassignTo = async (name: string) => {
    if (!task) return;
    buzz('tap');
    const claimed = task.current_run_id !== null;
    try {
      await reassign.mutateAsync({
        id: task.id,
        profile: name || null,
        reclaimFirst: claimed,
        reason: 'Reassigned from Hem',
      });
      toast(
        name
          ? claimed
            ? `Claim released and assigned to ${name}`
            : `Assigned to ${name}`
          : 'Unassigned',
        'success',
      );
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
      await dispatch.mutateAsync({ taskId: task.id });
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
      /* Worth saying, because it is not what a comment usually does: a worker
         polls this thread every few seconds and steers itself on what it finds,
         so a comment on a live card reaches the agent mid-run. */
      if (task.status === 'running') toast('Sent to the running agent', 'success');
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

  /**
   * The two auxiliary-model actions on a triage card.
   *
   * Both answer 200 with `ok: false` when there is no auxiliary model
   * configured, deliberately — so the reason has to be read off the body and
   * shown, or the button looks like it silently did nothing. Both also run the
   * model to completion inside the request, which is why the label changes:
   * a minute of apparently-frozen sheet needs to have been announced.
   */
  const runAux = async (which: 'specify' | 'decompose') => {
    if (!task) return;
    buzz('tap');
    const mutation = which === 'specify' ? specify : decompose;
    try {
      const res = await mutation.mutateAsync(task.id);
      if (!res.ok) {
        toast(res.reason ?? `Could not ${which} this card`, 'error');
        return;
      }
      buzz('done');
      toast(
        which === 'specify'
          ? 'Specified — moved to To do'
          : res.fanout
            ? `Split into ${res.child_ids?.length ?? 0} subtasks`
            : 'Specified — no split needed',
        'success',
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : `Could not ${which} this card`, 'error');
    }
  };

  const releaseClaim = async () => {
    if (!task) return;
    buzz('warn');
    try {
      await reclaim.mutateAsync({ id: task.id });
      buzz('done');
      toast('Claim released — the dispatcher can retry it', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not reclaim', 'error');
    }
  };

  const killWorker = async () => {
    if (!task?.current_run_id) return;
    buzz('warn');
    try {
      await terminate.mutateAsync({ runId: task.current_run_id, taskId: task.id });
      buzz('done');
      toast('Worker terminated', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not terminate', 'error');
    }
  };

  const askEstimate = async () => {
    if (!task) return;
    buzz('tap');
    try {
      const res = await estimate.mutateAsync(task.id);
      if (!res.ok) toast(res.reason ?? 'Could not estimate', 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not estimate', 'error');
    }
  };

  const runs = data?.runs ?? [];
  const auxBusy = specify.isPending || decompose.isPending;
  const stale =
    task?.status === 'running' &&
    task.current_run_id !== null &&
    typeof task.last_heartbeat_at === 'number' &&
    Date.now() / 1000 - task.last_heartbeat_at > STUCK_AFTER_S;
  const markdown = config.data?.render_markdown !== false;

  const cards = new Map<string, Task>();
  for (const c of boardData.data?.columns ?? []) for (const t of c.tasks) cards.set(t.id, t);

  return (
    <Sheet open onClose={onClose} title={task ? task.id : 'Task'}>
      {isLoading || !task ? (
        <SkeletonList n={4} h={44} />
      ) : (
        <>
          {(task.status === 'blocked' || task.status === 'scheduled') && (
            <BlockedPanel task={task} runs={runs} board={slug} />
          )}

          {stale && (
            <div
              style={{
                border: '1px solid var(--error)',
                background: 'color-mix(in srgb, var(--error) 10%, transparent)',
                borderRadius: 'var(--radius-sm)',
                padding: 12,
                marginBottom: 14,
              }}
            >
              <div style={{ fontWeight: 650, fontSize: 'var(--type-body-md)', marginBottom: 3 }}>
                Worker has gone quiet
              </div>
              <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-dim)', lineHeight: 1.45 }}>
                Last heartbeat {relTime(task.last_heartbeat_at)}. The claim outlives the process, so
                nothing will pick this card up until it is released.
              </div>
              <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
                <button
                  className="btn"
                  style={{ flex: 1 }}
                  disabled={reclaim.isPending}
                  onClick={() => void releaseClaim()}
                >
                  {reclaim.isPending ? 'Releasing…' : 'Release the claim'}
                </button>
                {/* Different verb, deliberately separate: reclaim leaves the
                    process alone, which is right for a worker that has already
                    died and wrong for one that is alive and wedged. */}
                <button
                  className="btn btn--danger"
                  style={{ flex: 1 }}
                  disabled={terminate.isPending}
                  onClick={() => void killWorker()}
                >
                  Kill the worker
                </button>
              </div>
            </div>
          )}

          <input
            className="field"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setDirty(true);
            }}
            style={{ fontWeight: 600, marginBottom: 9 }}
          />

          {/* The body is prose the agent wrote, or a brief the specifier wrote,
              and both are markdown — headings, lists, links, the occasional
              table. Rendering it as pre-wrapped plain text made a specified
              card read as a wall of `##` and `-`. It stays a textarea while
              being edited, because a rendered view you cannot type into is not
              an editor. */}
          {markdown && !editingBody && body.trim() ? (
            <button
              className="btn btn--sm"
              style={{
                width: '100%',
                textAlign: 'left',
                display: 'block',
                height: 'auto',
                padding: '10px 11px',
                marginBottom: 9,
                fontWeight: 400,
              }}
              onClick={() => setEditingBody(true)}
              aria-label="Edit description"
            >
              <Markdown>{body}</Markdown>
            </button>
          ) : (
            <textarea
              className="field"
              value={body}
              autoFocus={editingBody}
              placeholder="Description…"
              rows={4}
              onChange={(e) => {
                setBody(e.target.value);
                setDirty(true);
              }}
              style={{ resize: 'vertical', marginBottom: 9 }}
            />
          )}

          {dirty && (
            <button className="btn btn--primary" style={{ width: '100%', marginBottom: 14 }} onClick={save}>
              Save changes
            </button>
          )}

          {/* Unless the gateway fans Triage out on its own, the column is a
              stop: no sweep promotes a card out of it. These are the two things
              that do, and without them a card created here could sit there for
              ever. */}
          {task.status === 'triage' && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', gap: 7 }}>
                <button
                  className="btn btn--primary"
                  style={{ flex: 1 }}
                  disabled={auxBusy}
                  onClick={() => void runAux('specify')}
                >
                  {specify.isPending ? 'Writing the spec…' : 'Specify'}
                </button>
                <button
                  className="btn"
                  style={{ flex: 1 }}
                  disabled={auxBusy}
                  onClick={() => void runAux('decompose')}
                >
                  {decompose.isPending ? 'Splitting…' : 'Split into subtasks'}
                </button>
              </div>
              <div
                style={{
                  marginTop: 7,
                  fontSize: 'var(--type-label-sm)',
                  color: 'var(--text-faint)',
                  lineHeight: 1.45,
                }}
              >
                Specify turns this into a proper brief and moves it to To do. Split fans it out into
                subtasks routed to whichever agent fits each one. Both run a model and can take a
                minute.
              </div>
            </div>
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
            {/* Archive is the non-destructive counterpart to the delete button
                at the foot of this sheet — the card leaves the board and keeps
                its history — and it was reachable from nowhere in the app. */}
            <button
              className={`chip${task.status === 'archived' ? ' chip--active' : ''}`}
              onClick={() => void move('archived')}
            >
              Archive
            </button>
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
          <div style={{ marginBottom: 6 }}>
            {/* The card's current assignee is offered even when no profile by
                that name exists any more — otherwise a card assigned to a
                deleted profile shows nothing selected and looks unassigned,
                which is a different and much less recoverable problem. */}
            <ProfileField
              label="Assignee"
              title="Assigned to"
              placeholder="Nobody"
              value={task.assignee ?? ''}
              onChange={(name) => void reassignTo(name)}
              disabled={reassign.isPending}
              options={[
                ...(task.assignee && !profiles.some((p) => p.name === task.assignee)
                  ? [{ value: task.assignee, label: task.assignee, hint: 'No profile by this name' }]
                  : []),
                ...profiles.map((p) => ({ value: p.name, label: p.name })),
              ]}
            />
          </div>
          {!task.assignee && (
            /* Not a warning for its own sake: Hermes' dispatcher buckets an
               unassigned card as `skipped_unassigned` every tick and reports
               nothing, so this is the only place the app can say why a task
               that looks queued will never start. */
            <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--warn)', marginBottom: 14 }}>
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
            task.status !== 'running' &&
            task.status !== 'triage' && (
              <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', marginBottom: 14 }}>
                Move this card to Ready to hand it to the dispatcher.
              </div>
            )
          )}

          <TaskOverrides task={task} onPatch={patch} busy={update.isPending} />

          {/* Create-only settings, shown because they change what a run costs
              and there is no other way to find out a card has them. The API
              takes none of them on PATCH, so this is a readout, not a control —
              saying so is better than rendering four inert fields. */}
          <FixedAtCreation task={task} />

          <Label>EFFORT</Label>
          <div style={{ marginBottom: 14 }}>
            <button
              className="btn btn--sm"
              style={{ width: '100%' }}
              disabled={estimate.isPending}
              onClick={() => void askEstimate()}
            >
              {estimate.isPending ? 'Asking the model…' : 'Estimate this card'}
            </button>
            {estimate.data?.ok && (
              <div
                style={{
                  marginTop: 7,
                  fontSize: 'var(--type-body-sm)',
                  color: 'var(--text-dim)',
                  lineHeight: 1.5,
                }}
              >
                <strong>{estimate.data.complexity ?? '?'}</strong>
                {typeof estimate.data.est_tokens === 'number' && estimate.data.est_tokens > 0 && (
                  <> · ~{estimate.data.est_tokens.toLocaleString()} tokens</>
                )}
                {estimate.data.rationale && <div style={{ marginTop: 3 }}>{estimate.data.rationale}</div>}
              </div>
            )}
          </div>

          <TaskAttachments taskId={task.id} board={slug} />

          <TaskLinks detail={data} board={slug} cards={cards} onOpen={onOpenTask ?? (() => {})} />

          <TaskSessionLink task={task} runs={runs} onOpen={onClose} navigate={navigate} />

          {task.last_failure_error && (
            <div
              style={{
                background: 'color-mix(in srgb, var(--error) 12%, transparent)',
                border: '1px solid var(--error)',
                borderRadius: 'var(--radius-sm)',
                padding: 10,
                fontSize: 'var(--type-body-sm)',
                marginBottom: 14,
                fontFamily: 'var(--mono)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {task.last_failure_error}
            </div>
          )}

          {runs.length > 0 && (
            <>
              <Label>RUNS</Label>
              <div style={{ marginBottom: 14 }}>
                {runs.map((r) => (
                  <RunRow key={r.id} run={r} onOpen={onClose} navigate={navigate} />
                ))}
              </div>
            </>
          )}

          <TaskEvents events={data.events ?? []} />
          <TaskLog taskId={task.id} board={slug} />

          <NotifySection taskId={task.id} board={slug} />

          <Label>COMMENTS</Label>
          <div style={{ marginBottom: 10 }}>
            {(data.comments ?? []).map((c) => (
              <div key={c.id} style={{ padding: '7px 0', borderBottom: '1px solid var(--border-soft)' }}>
                <div style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', marginBottom: 2 }}>
                  {c.author} · {relTime(c.created_at)}
                </div>
                {markdown ? (
                  <Markdown>{c.body}</Markdown>
                ) : (
                  <div style={{ fontSize: 'var(--type-detail)', whiteSpace: 'pre-wrap' }}>{c.body}</div>
                )}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 7, marginBottom: 6 }}>
            <input
              className="field"
              placeholder={task.status === 'running' ? 'Steer the running agent…' : 'Add a comment…'}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void postComment();
              }}
            />
            <button className="btn btn--sm" onClick={postComment} disabled={!comment.trim()}>
              {task.status === 'running' ? 'Send' : 'Post'}
            </button>
          </div>
          <div
            style={{
              fontSize: 'var(--type-label-sm)',
              color: 'var(--text-faint)',
              marginBottom: 16,
              lineHeight: 1.45,
            }}
          >
            {task.status === 'running'
              ? 'The worker reads new comments every few seconds and steers on them mid-run.'
              : 'Comments are part of the prompt the next run reads.'}
          </div>

          <button className="btn btn--danger" style={{ width: '100%' }} onClick={remove}>
            Delete task
          </button>
        </>
      )}
    </Sheet>
  );
}

/**
 * What this card was created with and cannot be given now.
 *
 * `skills`, `goal_mode`, `goal_max_turns`, `max_runtime_seconds`,
 * `workspace_kind` and `project_id` are all absent from `UpdateTaskBody` —
 * they are fixed when the card is made. Four inert form controls would be a
 * worse answer than a sentence, and saying nothing at all leaves someone
 * wondering why an identical-looking card behaves differently.
 */
function FixedAtCreation({ task }: { task: Task }) {
  /* Hermes stores this column as JSON text and the board serialiser hands it
     back either parsed or raw depending on the route. A malformed value must
     not take the sheet down — and with no error boundary in `App.tsx` a throw
     here takes every screen with it. */
  const skills = parseSkills(task.skills);

  const bits: string[] = [];
  if (skills.length) bits.push(`skills: ${skills.join(', ')}`);
  if (task.goal_mode) bits.push(`goal loop${task.goal_max_turns ? ` (max ${task.goal_max_turns} turns)` : ''}`);
  if (task.max_runtime_seconds) bits.push(`stops after ${Math.round(task.max_runtime_seconds / 60)} min`);
  if (task.workspace_kind && task.workspace_kind !== 'scratch') bits.push(`${task.workspace_kind} workspace`);
  if (task.branch_name) bits.push(`branch ${task.branch_name}`);
  if (bits.length === 0) return null;

  return (
    <>
      <div className="group-head">SET WHEN CREATED</div>
      <div
        style={{
          fontSize: 'var(--type-body-sm)',
          color: 'var(--text-dim)',
          marginBottom: 14,
          lineHeight: 1.5,
        }}
      >
        {bits.join(' · ')}
        <div style={{ color: 'var(--text-faint)', fontSize: 'var(--type-label-sm)', marginTop: 3 }}>
          These cannot be changed after a card exists — make a new one to change them.
        </div>
      </div>
    </>
  );
}

/**
 * Hermes' own notifier, which is a different channel from this app's push.
 *
 * The gateway delivers a card's blocking and completion to a chat platform
 * from the machine itself, so it works when no browser has ever registered a
 * subscription and when the phone is not the thing you are watching. The list
 * is per-task — `subscribed` is a property of the pair — and it renders
 * nothing at all when no home channel is configured, which is most installs.
 */
function NotifySection({ taskId, board }: { taskId: string; board: string | null }) {
  const { data } = useHomeChannels(taskId, board);
  const toggle = useHomeSubscription(board);
  const toast = useUi((s) => s.toast);
  const channels = data?.home_channels ?? [];
  if (channels.length === 0) return null;

  return (
    <>
      <div className="group-head">ALSO NOTIFY</div>
      <div style={{ marginBottom: 14 }}>
        {channels.map((c) => (
          <div
            key={`${c.platform}:${c.chat_id}:${c.thread_id}`}
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0' }}
          >
            <span style={{ flex: 1, fontSize: 'var(--type-body-md)', color: 'var(--text-dim)' }}>
              {c.name} <span style={{ color: 'var(--text-faint)' }}>· {c.platform}</span>
            </span>
            <Switch
              checked={c.subscribed}
              label={`Notify ${c.name}`}
              onChange={(on) => {
                buzz('tap');
                void toggle
                  .mutateAsync({ id: taskId, platform: c.platform, on })
                  .catch((e: unknown) =>
                    toast(e instanceof Error ? e.message : 'Could not change it', 'error'),
                  );
              }}
            />
          </div>
        ))}
      </div>
    </>
  );
}

/** One row of run history, and the way into that run's conversation. */
function RunRow({
  run,
  onOpen,
  navigate,
}: {
  run: TaskRun;
  onOpen: () => void;
  navigate: (to: string) => void;
}) {
  /* Only a run that stamped its own session id gets a link. Guessing per-run is
     not possible — the correlation below works on the *task*, so it can only
     ever point at one run's session and would put the newest run's transcript
     behind every row. */
  const sid = runSessionId(run);
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '7px 0',
        borderBottom: '1px solid var(--border-soft)',
        fontSize: 'var(--type-detail)',
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          flexShrink: 0,
          background:
            run.outcome === 'completed'
              ? 'var(--ok)'
              : run.outcome === 'blocked'
                ? 'var(--warn)'
                : run.status === 'running'
                  ? 'var(--accent)'
                  : 'var(--error)',
        }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        {run.summary || run.outcome || run.status}
        {run.profile && (
          <span style={{ color: 'var(--text-faint)', fontSize: 'var(--type-label-sm)' }}> · @{run.profile}</span>
        )}
      </span>
      {sid && (
        <button
          className="btn btn--sm"
          style={{ flexShrink: 0 }}
          onClick={() => {
            buzz('tap');
            const p = run.profile ? `&profile=${encodeURIComponent(run.profile)}` : '';
            onOpen();
            navigate(`/chat?resume=${encodeURIComponent(sid)}${p}`);
          }}
        >
          Open
        </button>
      )}
      <span style={{ color: 'var(--text-faint)', fontSize: 'var(--type-label-sm)', flexShrink: 0 }}>
        {relTime(run.started_at)}
      </span>
    </div>
  );
}

/**
 * "Open the conversation this task is running in."
 *
 * Worth its own component because the honest states outnumber the happy one.
 * The task row carries no `session_id` for a *run* — the column exists but
 * holds the session that *created* the card — so this is either the session id
 * a finished run stamped into its metadata, or a title correlation. See
 * `useTaskSession`: the correlation misses whenever the auxiliary model never
 * titled the session, which is most of them on a busy board and is why this
 * used to report nothing for perfectly ordinary subtasks.
 *
 * So *not found* still has to read as "nothing to show yet", never as "it never
 * ran" — and it is no longer the end of the road, because the worker log sits
 * directly below and does not depend on any of this.
 */
function TaskSessionLink({
  task,
  runs,
  onOpen,
  navigate,
}: {
  task: Task;
  runs: TaskRun[];
  onOpen: () => void;
  navigate: (to: string) => void;
}) {
  const { profile, sessionHint } = latestRunHints(runs, task);
  const { data: session, isLoading } = useTaskSession(
    task.id,
    profile,
    sessionHint,
    // Only a card that is running or queued can still acquire a session;
    // anything else is looked up once and left alone.
    task.status === 'running' || task.status === 'ready' || task.status === 'scheduled',
  );
  const started = task.started_at !== null || task.current_run_id !== null || runs.length > 0;

  // Nothing has run and nothing is running: an absent session is simply the
  // truth, and a row saying so would be noise on every fresh card.
  if (!started && !session) return null;

  return (
    <>
      <Label>CONVERSATION</Label>
      <div style={{ marginBottom: 14 }}>
        {session ? (
          <button
            className="btn btn--sm"
            style={{ width: '100%', justifyContent: 'space-between' }}
            onClick={() => {
              buzz('tap');
              /* The profile travels with the id. Sessions live in per-profile
                 stores, and a resume that does not name the profile looks the
                 id up in the active one and finds nothing. */
              const p = session.profile ? `&profile=${encodeURIComponent(session.profile)}` : '';
              onOpen();
              navigate(`/chat?resume=${encodeURIComponent(session.id)}${p}`);
            }}
          >
            <span style={{ color: 'var(--text-dim)' }}>
              {session.is_active && !session.ended_at ? 'Running now' : 'Open transcript'}
            </span>
            <span style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)' }}>
              {session.message_count ?? 0} messages
            </span>
          </button>
        ) : (
          <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', lineHeight: 1.45 }}>
            {isLoading
              ? 'Looking for the conversation…'
              : /* Deliberately not "no session": a run that crashed, or one
                   whose session never got a title, is unfindable rather than
                   absent. The log below is the fallback and always exists. */
                'No conversation found. A run that crashed — or whose session was never titled — leaves nothing to match on; the worker log below is the record either way.'}
          </div>
        )}
      </div>
    </>
  );
}

function parseSkills(value: Task['skills']): string[] {
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === 'string');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function Label({ children }: { children: string }) {
  return (
    <div className="group-head">
      {children}
    </div>
  );
}
