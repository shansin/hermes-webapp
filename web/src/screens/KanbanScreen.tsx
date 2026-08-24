/**
 * Kanban board.
 *
 * Phone layout: one column at a time, selected by a scrollable chip strip,
 * rather than the desktop's side-by-side swimlanes — horizontal panning
 * through eight columns on a 390px screen is miserable. Cards swipe right to
 * advance a stage and left to delete.
 *
 * Wide layout: the swimlanes, because that is what the width is for. A board
 * is a comparison — what is stuck in review while three things run — and the
 * column-at-a-time view can only ever answer one column's worth of that. The
 * chip strip goes with it: it is a column *selector*, and there is nothing to
 * select when every column is already on screen.
 *
 * The two modes share the cards, the handlers and the filter. What differs is
 * only how many columns are rendered at once, so a change to a card's
 * behaviour cannot land in one layout and miss the other.
 */
import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PullToRefresh } from '../components/shared/PullToRefresh';
import { Empty, ErrorNote, SkeletonList } from '../components/shared/misc';
import { IconPlus } from '../components/shared/Icons';
import { TaskCard } from '../components/kanban/TaskCard';
import { TaskSheet } from '../components/kanban/TaskSheet';
import { NewTaskSheet } from '../components/kanban/NewTaskSheet';
import {
  COLUMNS,
  COLUMN_LABEL,
  kanbanKeys,
  useBoard,
  useDeleteTask,
  useUpdateTask,
  type Column,
  type Task,
} from '../api/kanban';
import { useUi } from '../store/ui';
import { buzz } from '../lib/haptics';
import { MenuButton } from '../components/shared/MenuButton';
import { BackButton } from '../components/shared/BackButton';
import { useWideLayout } from '../lib/useMediaQuery';

/** Where "advance this card" sends it, per column. */
const NEXT_STAGE: Partial<Record<Column, Column>> = {
  triage: 'todo',
  todo: 'ready',
  scheduled: 'ready',
  ready: 'running',
  running: 'review',
  blocked: 'todo',
  review: 'done',
};

/** The chip that means "no assignee filter". Leading space: never a real name. */
const ALL = ' all';

