/**
 * Session history: date-grouped list, full-text search, swipe to
 * resume/delete, long-press to bulk-select.
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { SessionRowItem } from '../components/sessions/SessionRow';
import { useDebounced } from '../lib/useDebounced';
import { SessionActionsSheet } from '../components/sessions/SessionActionsSheet';
import { PullToRefresh } from '../components/shared/PullToRefresh';
import { Empty, ErrorNote, SkeletonList, dayGroup } from '../components/shared/misc';
import { IconSearch, IconClose, IconTrash, IconPlus } from '../components/shared/Icons';
import {
  isOn,
  sessionKeys,
  useBulkDeleteSessions,
  useDeleteSession,
  useSessionSearch,
  useSessions,
  type ArchivedFilter,
  type SessionList,
  type SessionRow,
} from '../api/sessions';
import { useActiveProfile, useProfiles } from '../api/profiles';
import { MenuButton } from '../components/shared/MenuButton';
import { BackButton } from '../components/shared/BackButton';
import { useUi } from '../store/ui';
import { useSession } from '../store/session';
import { collectTags, hasTag, tagHue } from '../lib/sessionTags';
import {
  FILTER_LABEL,
  SESSION_FILTERS,
  countByKind,
  matchesFilter,
  type SessionFilter,
} from '../lib/sessionKinds';
import { buzz } from '../lib/haptics';
import { UNDO_WINDOW_MS, scheduleUndoable } from '../lib/undo';

/**
 * How long the search box waits for typing to stop. Long enough to collapse a
 * word into one request, short enough that results feel immediate.
 */
const SEARCH_DEBOUNCE_MS = 250;

