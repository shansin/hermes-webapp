/**
 * The board screen's overflow menu.
 *
 * Its own file because it is self-contained — four fixed actions handed back
 * to the screen through `onPick` — and the screen is long enough without it.
 */
import { Sheet } from '../shared/Sheet';
import { buzz } from '../../lib/haptics';

/**
 * The overflow. One sheet rather than four more icons in a header that already
 * carries a menu, a back arrow, a title and a search.
 *
 * Built on `Sheet` directly rather than on `SelectSheet`, which is what it was
 * first: these are *actions*, not values. `SelectSheet` renders a
 * `role="radiogroup"` of `role="radio"` rows with a checkmark on the current
 * one, which announces "Board health" to a screen reader as an option that can
 * be selected or not — and there is no current one to mark, so it was passed
 * `value={null}` to suppress a control it should never have had.
 */
export type BoardAction = 'health' | 'settings' | 'select' | 'archived';

export function BoardMenuSheet({
  open,
  archived,
  onClose,
  onPick,
}: {
  open: boolean;
  archived: boolean;
  onClose: () => void;
  onPick: (action: BoardAction) => void;
}) {
  const items: { action: BoardAction; label: string; hint: string }[] = [
    { action: 'health', label: 'Board health', hint: 'Queue age, diagnostics, live workers' },
    { action: 'settings', label: 'Board settings', hint: 'Routing, orchestration, boards' },
    { action: 'select', label: 'Select cards', hint: 'Move, assign or archive several at once' },
    {
      action: 'archived',
      label: archived ? 'Hide archived cards' : 'Show archived cards',
      hint: archived ? 'Back to the eight working columns' : 'Adds a ninth column',
    },
  ];

  return (
    <Sheet open={open} title="Board" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.map((item) => (
          <button
            key={item.action}
            onClick={() => {
              buzz('tap');
              onPick(item.action);
            }}
            style={{
              display: 'block',
              width: '100%',
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--border-soft)',
              textAlign: 'left',
              minHeight: 'var(--tap-min)',
            }}
          >
            <span style={{ display: 'block', fontSize: 'var(--type-body-md)', color: 'var(--text)' }}>
              {item.label}
            </span>
            <span
              style={{
                display: 'block',
                fontSize: 'var(--type-label-sm)',
                color: 'var(--text-faint)',
              }}
            >
              {item.hint}
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
