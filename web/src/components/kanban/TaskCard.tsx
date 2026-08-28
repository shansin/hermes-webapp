/**
 * A kanban card.
 *
 * **Long-press reveals its two actions; it no longer swipes.** The card used to
 * own horizontal drags — right to advance a stage, left to delete — which was
 * the only way to move a card on a phone, since the buttons were hover-only.
 * That gesture was in the way of the one the board needed more: eight columns
 * is a lot of chip-tapping, and paging between them is what a horizontal swipe
 * on a board means everywhere else. A card cannot claim horizontal drags and
 * let the board page on them too, so the card gave way.
 *
 * Long-press rather than losing the actions altogether, because moving a card
 * *is* what a board is for and the alternative — open the card, find the status
 * chips, tap, dismiss — is four steps for something that should be one. The
 * revealed state is owned by the board rather than the card (`revealed`), so
 * only one card can be armed at a time and everything that ought to cancel it —
 * paging, scrolling, tapping elsewhere — can.
 *
 * On a device with a pointer the same two buttons still appear on hover, which
 * costs no gesture at all.
 *
 * **The card grows to fit what it has to say.** The summary was clamped to two
 * lines at every size, which in the phone layout — one column, full width,
 * nothing competing for the space — threw away the part of a finished card
 * worth reading. It is clamped by *layout* now: generously in the single
 * column, tightly in a swimlane where eight lanes share the height. A card with
 * no summary yet falls back to its description, which was otherwise invisible
 * until the card was opened.
 */
import { memo, useRef } from 'react';
import { IconChevron, IconTrash } from '../shared/Icons';
import { relTime } from '../shared/misc';
import { buzz } from '../../lib/haptics';
import { warningKinds } from '../../api/kanban';
import type { Column, Task } from '../../api/kanban';

/** How long a press has to be held before it counts as one. */
const LONG_PRESS_MS = 420;
/** Movement that turns a press into a scroll or a page, cancelling it. */
const PRESS_SLOP_PX = 10;

const PRIORITY_COLOR = ['var(--text-faint)', 'var(--info)', 'var(--warn)', 'var(--error)'];

/**
 * `block_kind` in words. The raw values are Hermes-internal
 * (`needs_input`, `capability`, `transient`, `dependency`) and the card was
 * printing them verbatim, so the most actionable card on the board announced
 * itself as "blocked: needs_input". Only rendered in the Blocked column: the
 * column already says blocked, and `block_kind` survives an unblock — printing
 * it on a card that is running again is stating a fact about the past.
 */
const BLOCK_LABEL: Record<string, string> = {
  needs_input: 'needs your answer',
  capability: 'needs a capability',
  transient: 'transient failure',
  dependency: 'waiting on a parent',
};

interface Props {
  task: Task;
  /**
   * Where advancing sends this card, or null for a column with nowhere to go.
   * A prop rather than something the board derives at the moment of the tap:
   * in the swimlane layout the card's own lane is the only thing that knows.
   */
  next: Column | null;
  nextLabel: string;
  /**
   * The handlers take the task id rather than closing over it, so the board
   * can pass the same function to every card. With per-card arrows the memo
   * below would never hit: a new closure each render counts as a changed prop.
   */
  onOpen: (id: string) => void;
  onAdvance: (id: string, to: Column) => void;
  onDelete: (id: string) => void;
  /**
   * Selection mode, for the board's bulk actions.
   *
   * While it is on the card's own verbs are suppressed rather than merely
   * hidden — no long-press, no buttons — and the tap toggles selection instead
   * of opening. A card whose actions still worked while three of its
   * neighbours were ticked is a card you move by accident.
   */
  selecting?: boolean;
  selected?: boolean;
  /** Whether this card's actions are showing. Owned by the board, not the card. */
  revealed?: boolean;
  onReveal: (id: string | null) => void;
  /** Lanes are short; the single column is not. Decides how much summary shows. */
  dense?: boolean;
}

