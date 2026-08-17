/**
 * Memory: the agent's persistent instruction files, editable in place.
 *
 * These live at fixed paths under ~/.hermes. Editing them is the single most
 * useful "control center" action, so each is a collapsible card with an
 * inline editor rather than a nested screen.
 */
import { useEffect, useState } from 'react';
import { IconChevron } from '../shared/Icons';
import { useMemoryProviders, useTextFile, useWriteTextFile } from '../../api/hub';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

const HOME = '~/.hermes';

// Paths as Hermes lays them out: the two curated memory files live under
// `memories/`, while SOUL.md (the system persona) sits at the home root.
const FILES = [
  { path: `${HOME}/memories/MEMORY.md`, label: 'MEMORY.md', hint: 'Long-term facts the agent recalls' },
  { path: `${HOME}/memories/USER.md`, label: 'USER.md', hint: 'Who you are, preferences, context' },
  { path: `${HOME}/SOUL.md`, label: 'SOUL.md', hint: 'Persona and voice' },
];

function FileCard({ path, label, hint }: { path: string; label: string; hint: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  const { data, isLoading, error } = useTextFile(open ? path : null);
  const write = useWriteTextFile();
  const toast = useUi((s) => s.toast);

  const server = data?.content ?? data?.text ?? '';

  // Adopt the server copy once, then let the user's edits win.
  useEffect(() => {
    if (open && draft === null && data) setDraft(server);
  }, [open, data, draft, server]);

  const dirty = draft !== null && draft !== server;

  const save = async () => {
    if (draft === null) return;
    try {
      await write.mutateAsync({ path, content: draft });
      buzz('done');
      toast(`${label} saved`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error');
    }
  };

  return (
    <div className="card" style={{ marginBottom: 10, padding: 0, overflow: 'hidden' }}>
      <button
        onClick={() => {
          buzz('tap');
          setOpen((v) => !v);
        }}
        style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: 13, textAlign: 'left' }}
      >
        <span className={`think__caret${open ? ' think__caret--open' : ''}`}>
          <IconChevron size={15} />
        </span>
        <span style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14.5, fontFamily: 'var(--mono)' }}>{label}</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{hint}</div>
        </span>
        {dirty && <span style={{ color: 'var(--accent)', fontSize: 11.5, fontWeight: 600 }}>edited</span>}
      </button>

      {open && (
        <div style={{ padding: '0 13px 13px' }}>
          {isLoading && <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>Loading…</div>}
          {error && (
            <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>
              This file doesn't exist yet — saving will create it.
            </div>
          )}
          <textarea
            className="field"
            value={draft ?? ''}
            onChange={(e) => setDraft(e.target.value)}
            rows={12}
            style={{ fontFamily: 'var(--mono)', fontSize: 13, resize: 'vertical', lineHeight: 1.5 }}
            placeholder="# Empty"
          />
          <button
            className="btn btn--primary btn--sm"
            style={{ width: '100%', marginTop: 9 }}
            onClick={save}
            disabled={!dirty || write.isPending}
          >
            {write.isPending ? 'Saving…' : dirty ? 'Save' : 'No changes'}
          </button>
        </div>
      )}
    </div>
  );
}

export function MemoryTab() {
  const { data } = useMemoryProviders();

  return (
    <div style={{ padding: 12 }}>
      {FILES.map((f) => (
        <FileCard key={f.path} {...f} />
      ))}

      {data && (
        <div className="card" style={{ marginTop: 4 }}>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', fontWeight: 650, marginBottom: 8 }}>
            MEMORY BACKEND
          </div>
          <div style={{ fontSize: 14, marginBottom: 8 }}>
            {data.active || 'Built-in (files only)'}
          </div>
          {data.providers
            .filter((p) => p.status === 'available' || p.name === data.active)
            .map((p) => (
              <div key={p.name} style={{ fontSize: 12.5, color: 'var(--text-dim)', padding: '3px 0' }}>
                {p.name} — {p.status}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
