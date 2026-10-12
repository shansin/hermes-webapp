/**
 * One column of the wide (swimlane) board layout.
 *
 * Its own file because it is pure presentation over props: the screen owns
 * selection, the revealed card and every action, and hands them down.
 */
import { Empty } from '../shared/misc';
import { TaskCard } from './TaskCard';
import { COLUMN_LABEL, NEXT_STAGE, type Column, type Task } from '../../api/kanban';

/**
 * One swimlane. Scrolls on its own axis so a hundred-card Done column cannot
 * stretch the board, and keeps its heading pinned while it does.
 */
export function Lane({
  column,
  tasks,
  selecting,
  selected,
  revealed,
  onReveal,
  onOpen,
  onAdvance,
  onDelete,
}: {
  column: string;
  tasks: Task[];
  selecting: boolean;
  selected: ReadonlySet<string>;
  revealed: string | null;
  onReveal: (id: string | null) => void;
  onOpen: (id: string) => void;
  onAdvance: (id: string, to: Column) => void;
  onDelete: (id: string) => void;
}) {
  const next = NEXT_STAGE[column as Column] ?? null;
  const label = COLUMN_LABEL[column as Column] ?? 'Archived';
  return (
    <section className="lane" aria-label={label}>
      <header className="lane__head">
        <span className="lane__title">{label}</span>
        <span className="lane__count">{tasks.length}</span>
      </header>
      <div className="lane__cards">
        {tasks.length === 0 ? (
          <Empty compact icon="—" title={`Nothing in ${label}`} />
        ) : (
          tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              next={next}
              nextLabel={next ? COLUMN_LABEL[next] : ''}
              selecting={selecting}
              selected={selected.has(t.id)}
              revealed={revealed === t.id}
              onReveal={onReveal}
              /* Eight lanes share the height, so a card here shows two lines
                 of summary rather than the six the single column affords. */
              dense
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
