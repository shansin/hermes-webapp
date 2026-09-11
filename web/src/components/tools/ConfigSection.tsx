/**
 * Hermes' config, read-only.
 *
 * **Read-only is the design, not a shortcut.** `PUT /api/config/raw` takes
 * YAML and `PUT /api/config` takes a merged dict; either one, driven from a
 * 390px screen, can leave the agent unable to start, with no undo and nothing
 * validating the value until it fails at boot. What anyone actually wants from
 * a config away from their desk is to *check* something, and that half carries
 * none of the risk.
 *
 * Ninety top-level sections, one of which has fifty-nine keys, so the shape is
 * search-first: collapsed sections, a filter across every flattened path, and
 * matches expanded automatically. The flattening, the search and the redaction
 * rule live in `lib/configTree.ts` and are tested there.
 */
import { useMemo, useState } from 'react';
import { IconSearch, IconChevron } from '../shared/Icons';
import { SkeletonList, ErrorNote, Empty } from '../shared/misc';
import { useHermesConfig, useUpdateHermesConfig } from '../../api/tools';
import { displayValue, searchConfig } from '../../lib/configTree';
import { useDebounced } from '../../lib/useDebounced';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

export function ConfigSection() {
  const { data, isLoading, error } = useHermesConfig(true);
  const [q, setQ] = useState('');
  const query = useDebounced(q, 180);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const update = useUpdateHermesConfig();
  const toast = useUi((s) => s.toast);
  const [editPath, setEditPath] = useState('');
  const [editValue, setEditValue] = useState('');
  const [editConfirm, setEditConfirm] = useState('');
  const [advanced, setAdvanced] = useState(false);

  const sections = useMemo(() => (data ? searchConfig(data, query) : []), [data, query]);
  const searching = query.trim().length > 0;

  return (
    <div style={{ padding: 12 }}>
      <div style={{ position: 'relative', marginBottom: 12 }}>
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
          style={{ paddingLeft: 34 }}
          placeholder="Search every setting…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {isLoading ? (
        <SkeletonList n={8} h={40} />
      ) : error ? (
        <ErrorNote error={error} />
      ) : sections.length === 0 ? (
        <Empty icon="🔍" title="Nothing matches that" />
      ) : (
        sections.map(({ name, rows }) => {
          // A search expands what it found; without one, everything starts shut.
          const expanded = searching || open.has(name);
          return (
            <div className="card" key={name} style={{ marginBottom: 8, padding: 0 }}>
              <button
                className="cfg-head"
                aria-expanded={expanded}
                onClick={() => {
                  buzz('tap');
                  setOpen((prev) => {
                    const next = new Set(prev);
                    if (next.has(name)) next.delete(name);
                    else next.add(name);
                    return next;
                  });
                }}
              >
                <span className="cfg-head__name">{name}</span>
                <span className="cfg-head__count">{rows.length}</span>
                <IconChevron
                  size={13}
                  style={{ transform: expanded ? 'rotate(90deg)' : undefined, flexShrink: 0 }}
                />
              </button>
              {expanded && (
                <div className="cfg-rows">
                  {rows.map((r) => (
                    <div className="cfg-row" key={r.path}>
                      <span className="cfg-row__path">{r.path}</span>
                      <span className={`cfg-row__val${r.secret ? ' cfg-row__val--secret' : ''}`}>
                        {displayValue(r)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}

      <p style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', margin: '14px 2px 0', lineHeight: 1.5 }}>
        Read-only by default. A bad value here can stop Hermes starting, and there is no undo on a
        phone — edit <code>~/.hermes/config.yaml</code> where you can see it fail.
      </p>

      <details style={{ marginTop: 12 }} open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-dim)', cursor: 'pointer', minHeight: 'var(--tap-min)', display: 'flex', alignItems: 'center' }}>
          Advanced — change one setting
        </summary>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            className="field"
            placeholder="Dotted path (e.g. logging.level)"
            value={editPath}
            onChange={(e) => setEditPath(e.target.value)}
            aria-label="Setting path"
            style={{ fontFamily: 'var(--mono)' }}
          />
          <input
            className="field"
            placeholder='New value as JSON (e.g. "debug", 3, true)'
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            aria-label="Setting value as JSON"
            style={{ fontFamily: 'var(--mono)' }}
          />
          <input
            className="field"
            placeholder="Type the top-level section name to confirm"
            value={editConfirm}
            onChange={(e) => setEditConfirm(e.target.value)}
            aria-label="Confirmation"
          />
          <button
            className="btn btn--sm"
            disabled={
              update.isPending ||
              !editPath.trim() ||
              !editValue.trim() ||
              editConfirm.trim() !== editPath.trim().split('.')[0]
            }
            onClick={() => {
              const path = editPath.trim();
              let value: unknown;
              try {
                value = JSON.parse(editValue);
              } catch {
                toast('Value must be valid JSON — wrap text in quotes.', 'error');
                return;
              }
              buzz('tap');
              void update
                .mutateAsync({ path, value })
                .then(() => {
                  toast(`${path} updated`, 'success');
                  setEditPath('');
                  setEditValue('');
                  setEditConfirm('');
                })
                .catch((e) => toast(e instanceof Error ? e.message : 'Update failed', 'error'));
            }}
          >
            {update.isPending ? 'Writing…' : 'Write setting'}
          </button>
          <div style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', lineHeight: 1.5 }}>
            Sends only that leaf via <code>PUT /api/config</code> (merged, not
            replaced). Credentials stay masked here and cannot be revealed.
          </div>
        </div>
      </details>
    </div>
  );
}
