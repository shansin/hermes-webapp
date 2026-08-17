/**
 * Session history: date-grouped list, full-text search, swipe to
 * resume/delete, long-press to bulk-select.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { SessionRowItem } from '../components/sessions/SessionRow';
import { PullToRefresh } from '../components/shared/PullToRefresh';
import { Empty, ErrorNote, SkeletonList, dayGroup } from '../components/shared/misc';
import { IconSearch, IconClose, IconTrash, IconPlus } from '../components/shared/Icons';
import {
  sessionKeys,
  useBulkDeleteSessions,
  useDeleteSession,
  useSessionSearch,
  useSessions,
  type SessionRow,
} from '../api/sessions';
import { useUi } from '../store/ui';
import { buzz } from '../lib/haptics';

export function SessionsScreen() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data, isLoading, error, refetch } = useSessions();
  const search = useSessionSearch(query);
  const del = useDeleteSession();
  const bulkDel = useBulkDeleteSessions();

  const selecting = selected.size > 0;

  // Group by day, preserving the server's newest-first ordering.
  const groups = useMemo(() => {
    const rows = data?.sessions ?? [];
    const out: { label: string; items: SessionRow[] }[] = [];
    for (const s of rows) {
      const label = dayGroup(s.started_at);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(s);
      else out.push({ label, items: [s] });
    }
    return out;
  }, [data]);

  const resume = (id: string) => {
    buzz('tap');
    navigate(`/chat?resume=${encodeURIComponent(id)}`);
  };

  const removeOne = async (id: string) => {
    try {
      await del.mutateAsync(id);
      toast('Session deleted', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error');
    }
  };

  const removeSelected = async () => {
    const ids = [...selected];
    setSelected(new Set());
    try {
      await bulkDel.mutateAsync(ids);
      toast(`Deleted ${ids.length} sessions`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Bulk delete failed', 'error');
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const showingSearch = searching && query.trim().length >= 2;

  return (
    <div className="screen">
      <div className="header">
        {searching ? (
          <>
            <IconSearch size={18} style={{ color: 'var(--text-faint)' }} />
            <input
              autoFocus
              className="field"
              style={{ minHeight: 38, flex: 1 }}
              placeholder="Search conversations…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              className="icon-btn"
              onClick={() => {
                setSearching(false);
                setQuery('');
              }}
              aria-label="Close search"
            >
              <IconClose size={19} />
            </button>
          </>
        ) : selecting ? (
          <>
            <button className="icon-btn" onClick={() => setSelected(new Set())} aria-label="Cancel">
              <IconClose size={19} />
            </button>
            <div className="header__title">{selected.size} selected</div>
            <button className="icon-btn icon-btn--danger" onClick={removeSelected} aria-label="Delete selected">
              <IconTrash size={19} />
            </button>
          </>
        ) : (
          <>
            <div className="header__title">
              Sessions
              {data && <span className="header__sub"> · {data.total}</span>}
            </div>
            <button className="icon-btn" onClick={() => setSearching(true)} aria-label="Search">
              <IconSearch size={20} />
            </button>
            <button className="icon-btn" onClick={() => navigate('/chat?new=1')} aria-label="New chat">
              <IconPlus size={21} />
            </button>
          </>
        )}
      </div>

      {isLoading && !data ? (
        <SkeletonList n={7} h={54} />
      ) : error ? (
        <ErrorNote error={error} />
      ) : (
        <PullToRefresh
          onRefresh={async () => {
            await qc.invalidateQueries({ queryKey: sessionKeys.all });
            await refetch();
          }}
        >
          <div style={{ padding: '8px 12px 16px' }}>
            {showingSearch ? (
              <>
                {search.isLoading && <div style={{ color: 'var(--text-faint)', padding: 12 }}>Searching…</div>}
                {search.data?.results.length === 0 && (
                  <Empty icon="🔍" title="No matches" hint={`Nothing found for "${query}".`} />
                )}
                {search.data?.results.map((hit, i) => (
                  <button
                    key={`${hit.session_id}-${i}`}
                    onClick={() => resume(hit.session_id)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      background: 'var(--bg-elev)',
                      border: '1px solid var(--border-soft)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '11px 13px',
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ fontWeight: 550, fontSize: 14.5, marginBottom: 3 }}>
                      {hit.title || 'Untitled'}
                    </div>
                    <div
                      style={{ fontSize: 12.5, color: 'var(--text-dim)' }}
                      // The API marks matches with >>>…<<<; render them as bold.
                      dangerouslySetInnerHTML={{
                        __html: escapeAndMark(hit.snippet),
                      }}
                    />
                  </button>
                ))}
              </>
            ) : groups.length === 0 ? (
              <Empty
                icon="✦"
                title="No sessions yet"
                hint="Start a conversation and it will show up here."
                action={
                  <button className="btn btn--primary" onClick={() => navigate('/chat?new=1')}>
                    New chat
                  </button>
                }
              />
            ) : (
              groups.map((g) => (
                <div key={g.label} style={{ marginBottom: 14 }}>
                  <div
                    style={{
                      fontSize: 11.5,
                      fontWeight: 650,
                      color: 'var(--text-faint)',
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      padding: '6px 3px',
                    }}
                  >
                    {g.label}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {g.items.map((s) => (
                      <SessionRowItem
                        key={s.id}
                        session={s}
                        selected={selected.has(s.id)}
                        selecting={selecting}
                        onResume={() => resume(s.id)}
                        onDelete={() => void removeOne(s.id)}
                        onToggleSelect={() => toggle(s.id)}
                        onLongPress={() => toggle(s.id)}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </PullToRefresh>
      )}
    </div>
  );
}

/**
 * Search snippets arrive with `>>>match<<<` markers. Escape the text first,
 * then convert the markers — never the other way round.
 */
function escapeAndMark(snippet: string): string {
  const escaped = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .replace(/&gt;&gt;&gt;/g, '<strong style="color:var(--accent)">')
    .replace(/&lt;&lt;&lt;/g, '</strong>');
}