export const TaskCard = memo(function TaskCard({
  task,
  next,
  nextLabel,
  onOpen,
  onAdvance,
  onDelete,
  selecting = false,
  selected = false,
  revealed = false,
  onReveal,
  dense = false,
}: Props) {
  const canAdvance = next !== null && !selecting;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  /** Set when a long press fired, so the touch ending it is not also a tap. */
  const held = useRef(false);

  const cancelPress = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t || selecting) return;
    held.current = false;
    start.current = { x: t.clientX, y: t.clientY };
    timer.current = setTimeout(() => {
      timer.current = null;
      held.current = true;
      buzz('warn');
      onReveal(task.id);
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const from = start.current;
    if (!t || !from) return;
    /* Any real movement is a scroll or a board page, and neither should end
       with two buttons appearing under the thumb that was doing it. */
    if (Math.abs(t.clientX - from.x) > PRESS_SLOP_PX || Math.abs(t.clientY - from.y) > PRESS_SLOP_PX) {
      cancelPress();
    }
  };

  const failing = task.consecutive_failures > 0;
  /* The summary is what a finished card is *for*; the description is what an
     unstarted one has instead. Showing whichever exists means a card in Triage
     is no longer a bare title. */
  const blurb = task.latest_summary ?? task.body ?? null;

  return (
    <div
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={cancelPress}
      onTouchCancel={cancelPress}
      /* A long press on text is a selection gesture on both platforms, and the
         OS callout would land on top of the buttons being revealed. */
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        // The touch that completes a long press must not also open the card.
        if (held.current) {
          held.current = false;
          return;
        }
        buzz('tap');
        if (revealed) onReveal(null);
        else onOpen(task.id);
      }}
      aria-pressed={selecting ? selected : undefined}
      className={`tcard${revealed ? ' tcard--revealed' : ''}`}
      style={{
        position: 'relative',
        background: selected
          ? 'color-mix(in srgb, var(--accent) 14%, var(--bg-elev))'
          : 'var(--bg-elev)',
        border: `1px solid ${selected ? 'var(--accent)' : failing ? 'var(--error)' : 'var(--border-soft)'}`,
        borderLeft: `3px solid ${PRIORITY_COLOR[Math.min(task.priority, 3)]}`,
        borderRadius: 'var(--radius-sm)',
        padding: '12px 13px',
        cursor: 'pointer',
      }}
    >
      {/* Revealed by a long press on touch, by hover where there is a pointer.
          `tabIndex={-1}` because the keyboard path to both actions is the
          detail sheet, which is where they can be read before being taken —
          two unlabelled icons in every card's tab order would make walking a
          full board unbearable. */}
      <div className="tcard__actions" hidden={selecting}>
        {canAdvance && (
          <button
            className="icon-btn"
            tabIndex={-1}
            aria-label={`Move to ${nextLabel}`}
            title={`Move to ${nextLabel}`}
            onClick={(e) => {
              e.stopPropagation();
              onReveal(null);
              if (next) onAdvance(task.id, next);
            }}
          >
            <IconChevron size={16} />
          </button>
        )}
        <button
          className="icon-btn icon-btn--danger"
          tabIndex={-1}
          aria-label="Delete task"
          title="Delete task"
          onClick={(e) => {
            e.stopPropagation();
            onReveal(null);
            onDelete(task.id);
          }}
        >
          <IconTrash size={15} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        {selecting && (
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              width: 16,
              height: 16,
              borderRadius: 4,
              border: `2px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
              background: selected ? 'var(--accent)' : 'transparent',
              color: '#fff',
              fontSize: 11,
              lineHeight: '13px',
              textAlign: 'center',
            }}
          >
            {selected ? '✓' : ''}
          </span>
        )}
        <span style={{ fontWeight: 550, fontSize: 'var(--type-body-md)', lineHeight: 1.35 }}>
          {task.title}
        </span>
      </div>

      {blurb && (
        <div
          style={{
            fontSize: 'var(--type-body-sm)',
            color: 'var(--text-dim)',
            marginTop: 5,
            lineHeight: 1.45,
            display: '-webkit-box',
            /* Two lines was the phone's budget when the board was a list of
               titles. One full-width column has room for a paragraph, and a
               summary cut mid-sentence is the shape of a card you have to open
               to learn anything from. A lane still gets two: eight of them
               share the height. */
            WebkitLineClamp: dense ? 2 : 6,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {blurb}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: 9,
          marginTop: 8,
          fontSize: 'var(--type-label-sm)',
          color: 'var(--text-faint)',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontFamily: 'var(--mono)' }}>{task.id}</span>
        {task.assignee && <span>@{task.assignee}</span>}
        {/* A claimed run, which is not the same as sitting in the Running
            column: the dispatcher moves a card there before an agent picks
            it up, and a card parked in Running with no run behind it is the
            shape a stuck board takes. */}
        {task.current_run_id !== null && (
          <span className="tcard__live">
            <span className="tcard__live-dot" aria-hidden />
            running
          </span>
        )}
        {(task.comment_count ?? 0) > 0 && <span>💬 {task.comment_count}</span>}
        {failing && (
          <span style={{ color: 'var(--error)', fontWeight: 600 }}>
            ⚠ {task.consecutive_failures} fail{task.consecutive_failures > 1 ? 's' : ''}
          </span>
        )}
        {/* Children done vs total. A decomposed parent sits in To do doing
            nothing visible for as long as its subtasks take, and this is the
            difference between "stuck" and "three of five". */}
        {task.progress && task.progress.total > 0 && (
          <span>
            ☑ {task.progress.done}/{task.progress.total}
          </span>
        )}
        {task.block_kind && task.status === 'blocked' && (
          <span style={{ color: 'var(--warn)', fontWeight: 600 }}>
            {BLOCK_LABEL[task.block_kind] ?? task.block_kind}
          </span>
        )}
        {/* Hermes' own rule engine, which the board endpoint already computes
            and attaches to every card: crash loops, spawn failures, a worker
            citing card ids that do not exist. It was being thrown away, so
            the one thing that knows a card is in trouble was the one thing
            not on it. */}
        {(task.warnings?.count ?? 0) > 0 && (
          <span
            style={{
              color: task.warnings!.highest_severity === 'warning' ? 'var(--warn)' : 'var(--error)',
              fontWeight: 600,
            }}
            title={warningKinds(task.warnings!.kinds)}
          >
            ⚑ {task.warnings!.count}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>{relTime(task.created_at)}</span>
      </div>
    </div>
  );
});
