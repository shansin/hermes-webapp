/**
 * Parents and children of a card, and editing them.
 *
 * Hermes' decomposer is the main way a real request becomes work: one card is
 * fanned out into a graph, the children are gated on their parents, and the
 * parent sits in To do until they finish. None of that was visible here. A
 * child showed no sign it belonged to anything, a parent showed no sign
 * anything was running underneath it, and "why is this card not moving" —
 * answered entirely by an unfinished sibling — could not be asked of the board
 * at all.
 *
 * Two details of the endpoint shape this file. `links` is **ids, not tasks**:
 * bare strings, so a row can only show what the board already holds and the
 * detail sheet has to be opened for the rest. And `child_results` is a
 * *separate* array carrying each child's status and summary, which is the half
 * worth reading — so the two are joined here rather than rendering ids alone.
 *
 * The edit controls exist mostly for the inverse operation. Adding an edge by
 * hand is occasionally useful; **removing** one is the thing you cannot do
 * anywhere else, and a wrong edge from a decomposition gates a card
 * indefinitely — the child sits in To do waiting on a parent that has nothing
 * to do with it, and nothing on the board explains why.
 */
import { useMemo, useState } from 'react';
import { COLUMN_LABEL, STATUS_LABEL, useLinkTasks, useUnlinkTasks, type Column, type Task, type TaskDetail } from '../../api/kanban';
import { SelectSheet } from '../shared/SelectSheet';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

type ChildResult = NonNullable<TaskDetail['child_results']>[number];

export function TaskLinks({
  detail,
  board,
  cards,
  onOpen,
}: {
  detail: TaskDetail;
  /** Board slug for the mutations, not the board contents. */
  board: string | null;
  /** Every card on the board, to name a link the API only gives an id for. */
  cards: Map<string, Task>;
  onOpen: (id: string) => void;
}) {
  const parents = detail.links?.parents ?? [];
  const children = detail.links?.children ?? [];
  const link = useLinkTasks(board);
  const unlink = useUnlinkTasks(board);
  const toast = useUi((s) => s.toast);
  const [adding, setAdding] = useState<'parent' | 'child' | null>(null);

  const results = new Map<string, ChildResult>((detail.child_results ?? []).map((c) => [c.id, c]));

  const rowFor = (id: string) => {
    const result = results.get(id);
    const card = cards.get(id);
    return {
      id,
      title: result?.title ?? card?.title ?? null,
      status: result?.status ?? card?.status ?? null,
      summary: result?.latest_summary ?? card?.latest_summary ?? null,
    };
  };

  const done = children.filter((id) => rowFor(id).status === 'done').length;

  /**
   * What can be linked: every other card, minus the ones already linked.
   *
   * Self is excluded because Hermes would accept it and the card would then
   * gate on itself — permanently unreachable, with no error to explain it.
   */
  const candidates = useMemo(() => {
    const taken = new Set([detail.task.id, ...parents, ...children]);
    return [...cards.values()]
      .filter((t) => !taken.has(t.id))
      .map((t) => ({
        value: t.id,
        label: t.title,
        hint: `${STATUS_LABEL[t.status] ?? t.status}${t.assignee ? ` · @${t.assignee}` : ''}`,
      }));
  }, [cards, detail.task.id, parents, children]);

  const addLink = async (otherId: string) => {
    const asParent = adding === 'parent';
    buzz('tap');
    try {
      await link.mutateAsync({
        parentId: asParent ? otherId : detail.task.id,
        childId: asParent ? detail.task.id : otherId,
      });
      toast(asParent ? 'Now waiting on that card' : 'Subtask linked', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not link', 'error');
    }
  };

  const removeLink = async (otherId: string, asParent: boolean) => {
    buzz('warn');
    try {
      await unlink.mutateAsync({
        parentId: asParent ? otherId : detail.task.id,
        childId: asParent ? detail.task.id : otherId,
      });
      toast('Link removed', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not unlink', 'error');
    }
  };

  return (
    <>
      <div className="group-head">
        BLOCKED BY{parents.length > 0 ? ` · ${parents.length}` : ''}
      </div>
      <div style={{ marginBottom: 14 }}>
        {parents.map((id) => (
          <LinkRow key={id} {...rowFor(id)} onOpen={onOpen} onRemove={() => void removeLink(id, true)} />
        ))}
        <button className="btn btn--sm" style={{ width: '100%' }} onClick={() => setAdding('parent')}>
          {parents.length ? 'Add another blocker' : 'Wait for another card'}
        </button>
      </div>

      <div className="group-head">
        SUBTASKS{children.length > 0 ? ` · ${done}/${children.length} DONE` : ''}
      </div>
      <div style={{ marginBottom: 14 }}>
        {children.map((id) => (
          <LinkRow key={id} {...rowFor(id)} onOpen={onOpen} onRemove={() => void removeLink(id, false)} />
        ))}
        <button className="btn btn--sm" style={{ width: '100%' }} onClick={() => setAdding('child')}>
          Link an existing card as a subtask
        </button>
      </div>

      <SelectSheet
        open={adding !== null}
        title={adding === 'parent' ? 'Wait for which card?' : 'Which card is a subtask?'}
        options={candidates}
        value={null}
        onChange={(id) => void addLink(id)}
        onClose={() => setAdding(null)}
        empty="Every other card on this board is already linked."
      />
    </>
  );
}

function LinkRow({
  id,
  title,
  status,
  summary,
  onOpen,
  onRemove,
}: {
  id: string;
  title: string | null;
  status: string | null;
  summary: string | null;
  onOpen: (id: string) => void;
  onRemove: () => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'stretch', marginBottom: 6 }}>
      <button
        className="btn btn--sm"
        style={{ flex: 1, textAlign: 'left', display: 'block', padding: '9px 11px', height: 'auto', minWidth: 0 }}
        onClick={() => {
          buzz('tap');
          onOpen(id);
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ flex: 1, minWidth: 0, fontWeight: 550 }}>
            {/* A card that is neither on the filtered board nor in child_results
                — archived, or another tenant's — still gets a row. Its id is the
                honest thing to show, and it still opens. */}
            {title ?? id}
          </span>
          {status && (
            <span style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', flexShrink: 0 }}>
              {COLUMN_LABEL[status as Column] ?? STATUS_LABEL[status] ?? status}
            </span>
          )}
        </div>
        {summary && (
          <div
            style={{
              marginTop: 4,
              fontSize: 'var(--type-body-sm)',
              color: 'var(--text-dim)',
              fontWeight: 400,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {summary}
          </div>
        )}
      </button>
      <button
        className="btn btn--sm"
        style={{ flexShrink: 0 }}
        aria-label="Remove this link"
        title="Remove this link"
        onClick={onRemove}
      >
        ✕
      </button>
    </div>
  );
}