export function SessionsScreen() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  /**
   * Persisted, not local state: the list mixes your conversations with cron
   * runs and kanban workers, and having to re-pick the lane on every visit is
   * the thing that makes the mixing tiresome in the first place.
   */
  const filter = useUi((s) => s.sessionFilter);
  const setFilter = useUi((s) => s.setSessionFilter);

  // `/resume <text>` lands here with the typed argument as a search seed.
  const [params] = useSearchParams();
  const seededQuery = params.get('q') ?? '';

  const [query, setQuery] = useState(seededQuery);
  const [searching, setSearching] = useState(Boolean(seededQuery));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  /**
   * Which profile's sessions to list.
   *
   * Sessions live in per-profile stores and every endpoint addresses one at a
   * time; omitting the profile silently means "the active one". That was
   * invisible until a second profile existed, at which point a kanban task
   * running as `research` produced a live session this screen could not show
   * and gave no hint of. Null means the active profile — the same request this
   * screen has always made.
   *
   * There is no merged view: the backend rejects `profile=all`, and stitching
   * N paginated stores whose offsets do not align would break the counts, the
   * grouping and the infinite scroll all at once.
   */
  const [profile, setProfile] = useState<string | null>(null);

  const archivedFilter: ArchivedFilter = showArchived ? 'only' : 'exclude';
  const { data, isLoading, error, refetch } = useSessions(undefined, archivedFilter, profile);
  // Search on the settled value: every keystroke was otherwise a new query
  // key, and so a new request to the backend.
  const debouncedQuery = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const search = useSessionSearch(debouncedQuery, profile);
  const profiles = useProfiles().data?.profiles ?? [];
  const activeProfile = useActiveProfile().data?.active ?? '';
  const del = useDeleteSession();
  const bulkDel = useBulkDeleteSessions();

  const selecting = selected.size > 0;

  /** Every tag in view, so the filter rail only offers tags that exist. */
  const tags = useMemo(
    () => collectTags((data?.sessions ?? []).map((s) => s.title)),
    [data],
  );

  /**
   * Counted across the loaded page rather than the filtered view, so the chips
   * keep saying how much is in each lane while you are standing in one of
   * them. "Loaded page" is the honest scope: `useSessions` fetches a capped
   * list, so these count what the list could show, not all history — which is
   * the number that matches what filtering actually does here.
   */
  const kindCounts = useMemo(() => countByKind(data?.sessions ?? []), [data]);

  /**
   * Which chips to render.
   *
   * `all` and `mine` always, because those are the two you switch between; the
   * automated lanes only once something has actually run, so a machine with no
   * kanban tasks never carries a permanent "Kanban 0". A lane you are
   * currently filtered into stays visible even at zero — otherwise the chip
   * that would clear the filter disappears along with the rows.
   */
  const visibleFilters = useMemo(
    () =>
      SESSION_FILTERS.filter(
        (f) => f === 'all' || f === 'mine' || f === filter || kindCounts[f] > 0,
      ),
    [kindCounts, filter],
  );

  /**
   * Pinned sessions lead, then the rest grouped by day.
   *
   * The sort happens here rather than in the query because the backend orders
   * by creation or recency only (`order` takes `created` | `recent`) and has no
   * pinned-first mode — and pinning is only meaningful if it floats the row out
   * of its date group. Tag filtering is client-side for the same reason: tags
   * live inside the title string, so the API can't filter on them.
   */
  const groups = useMemo(() => {
    const all = data?.sessions ?? [];
    const byKind = all.filter((s) => matchesFilter(s, filter));
    const rows = tag ? byKind.filter((s) => hasTag(s.title, tag)) : byKind;
    const out: { label: string; items: SessionRow[] }[] = [];
    const pinned = rows.filter((s) => isOn(s.pinned));
    if (pinned.length) out.push({ label: 'Pinned', items: pinned });
    for (const s of rows) {
      if (isOn(s.pinned)) continue;
      const label = dayGroup(s.started_at);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(s);
      else out.push({ label, items: [s] });
    }
    return out;
  }, [data, tag, filter]);

  /** How many rows the current filter and tag actually leave on screen. */
  const visibleCount = useMemo(
    () => groups.reduce((n, g) => n + g.items.length, 0),
    [groups],
  );

  const actionsSession = useMemo(
    () => data?.sessions.find((s) => s.id === actionsFor) ?? null,
    [data, actionsFor],
  );

  /**
   * The model to treat as unremarkable: whatever is configured right now.
   * Nearly every row ran on it, so printing it on each one repeated a single
   * identical string down the whole list. A row shows its model only when it
   * differs — which is the case actually worth noticing.
   */
  const commonModel = useSession((s) => s.info?.model) ?? null;

  /**
   * Stable so `SessionRowItem`'s memo holds: the list can be 100 rows, and a
   * background refetch or a selection change would otherwise re-render every
   * one of them. `mutateAsync` keeps its identity across renders; the mutation
   * object it comes from does not.
   */
  const deleteSession = del.mutateAsync;

  const resume = useCallback(
    (id: string) => {
      buzz('tap');
      /* The profile rides along. `session.resume` takes one — it is how the
         gateway opens a session out of another profile's state.db — and
         without it the resume looks up the id in the active profile's store
         and finds nothing. */
      navigate(
        `/chat?resume=${encodeURIComponent(id)}${profile ? `&profile=${encodeURIComponent(profile)}` : ''}`,
      );
    },
    [navigate, profile],
  );

  /**
   * Delete a session, with a window to take it back.
   *
   * This is reached by swiping a row left — a gesture that costs one careless
   * thumb movement while scrolling a hundred-row list, and which used to
   * destroy the conversation outright with no confirmation and nothing to undo.
   * Every other destructive action in the app (Files, Profiles) asks first.
   *
   * Asking here would be the wrong fix: a confirmation dialog in front of a
   * swipe removes the only reason to swipe. So the row goes immediately and the
   * *request* is what waits — see `lib/undo.ts`. Undo puts the row back without
   * anything ever having reached the backend, which is the only kind of undo
   * available for a delete the API cannot reverse.
   */
  const removeOne = useCallback(
    (id: string) => {
      // Hide it everywhere it is listed, and keep the copies so Undo can put
      // them back exactly as they were rather than waiting on a refetch.
      const snapshot = qc.getQueriesData<SessionList>({ queryKey: sessionKeys.all });
      qc.setQueriesData<SessionList>({ queryKey: sessionKeys.all }, (old) =>
        old?.sessions
          ? { ...old, sessions: old.sessions.filter((sn) => sn.id !== id) }
          : old,
      );

      const { undo } = scheduleUndoable(
        {
          commit: () => {
            void deleteSession({ id, profile }).catch((e: unknown) => {
              // Nothing is watching by now, so the row has to come back and
              // say why on its own.
              for (const [key, data] of snapshot) qc.setQueryData(key, data);
              toast(e instanceof Error ? e.message : 'Delete failed', 'error');
            });
          },
          revert: () => {
            for (const [key, data] of snapshot) qc.setQueryData(key, data);
          },
        },
        UNDO_WINDOW_MS,
      );

      toast('Session deleted', 'success', {
        durationMs: UNDO_WINDOW_MS,
        action: {
          label: 'Undo',
          onAction: () => {
            buzz('tap');
            undo();
          },
        },
      });
    },
    [deleteSession, toast, qc, profile],
  );

  const removeSelected = async () => {
    const ids = [...selected];
    setSelected(new Set());
    try {
      await bulkDel.mutateAsync({ ids, profile });
      toast(`Deleted ${ids.length} sessions`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Bulk delete failed', 'error');
    }
  };

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const pickTag = useCallback((t: string) => setTag((cur) => (cur === t ? null : t)), []);

  const showingSearch = searching && debouncedQuery.trim().length >= 2;

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
            <MenuButton />
            {/* Only in the resting header: in search or selection mode the
                leading control is already a Close/Cancel, and two ways out
                sitting side by side is how you get people pressing the wrong
                one. */}
            <BackButton />
            <div className="header__title">
              {showArchived ? 'Archived' : 'Sessions'}
              {/* The filtered count, not the server's total: with a lane
                  selected the total describes a list you are not looking at. */}
              {data && (
                <span className="header__sub">
                  {' · '}
                  {filter === 'all' && !tag ? data.total : visibleCount}
                </span>
              )}
            </div>
            <button
              className={`chip${showArchived ? ' chip--active' : ''}`}
              onClick={() => {
                buzz('tap');
                setShowArchived((v) => !v);
              }}
              aria-pressed={showArchived}
            >
              {showArchived ? 'Active' : 'Archived'}
            </button>
            <button className="icon-btn" onClick={() => setSearching(true)} aria-label="Search">
              <IconSearch size={20} />
            </button>
          </>
        )}
      </div>

      {/* Coarser than any of the filters below it: those narrow a list, this
          chooses which store is read at all. Only rendered once a second
          profile exists — before that there is one answer and a picker
          offering it is furniture. */}
      {!searching && !selecting && profiles.length > 1 && (
        <div className="tag-rail">
          {profiles.map((pr) => {
            const on = (profile ?? activeProfile) === pr.name;
            return (
              <button
                key={pr.name}
                className={`chip${on ? ' chip--active' : ''}`}
                onClick={() => {
                  buzz('tap');
                  /* The active profile is stored as null, not as its name: it
                     is the request this screen has always made, and pinning
                     the name would break the moment you switched profiles
                     elsewhere in the app. */
                  setProfile(pr.name === activeProfile ? null : pr.name);
                  setSelected(new Set());
                }}
              >
                {pr.name}
                {pr.name === activeProfile && (
                  <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}> · active</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* The lane picker. Above the tag rail because it is the coarser cut:
          which kind of session, then which tag within it. */}
      {!searching && !selecting && (
        <div className="tag-rail">
          {visibleFilters.map((f) => {
            const on = filter === f;
            const count = f === 'all' ? undefined : kindCounts[f];
            return (
              <button
                key={f}
                className={`chip${on ? ' chip--active' : ''}`}
                onClick={() => {
                  buzz('tap');
                  setFilter(f as SessionFilter);
                }}
                aria-pressed={on}
              >
                {FILTER_LABEL[f]}
                {count !== undefined && <span className="chip__count">{count}</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Only worth showing once tags actually exist; an empty rail on a phone
          is pure lost height. */}
      {!searching && !selecting && tags.length > 0 && (
        <div className="tag-rail">
          {tags.map((t) => {
            const on = tag?.toLowerCase() === t.toLowerCase();
            return (
              <button
                key={t}
                className={`tag-chip${on ? ' tag-chip--active' : ''}`}
                style={{ '--tag-hue': tagHue(t) } as React.CSSProperties}
                onClick={() => {
                  buzz('tap');
                  setTag(on ? null : t);
                }}
                aria-pressed={on}
              >
                #{t}
              </button>
            );
          })}
        </div>
      )}

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
          <div className="has-fab" style={{ padding: '8px 12px 16px' }}>
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
              /* A filtered-out list is not an empty one, and saying "No
                 sessions yet" to someone with a hundred of them reads as data
                 loss. Offer the way back out. */
              filter !== 'all' && (data?.sessions.length ?? 0) > 0 ? (
                <Empty
                  icon="🫙"
                  title={`Nothing in ${FILTER_LABEL[filter]}`}
                  hint="Other sessions are hidden by this filter."
                  action={
                    <button
                      className="btn btn--primary"
                      onClick={() => {
                        buzz('tap');
                        setFilter('all');
                      }}
                    >
                      Show all
                    </button>
                  }
                />
              ) : showArchived ? (
                <Empty
                  icon="🗄"
                  title="Nothing archived"
                  hint="Archive a session from its ⋯ menu to tuck it away without deleting it."
                />
              ) : (
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
              )
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
                        commonModel={commonModel}
                        onResume={resume}
                        onDelete={removeOne}
                        onToggleSelect={toggle}
                        onLongPress={toggle}
                        onActions={setActionsFor}
                        onPickTag={pickTag}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </PullToRefresh>
      )}

      {!searching && selected.size === 0 && (
        <button className="fab" onClick={() => navigate('/chat?new=1')} aria-label="New chat">
          <IconPlus size={22} />
        </button>
      )}

      <SessionActionsSheet session={actionsSession} onClose={() => setActionsFor(null)} />
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
