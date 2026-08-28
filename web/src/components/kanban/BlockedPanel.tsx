/**
 * Answering a blocked card.
 *
 * A blocked card is the agent asking a question and stopping — `block_kind:
 * needs_input` is exactly that, and it is by far the most common one — but the
 * board treated Blocked as just another column. The whole surface for a card
 * that had stopped to ask something was a status chip that moved it, and a
 * comment box at the bottom of the sheet under the run history that said
 * nothing about what it was for. So the reply and the release were two
 * unrelated controls in different parts of a scrolling sheet, in an order that
 * mattered and was nowhere stated, and the honest outcome — comment written,
 * card left blocked — is one this install is currently sitting in.
 *
 * The order matters because Hermes builds the next worker's prompt from title +
 * body + parent results + **comments**. An answer that lands after the card is
 * released is an answer the run that was supposed to read it never saw; the
 * worker rediscovers the same blocker and blocks again — and Hermes counts
 * that (`block_recurrences`), routing the card to Triage on the second repeat.
 * So this is one control that does both, in the right order, and says so.
 *
 * `scheduled` shares the panel because it shares the mechanism exactly: same
 * waiting state, same `unblock_task` release. Only the words differ.
 */
import { useState } from 'react';
import { useUnblockTask, type Task, type TaskRun } from '../../api/kanban';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

/**
 * What each `block_kind` means in words, and whether an answer is what it
 * wants. Hermes' own set is `dependency | needs_input | capability |
 * transient`, plus null for an untyped block from an older worker or a bulk
 * move. `dependency` never reaches this column — it routes to To do for
 * parent-gating — so it is here only for completeness.
 */
const BLOCK_KIND: Record<string, { label: string; hint: string; wantsAnswer: boolean }> = {
  needs_input: {
    label: 'Needs your input',
    hint: 'The agent stopped to ask. Answer below and it picks up where it left off.',
    wantsAnswer: true,
  },
  capability: {
    label: 'Missing a capability',
    hint: "The agent can't do this with the tools or access it has. Say what changed, or give it another way in.",
    wantsAnswer: true,
  },
  transient: {
    label: 'Transient failure',
    hint: 'Something outside failed. Releasing it retries; a note helps if you know what to do differently.',
    wantsAnswer: false,
  },
  dependency: {
    label: 'Waiting on another card',
    hint: 'It resumes on its own when the parent finishes.',
    wantsAnswer: false,
  },
};

export function BlockedPanel({
  task,
  runs,
  board,
}: {
  task: Task;
  runs: TaskRun[];
  board: string | null;
}) {
  const scheduled = task.status === 'scheduled';
  const unblock = useUnblockTask(board);
  const toast = useUi((s) => s.toast);
  const [note, setNote] = useState('');

  const kind = task.block_kind ? BLOCK_KIND[task.block_kind] : undefined;
  const repeats = task.block_recurrences ?? 0;

  /**
   * Why it stopped, in the agent's own words.
   *
   * The run that ended `blocked` carries the reason as its summary, and the
   * card mirrors it into `latest_summary`. Preferring the run means a card
   * that has since run again does not show a stale reason next to a live one.
   */
  const reason =
    runs
      .filter((r) => r.outcome === 'blocked')
      .reduce<TaskRun | null>((best, r) => (best && best.started_at >= r.started_at ? best : r), null)
      ?.summary ??
    task.latest_summary ??
    null;

  const release = async (withNote: boolean) => {
    buzz('tap');
    try {
      const res = await unblock.mutateAsync({ id: task.id, note: withNote ? note : undefined });
      setNote('');
      buzz('done');
      /**
       * Report the status that came back, not the one asked for. `unblock_task`
       * decides where the card lands — it restores the phase it was blocked
       * *from* and re-gates on the parents, so a card with an unfinished parent
       * legitimately lands in To do. Saying "Ready" there would be a small lie
       * that costs someone a hunt through the wrong column.
       */
      toast(`Unblocked — now in ${res.task.status}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not unblock', 'error');
    }
  };

  return (
    <div
      style={{
        border: '1px solid var(--warn)',
        background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
        borderRadius: 'var(--radius-sm)',
        padding: 12,
        marginBottom: 14,
      }}
    >
      <div style={{ fontWeight: 650, fontSize: 'var(--type-body-md)', marginBottom: 3 }}>
        {scheduled ? 'Waiting' : (kind?.label ?? 'Blocked')}
      </div>
      <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-dim)', lineHeight: 1.45 }}>
        {scheduled
          ? 'Parked until something happens. Release it to put it back in the queue.'
          : (kind?.hint ??
            'The agent stopped and left this for a human. Answer below and it picks up where it left off.')}
      </div>

      {reason && (
        <div
          style={{
            marginTop: 9,
            padding: '8px 10px',
            background: 'var(--bg-elev)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--type-body-sm)',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
          }}
        >
          {reason}
        </div>
      )}

      {/* Not decoration: Hermes deliberately never resets this counter on an
          unblock, and at the second repeat it routes the card to Triage instead
          of back here. Answering the same way again is the thing that does not
          work, and this is the only warning of it anywhere. */}
      {repeats > 0 && (
        <div style={{ marginTop: 9, fontSize: 'var(--type-body-sm)', color: 'var(--warn)' }}>
          Blocked for this reason {repeats + 1} times. The same answer will land here again — Hermes
          sends the card to Triage if it repeats once more.
        </div>
      )}

      <textarea
        className="field"
        rows={3}
        value={note}
        placeholder={
          kind?.wantsAnswer === false
            ? 'Anything to do differently this time? (optional)'
            : 'Your answer — what should it do?'
        }
        onChange={(e) => setNote(e.target.value)}
        style={{ resize: 'vertical', margin: '11px 0 8px' }}
      />

      <div style={{ display: 'flex', gap: 7 }}>
        <button
          className="btn btn--primary"
          style={{ flex: 1 }}
          disabled={!note.trim() || unblock.isPending}
          onClick={() => void release(true)}
        >
          {unblock.isPending ? 'Sending…' : 'Send answer & unblock'}
        </button>
        <button className="btn" disabled={unblock.isPending} onClick={() => void release(false)}>
          Just unblock
        </button>
      </div>

      <div style={{ marginTop: 7, fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', lineHeight: 1.45 }}>
        The answer is posted as a comment first, then the card is released — the next run reads the
        comments, so the order is what makes it an answer rather than a note.
      </div>
    </div>
  );
}
