/**
 * Pick several things out of a long list, on a phone.
 *
 * Built for pinning skills and toolsets onto a cron job, where the list is
 * whatever that profile happens to have — twenty on a stock install, well past
 * a hundred once the skill hub has been used. A wrapped row of chips is fine
 * for four profiles and unusable for that, so this is a sheet with a filter and
 * a row per item.
 *
 * Two things are deliberate:
 *
 * - **Empty is a meaningful answer**, and not the same as "none". Everywhere
 *   this is used, selecting nothing means "inherit whatever the profile has
 *   enabled" — so the sheet says that in words rather than leaving the reader
 *   to guess whether an empty selection disables everything.
 * - **Selection is committed as you go**, not on a Save button. The sheet is
 *   opened from a form that is itself not saved yet; a second layer of
 *   commit/cancel semantics over the top of that is how you end up unsure
 *   which one Cancel is cancelling.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { IconCheck, IconSearch } from './Icons';
import { buzz } from '../../lib/haptics';

export interface MultiSelectOption {
  /** The value stored in the selection. */
  value: string;
  label: string;
  hint?: string;
  /** Rendered at the end of the row — a group name, a "no key" warning. */
  meta?: ReactNode;
  /** Selectable but flagged; the row explains itself through `meta`. */
  dimmed?: boolean;
}

export function MultiSelectSheet({
  open,
  title,
  options,
  selected,
  onChange,
  onClose,
  loading = false,
  emptyMeans = 'Nothing selected means the profile decides.',
  emptyList = 'Nothing to choose from.',
}: {
  open: boolean;
  title: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  onClose: () => void;
  loading?: boolean;
  /** One line explaining what an empty selection does. */
  emptyMeans?: string;
  emptyList?: string;
}) {
  const [filter, setFilter] = useState('');

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        (o.hint ?? '').toLowerCase().includes(q),
    );
  }, [options, filter]);

  const chosen = new Set(selected);

  const toggle = (value: string) => {
    buzz('tap');
    onChange(chosen.has(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <Sheet
      open={open}
      title={title}
      onClose={onClose}
      actions={
        selected.length > 0 ? (
          <button className="btn btn--sm" onClick={() => onChange([])}>
            Clear
          </button>
        ) : undefined
      }
    >
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

      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 10, lineHeight: 1.45 }}>
        {selected.length === 0 ? emptyMeans : `${selected.length} selected.`}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-faint)' }}>Loading…</div>
      ) : options.length === 0 ? (
        <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>{emptyList}</div>
      ) : shown.length === 0 ? (
        <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>Nothing matches “{filter}”.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {shown.map((o) => {
            const on = chosen.has(o.value);
            return (
              <button
                key={o.value}
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(o.value)}
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
                  opacity: o.dimmed && !on ? 0.6 : 1,
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 14,
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
                        fontSize: 11.5,
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
                  <span style={{ fontSize: 11, color: 'var(--text-faint)', flexShrink: 0 }}>
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
 * The row that opens one of these from a form: a label, what is currently
 * chosen, and nothing else. Same shape as the model row on the profile sheet,
 * so a form built out of both reads as one thing.
 */
export function PickerRow({
  label,
  value,
  onOpen,
  disabled = false,
}: {
  label: string;
  value: string;
  onOpen: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="btn btn--sm"
      style={{ width: '100%', justifyContent: 'space-between' }}
      onClick={() => {
        buzz('tap');
        onOpen();
      }}
      disabled={disabled}
    >
      <span style={{ color: 'var(--text-dim)' }}>{label}</span>
      <span
        style={{
          marginLeft: 8,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </button>
  );
}