export function KanbanScreen() {
  const wide = useWideLayout();
  // Null until the board arrives, so the first render can land on a column
  // that actually has cards rather than showing an empty "To do" over a
  // populated board.
  const [active, setActive] = useState<Column | null>(null);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /**
   * Which agent's cards to show.
   *
   * Not cosmetic once a second profile exists: the dispatcher claims per
   * assignee, so "what is the research profile actually working on" was a
   * question the board could not answer — the answer sat in an `@name` line
   * at the foot of every card, to be assembled by eye.
   */
  const [assignee, setAssignee] = useState<string>(ALL);

  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const { data, isLoading, error, refetch } = useBoard();
  const update = useUpdateTask();
  const del = useDeleteTask();

  /**
   * The filter applied once, to the whole board.
   *
   * Counts have to come from the *filtered* lists or the chip strip
   * contradicts what is under it: a "3" over an empty column reads as a broken
   * board, not as a filter doing its job.
   */
  const columns = useMemo(() => {
    const byName = new Map<Column, Task[]>();
    for (const c of data?.columns ?? []) {
      byName.set(
        c.name,
        assignee === ALL ? c.tasks : c.tasks.filter((t) => t.assignee === assignee),
      );
    }
    return byName;
  }, [data, assignee]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const [name, tasks] of columns) m.set(name, tasks.length);
    return m;
  }, [columns]);

  // Resolve the shown column: an explicit pick wins, otherwise the first
  // column carrying cards, otherwise the board's default landing column.
  const shown: Column = active ?? (COLUMNS.find((c) => (counts.get(c) ?? 0) > 0) ?? 'todo');

  /**
   * The card handlers are stable so `TaskCard`'s memo actually holds. The
   * board refetches every 10s; React Query's structural sharing keeps each
   * unchanged task object identical, so with stable callbacks an unchanged
   * card skips re-rendering entirely.
   *
   * `mutateAsync` keeps its identity across renders — depending on the
   * mutation object itself would not.
   */
  const updateTask = update.mutateAsync;
  const deleteTask = del.mutateAsync;

  /**
   * The destination is a parameter rather than something read from `shown`.
   *
   * It used to be the latter, which was correct exactly as long as one column
   * was on screen at a time. In the swimlane layout the card being advanced is
   * usually not in the selected column, and a handler consulting `shown` would
   * file it under whatever the chip strip last pointed at. Taking it from the
   * lane that rendered the card is both correct and stable — the value is a
   * constant per lane, so the memo still holds.
   */
  const advanceById = useCallback(
    async (id: string, to: Column) => {
      buzz('done');
      try {
        await updateTask({ id, status: to });
        toast(`Moved to ${COLUMN_LABEL[to]}`, 'success');
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Could not move the card', 'error');
      }
    },
    [updateTask, toast],
  );

  const removeById = useCallback(
    async (id: string) => {
      buzz('warn');
      try {
        await deleteTask(id);
        toast('Task deleted', 'success');
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Delete failed', 'error');
      }
    },
    [deleteTask, toast],
  );

  const openTaskById = useCallback((id: string) => setOpenTask(id), []);

  // The kanban plugin may not be installed on every Hermes profile.
  const unavailable = error && (error as { status?: number }).status === 404;

  /**
   * Names to offer as filters: whoever the board reports, plus whoever is
   * actually on a card. The two disagree on a board still carrying tasks
   * assigned to a profile that has since been deleted, and dropping that name
   * would hide those cards behind a filter with no chip to release it.
   */
  const assignees = useMemo(() => {
    const names = new Set<string>(data?.assignees ?? []);
    for (const c of data?.columns ?? []) {
      for (const t of c.tasks) if (t.assignee) names.add(t.assignee);
    }
    return [...names].sort();
  }, [data]);

  return (
    <div className="screen">
      <div className="header">
        <MenuButton />
        <BackButton />
        <div className="header__title">
          Kanban
          {assignee !== ALL && <span className="header__sub"> · @{assignee}</span>}
        </div>
      </div>

      {/* One chip per agent, and only once there is more than one to tell
          apart. A filter offering a single choice is furniture. */}
      {assignees.length > 1 && (
        <div className="kanban__filter">
          <button
            className={`chip${assignee === ALL ? ' chip--active' : ''}`}
            onClick={() => {
              buzz('tap');
              setAssignee(ALL);
            }}
          >
            Everyone
          </button>
          {assignees.map((a) => (
            <button
              key={a}
              className={`chip${assignee === a ? ' chip--active' : ''}`}
              onClick={() => {
                buzz('tap');
                setAssignee(a);
              }}
            >
              @{a}
            </button>
          ))}
        </div>
      )}

      {!wide && (
        <div
          className="btn-group"
          role="tablist"
          aria-label="Board columns"
          style={{ borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}
        >
          {COLUMNS.map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={shown === c}
              className={`btn-group__item${shown === c ? ' btn-group__item--active' : ''}`}
              onClick={() => {
                buzz('tap');
                setActive(c);
              }}
            >
              {COLUMN_LABEL[c]}
              {(counts.get(c) ?? 0) > 0 && <span className="btn-group__count">{counts.get(c)}</span>}
            </button>
          ))}
        </div>
      )}

      {unavailable ? (
        <Empty
          icon="📋"
          title="Kanban isn't available"
          hint="The Hermes kanban plugin isn't enabled on this backend."
        />
      ) : isLoading && !data ? (
        <SkeletonList n={4} h={78} />
      ) : error ? (
        <ErrorNote error={error} />
      ) : wide ? (
        /* No pull-to-refresh here: it is a touch gesture, and this layout only
           exists where there is a pointer. The 10s poll keeps it current. */
        <div className="kanban__board">
          {COLUMNS.map((c) => (
            <Lane
              key={c}
              column={c}
              tasks={columns.get(c) ?? []}
              onOpen={openTaskById}
              onAdvance={advanceById}
              onDelete={removeById}
            />
          ))}
        </div>
      ) : (
        <PullToRefresh onRefresh={() => refetch()}>
          <div className="has-fab" style={{ padding: '10px 12px 16px' }}>
            {(counts.get(shown) ?? 0) === 0 ? (
              <Empty
                icon="—"
                title={`Nothing in ${COLUMN_LABEL[shown]}`}
                hint={
                  assignee === ALL
                    ? 'Cards the agent creates appear here automatically.'
                    : `No cards for @${assignee} in this column.`
                }
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(columns.get(shown) ?? []).map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    next={NEXT_STAGE[shown] ?? null}
                    nextLabel={NEXT_STAGE[shown] ? COLUMN_LABEL[NEXT_STAGE[shown]!] : ''}
                    onOpen={openTaskById}
                    onAdvance={advanceById}
                    onDelete={removeById}
                  />
                ))}
              </div>
            )}
          </div>
        </PullToRefresh>
      )}

      {!unavailable && (
        <button className="fab" onClick={() => setCreating(true)} aria-label="New task">
          <IconPlus size={22} />
        </button>
      )}

      <TaskSheet taskId={openTask} onClose={() => setOpenTask(null)} />
      <NewTaskSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => qc.invalidateQueries({ queryKey: kanbanKeys.board })}
      />
    </div>
  );
}

/**
 * One swimlane. Scrolls on its own axis so a hundred-card Done column cannot
 * stretch the board, and keeps its heading pinned while it does.
 */
function Lane({
  column,
  tasks,
  onOpen,
  onAdvance,
  onDelete,
}: {
  column: Column;
  tasks: Task[];
  onOpen: (id: string) => void;
  onAdvance: (id: string, to: Column) => void;
  onDelete: (id: string) => void;
}) {
  const next = NEXT_STAGE[column] ?? null;
  return (
    <section className="lane" aria-label={COLUMN_LABEL[column]}>
      <header className="lane__head">
        <span className="lane__title">{COLUMN_LABEL[column]}</span>
        <span className="lane__count">{tasks.length}</span>
      </header>
      <div className="lane__cards">
        {tasks.length === 0 ? (
          <div className="lane__empty">Empty</div>
        ) : (
          tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              next={next}
              nextLabel={next ? COLUMN_LABEL[next] : ''}
              onOpen={onOpen}
              onAdvance={onAdvance}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </section>
  );
}
