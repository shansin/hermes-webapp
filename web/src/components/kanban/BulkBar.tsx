/**
 * The action bar shown while cards are selected on the board.
 *
 * Its own file because it owns nothing of the screen's: it holds only which
 * picker is open and reports the chosen patch through `onApply`.
 */
import { useState } from 'react';
import { SelectSheet } from '../shared/SelectSheet';
import { COLUMNS, COLUMN_LABEL } from '../../api/kanban';

/**
 * What can be done to a selection.
 *
 * Deliberately three verbs and not the whole PATCH surface: a bulk action is a
 * blunt instrument, and the ones worth having are the ones that are tedious
 * card by card. Archiving is offered instead of deleting because there is no
 * undo on a bulk delete anywhere in Hermes, and a mis-tapped selection is
 * exactly how one happens.
 */
export function BulkBar({
  count,
  busy,
  assignees,
  onApply,
}: {
  count: number;
  busy: boolean;
  assignees: string[];
  onApply: (patch: {
    status?: string;
    assignee?: string | null;
    archive?: boolean;
    reclaim_first?: boolean;
  }) => void;
}) {
  const [picking, setPicking] = useState<'status' | 'assignee' | null>(null);

  return (
    <>
      <div
        style={{
          display: 'flex',
          gap: 7,
          padding: '10px 12px',
          background: 'var(--bg-elev)',
          borderTop: '1px solid var(--border-soft)',
          flexShrink: 0,
        }}
      >
        <button className="btn btn--sm" style={{ flex: 1 }} disabled={busy} onClick={() => setPicking('status')}>
          Move
        </button>
        <button
          className="btn btn--sm"
          style={{ flex: 1 }}
          disabled={busy}
          onClick={() => setPicking('assignee')}
        >
          Assign
        </button>
        <button
          className="btn btn--sm"
          style={{ flex: 1 }}
          disabled={busy}
          onClick={() => onApply({ archive: true })}
        >
          Archive {count}
        </button>
      </div>

      <SelectSheet
        open={picking === 'status'}
        title={`Move ${count} card${count > 1 ? 's' : ''} to`}
        value={null}
        /* `running` is missing on purpose: Hermes answers 400 for a direct
           write to it — the dispatcher owns that transition — so offering it
           would be offering a guaranteed failure. */
        options={COLUMNS.filter((c) => c !== 'running').map((c) => ({
          value: c,
          label: COLUMN_LABEL[c],
        }))}
        onChange={(status) => onApply({ status })}
        onClose={() => setPicking(null)}
      />
      <SelectSheet
        open={picking === 'assignee'}
        title={`Assign ${count} card${count > 1 ? 's' : ''} to`}
        value={null}
        options={[
          { value: '', label: 'Nobody', hint: 'The dispatcher will skip them silently' },
          ...assignees.map((a) => ({ value: a, label: `@${a}` })),
        ]}
        /* `reclaim_first`, because a selection made off the board will sooner
           or later include a card a worker currently holds — and without it
           Hermes refuses that one card and reports a partial failure the
           person cannot act on from here. */
        onChange={(name) => onApply({ assignee: name || null, reclaim_first: true })}
        onClose={() => setPicking(null)}
      />
    </>
  );
}
