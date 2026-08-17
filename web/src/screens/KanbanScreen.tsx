/**
 * Kanban board.
 *
 * Phone layout: one column at a time, selected by a scrollable chip strip,
 * rather than the desktop's side-by-side swimlanes — horizontal panning
 * through eight columns on a 390px screen is miserable. Cards swipe right to
 * advance a stage and left to delete.
 */
import { useMemo, useState } from 'react';
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
} from '../api/kanban';
import { useUi } from '../store/ui';
import { buzz } from '../lib/haptics';

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

export function KanbanScreen() {
  // Null until the board arrives, so the first render can land on a column
  // that actually has cards rather than showing an empty "To do" over a
  // populated board.
  const [active, setActive] = useState<Column | null>(null);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const { data, isLoading, error, refetch } = useBoard();
  const update = useUpdateTask();
  const del = useDeleteTask();

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of data?.columns ?? []) m.set(c.name, c.tasks.length);
    return m;
  }, [data]);

  // Resolve the shown column: an explicit pick wins, otherwise the first
  // column carrying cards, otherwise the board's default landing column.
  const shown: Column =
    active ?? (COLUMNS.find((c) => (counts.get(c) ?? 0) > 0) ?? 'todo');

  const tasks = data?.columns.find((c) => c.name === shown)?.tasks ?? [];

  const advance = async (id: string) => {
    const to = NEXT_STAGE[shown];
    if (!to) return;
    buzz('done');
    try {
      await update.mutateAsync({ id, status: to });
      toast(`Moved to ${COLUMN_LABEL[to]}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not move the card', 'error');
    }
  };

  const remove = async (id: string) => {
    buzz('warn');
    try {
      await del.mutateAsync(id);
      toast('Task deleted', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error');
    }
  };

  // The kanban plugin may not be installed on every Hermes profile.
  const unavailable =
    error && (error as { status?: number }).status === 404;

  return (
    <div className="screen">
      <div className="header">
        <div className="header__title">Kanban</div>
      </div>

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
            {(counts.get(c) ?? 0) > 0 && (
              <span className="btn-group__count">{counts.get(c)}</span>
            )}
          </button>
        ))}
      </div>

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
      ) : (
        <PullToRefresh onRefresh={() => refetch()}>
          <div className="has-fab" style={{ padding: '10px 12px 16px' }}>
            {tasks.length === 0 ? (
              <Empty
                icon="—"
                title={`Nothing in ${COLUMN_LABEL[shown]}`}
                hint="Cards the agent creates appear here automatically."
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {tasks.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    canAdvance={Boolean(NEXT_STAGE[shown])}
                    nextLabel={NEXT_STAGE[shown] ? COLUMN_LABEL[NEXT_STAGE[shown]!] : ''}
                    onOpen={() => setOpenTask(t.id)}
                    onAdvance={() => void advance(t.id)}
                    onDelete={() => void remove(t.id)}
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
