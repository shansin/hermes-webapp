/**
 * Pick one thing out of a list, on a phone.
 *
 * The single-select counterpart to `MultiSelectSheet`, and it exists for the
 * same reason: a wrapped row of chips is a fine control for three choices and
 * a bad one past that. Every profile picker in the app was such a rail — one
 * chip per profile on Sessions, Skills, Kanban, the cron form and the task
 * sheets — so the number of controls on screen grew with the number of agents
 * configured, and on Sessions three rails stacked before the list began.
 *
 * A dropdown costs one row whatever the count, and says what is selected
 * without the reader having to find the highlighted chip. The menu itself is a
 * bottom sheet rather than an anchored popover: sheets are already the modal
 * idiom here, they nest (`useHistoryDismiss` stacks, so back closes the picker
 * and leaves a half-filled form alone), and a native `<select>` cannot carry
 * the per-row hint that says which profile is the active one.
 *
 * The filter appears only once the list is long enough to need it — on two
 * profiles it is a text field between you and an answer you can already see.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { IconCheck, IconDown, IconSearch } from './Icons';
import { buzz } from '../../lib/haptics';

export interface SelectOption {
  /** The value handed back to `onChange`. */
  value: string;
  label: string;
  /** A second line under the label — what this choice means. */
  hint?: string;
  /** Rendered at the end of the row: a count, an "active" marker. */
  meta?: ReactNode;
}

/** Past this many options the sheet grows a filter field. */
const FILTER_AT = 8;

export function SelectSheet({
  open,
  title,
  options,
  value,
  onChange,
  onClose,
  empty = 'Nothing to choose from.',
}: {
  open: boolean;
  title: string;
  options: SelectOption[];
  /** The currently selected value, if it is one of the options. */
  value: string | null;
  onChange: (value: string) => void;
  onClose: () => void;
  empty?: string;
}) {
  const [filter, setFilter] = useState('');

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q),
    );
  }, [options, filter]);

  return (
    <Sheet open={open} title={title} onClose={onClose}>
      {options.length > FILTER_AT && (
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <IconSearch
            size={16}
            style={{
              position: 'absolute',
              left: 11,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-faint)',
            }}
          />
          <input
            className="field"
            style={{ paddingLeft: 34, width: '100%' }}
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}

      {options.length === 0 ? (
        <div style={{ color: 'var(--text-faint)', fontSize: 'var(--type-detail)' }}>{empty}</div>
      ) : shown.length === 0 ? (
        <div style={{ color: 'var(--text-faint)', fontSize: 'var(--type-detail)' }}>
          Nothing matches “{filter}”.
        </div>
      ) : (
        <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {shown.map((o) => {
            const on = o.value === value;
            return (
              <button
                key={o.value}
                role="radio"
                aria-checked={on}
                onClick={() => {
                  buzz('tap');
                  onChange(o.value);
                  /* Chosen is done: a single-select sheet that stays open
                     leaves you looking for a Save button that is not there. */
                  onClose();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: on ? 'var(--accent-soft)' : 'var(--bg-elev-2)',
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border-soft)'}`,
                  textAlign: 'left',
                  minHeight: 'var(--tap-min)',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 'var(--type-body-md)',
                      color: on ? 'var(--accent)' : 'var(--text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {o.label}
                  </span>
                  {o.hint && (
                    <span
                      style={{
                        display: 'block',
                        fontSize: 'var(--type-label-sm)',
                        color: 'var(--text-faint)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {o.hint}
                    </span>
                  )}
                </span>
                {o.meta && (
                  <span
                    style={{
                      fontSize: 'var(--type-label-sm)',
                      color: 'var(--text-faint)',
                      flexShrink: 0,
                    }}
                  >
                    {o.meta}
                  </span>
                )}
                {on && <IconCheck size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

/**
 * The compact trigger for one of these, sized to sit in a filter rail.
 *
 * Built on `.chip` so it lines up with the lane and tag chips beside it, and
 * marked `--active` only when the selection is a narrowing — an unfiltered
 * dropdown should read as quietly as the rail it replaced.
 */
export function SelectChip({
  label,
  value,
  active = false,
  onOpen,
}: {
  /** What is being chosen, dimmed in front of the value. Omit for just a value. */
  label?: string;
  value: ReactNode;
  active?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      className={`chip${active ? ' chip--active' : ''}`}
      onClick={() => {
        buzz('tap');
        onOpen();
      }}
      aria-haspopup="dialog"
    >
      {label && <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>{label}</span>}
      <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
      <IconDown size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
    </button>
  );
}
