/**
 * Kanban board.
 *
 * Phone layout: one column at a time, selected by a scrollable chip strip,
 * rather than the desktop's side-by-side swimlanes — horizontal panning
 * through eight columns on a 390px screen is miserable. Cards swipe right to
 * advance a stage and left to delete.
 *
 * Wide layout: the swimlanes, because that is what the width is for. A board
 * is a comparison — what is stuck in review while three things run — and the
 * column-at-a-time view can only ever answer one column's worth of that. The
 * chip strip goes with it: it is a column *selector*, and there is nothing to
 * select when every column is already on screen.
 *
 * The two modes share the cards, the handlers and the filter. What differs is
 * only how many columns are rendered at once, so a change to a card's
 * behaviour cannot land in one layout and miss the other.
 *
 * **Which board.** Every kanban route takes `?board=`, and omitting it does not
 * mean "the only board" — it means whatever the *server's* pointer currently
 * says, which `POST /boards/<slug>/switch` moves and any other client can move.
 * So the screen owns a selection and threads it into every hook and sheet;
 * `null` is the deliberate "follow the server" choice, and it is what a
 * single-board install stays on for ever. The picker only appears once a second
 * board exists, like every other filter here.
 *
 * The three things that are not filters — health, settings, bulk select — are
 * behind one overflow rather than sitting in the bar. The header already
 * carries a menu, a back arrow, a title and a search; a row of six icons on a
 * 390px screen is the point where it stops being scannable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PullToRefresh } from '../components/shared/PullToRefresh';
import { Empty, ErrorNote, SkeletonList } from '../components/shared/misc';
import { IconClose, IconPlus, IconSearch, IconSettings } from '../components/shared/Icons';
import { TaskCard } from '../components/kanban/TaskCard';
import { TaskSheet } from '../components/kanban/TaskSheet';
import { NewTaskSheet } from '../components/kanban/NewTaskSheet';
import { BoardHealthSheet } from '../components/kanban/BoardHealthSheet';
import { BoardSettingsSheet } from '../components/kanban/BoardSettingsSheet';
import {
  ARCHIVED,
  COLUMNS,
  COLUMN_LABEL,
  useBoard,
  useBulkTasks,
  useDeleteTask,
  useUpdateTask,
  type Column,
  type Task,
} from '../api/kanban';
import { useBoards, useKanbanConfig } from '../api/kanbanAdmin';
import { useUi } from '../store/ui';
import { buzz } from '../lib/haptics';
import { UNDO_WINDOW_MS, scheduleUndoable } from '../lib/undo';
import { SelectChip, SelectSheet } from '../components/shared/SelectSheet';
import { Sheet } from '../components/shared/Sheet';
import { MenuButton } from '../components/shared/MenuButton';
import { BackButton } from '../components/shared/BackButton';
import { useWideLayout } from '../lib/useMediaQuery';
import { useDebounced } from '../lib/useDebounced';
import { useKanbanEvents } from '../lib/useKanbanEvents';

/**
 * Where "advance this card" sends it, per column.
 *
 * `blocked` and `scheduled` both send to **`ready`**, and that is not a
 * cosmetic choice of destination. Only `ready` routes through Hermes'
 * `unblock_task`, which closes a dangling run pointer, clears the failure
 * counter and re-gates on the parents before deciding where the card actually
 * lands. `blocked` used to advance to `todo`, which is a direct status write:
 * the card left the column looking unblocked while the run pointer it was
 * holding stayed dangling. Where the card ends up is Hermes' answer, not this
 * table's — which is why `advanceById` reports the status that comes back.
 */
const NEXT_STAGE: Partial<Record<Column, Column>> = {
  triage: 'todo',
  todo: 'ready',
  scheduled: 'ready',
  ready: 'running',
  running: 'review',
  blocked: 'ready',
  review: 'done',
};

/** The option that means "no assignee filter". Leading space: never a real name. */
const ALL = ' all';
/** Likewise for the board picker: whichever board the server itself points at. */
const SERVER_BOARD = ' server';

export function KanbanScreen() {
  const wide = useWideLayout();
  // Null until the board arrives, so the first render can land on a column
  // that actually has cards rather than showing an empty "To do" over a
  // populated board.
  const [active, setActive] = useState<Column | null>(null);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /**
   * Which agent's cards to show.
   *
   * Not cosmetic once a second profile exists: the dispatcher claims per
   * assignee, so "what is the research profile actually working on" was a
   * question the board could not answer — the answer sat in an `@name` line
   * at the foot of every card, to be assembled by eye.
   */
  const [assignee, setAssignee] = useState<string>(ALL);
  const [pickingAssignee, setPickingAssignee] = useState(false);
  const [board, setBoard] = useState<string | null>(null);
  const [pickingBoard, setPickingBoard] = useState(false);
  const [tenant, setTenant] = useState<string>(ALL);
  const [pickingTenant, setPickingTenant] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState<boolean | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [selecting, setSelecting] = useState(false);
  /**
   * Cards deleted a moment ago, still inside their Undo window.
   *
   * Held here rather than edited out of the cached board, because the board
   * refetches every 10s and the Undo toast stands for 8 — a card removed from
   * the cache would reappear under the toast offering to bring it back. A
   * filter applied on the way to the screen cannot be overwritten by a poll.
   */
  const [pendingDelete, setPendingDelete] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Which card has its actions showing, if any.
   *
   * Owned here rather than by the card so only one can be armed at a time and
   * everything that ought to cancel it can — paging, opening a sheet, entering
   * selection mode. A card that armed itself and had no way to be told to
   * stand down is the shape of the Files row that never disarms.
   */
  const [revealed, setRevealed] = useState<string | null>(null);

  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const config = useKanbanConfig();
  /**
   * Hermes' own preference, used only as the *seed*. Once someone has toggled
   * it here their choice wins for the rest of the session — a setting that
   * silently reverts on the next config refetch is worse than one that was
   * never read at all.
   */
  const archived = showArchived ?? config.data?.include_archived_by_default ?? false;

  /**
   * The plugin's event stream, and the poll behind it.
   *
   * `live` only *slows* the poll — see `useKanbanEvents` for why it can never
   * replace it.
   *
   * Held in state to break a circle: the board query needs to know whether the
   * socket is live, and the socket needs the board's `latest_event_id` to seed
   * its cursor. Hooks run in order, so one of them has to read the other a
   * render late, and this is the cheaper direction — a render on the poll
   * interval changing costs nothing, while a stale cursor would replay events.
   */
  const [live, setLive] = useState(false);
  const { data, isLoading, error, refetch } = useBoard({
    board,
    tenant: tenant === ALL ? null : tenant,
    includeArchived: archived,
    live,
  });
  const boards = useBoards(false);
  const update = useUpdateTask(board);
  const del = useDeleteTask(board);
  const bulk = useBulkTasks(board);

  const debouncedQuery = useDebounced(query, 200);

  // Not gated on `error`: a board that failed to load is exactly a board whose
  // next change is worth hearing about, and the socket recovers on its own.
  const socketLive = useKanbanEvents(board, data?.latest_event_id, true);
  useEffect(() => setLive(socketLive), [socketLive]);

  /**
   * `/kanban?task=<id>` opens that card.
   *
   * The Activity pane has been minting this link for every kanban row it draws
   * and the board never read it, so tapping "running: place holds on both
   * books" landed you on a board of eight columns with nothing selected and no
   * hint which card had been meant. The updates feed now mints it too, for
   * every blocked card it reports, which is the tap that most has to land
   * somewhere useful. Claimed once and stripped, like the share intake: leaving
   * it in the URL means closing the sheet and reloading reopens a card you
   * dismissed.
   *
   * `replace`, because the entry is the one the tap already landed on —
   * pushing here would put an identical URL on the stack and cost a back press
   * to escape (see the navigation rule in CLAUDE.md).
   */
  const [params, setParams] = useSearchParams();
  const deepLinked = params.get('task');
  useEffect(() => {
    if (!deepLinked) return;
    setOpenTask(deepLinked);
    const next = new URLSearchParams(params);
    next.delete('task');
    setParams(next, { replace: true });
  }, [deepLinked, params, setParams]);

  /**
   * The filters applied once, to the whole board.
   *
   * Counts have to come from the *filtered* lists or the chip strip
   * contradicts what is under it: a "3" over an empty column reads as a broken
   * board, not as a filter doing its job.
   *
   * Search is client-side because the plugin has no search route — and it does
   * not need one: the board endpoint returns every card in one response, so
   * the whole corpus is already here. It matches title, body, summary and id,
   * because the id is what a notification and a log line give you and pasting
   * one in should find the card.
   */
  const columns = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    const byName = new Map<string, Task[]>();
    for (const c of data?.columns ?? []) {
      byName.set(
        c.name,
        c.tasks.filter(
          (t) =>
            !pendingDelete.has(t.id) &&
            (assignee === ALL || t.assignee === assignee) &&
            (!q ||
              t.title.toLowerCase().includes(q) ||
              t.id.toLowerCase().includes(q) ||
              (t.body ?? '').toLowerCase().includes(q) ||
              (t.latest_summary ?? '').toLowerCase().includes(q)),
        ),
      );
    }
    return byName;
  }, [data, assignee, pendingDelete, debouncedQuery]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const [name, tasks] of columns) m.set(name, tasks.length);
    return m;
  }, [columns]);

  /**
   * Which columns to render. Archived only when asked for, and only when the
   * board actually returned it — an empty ninth lane on a board that has never
   * archived anything is furniture.
   */
  const shownColumns = useMemo<string[]>(
    () => (archived && columns.has(ARCHIVED) ? [...COLUMNS, ARCHIVED] : [...COLUMNS]),
    [archived, columns],
  );

  // Resolve the shown column: an explicit pick wins, otherwise the first
  // column carrying cards, otherwise the board's default landing column.
  const shown: string =
    (active && shownColumns.includes(active) ? active : null) ??
    shownColumns.find((c) => (counts.get(c) ?? 0) > 0) ??
    'todo';

  /**
   * The card handlers are stable so `TaskCard`'s memo actually holds. The
   * board refetches every 10s; React Query's structural sharing keeps each
   * unchanged task object identical, so with stable callbacks an unchanged
   * card skips re-rendering entirely.
   *
   * `mutateAsync` keeps its identity across renders — depending on the
   * mutation object itself would not.
   */
  const updateTask = update.mutateAsync;
  const deleteTask = del.mutateAsync;

  /**
   * The destination is a parameter rather than something read from `shown`.
   *
   * It used to be the latter, which was correct exactly as long as one column
   * was on screen at a time. In the swimlane layout the card being advanced is
   * usually not in the selected column, and a handler consulting `shown` would
   * file it under whatever the chip strip last pointed at. Taking it from the
   * lane that rendered the card is both correct and stable — the value is a
   * constant per lane, so the memo still holds.
   */
  const advanceById = useCallback(
    async (id: string, to: Column) => {
      buzz('done');
      try {
        const res = await updateTask({ id, status: to });
        /* The status that came back, not the one asked for: an unblock restores
           the phase the card was blocked from, and a card with an unfinished
           parent lands in To do however hard you ask for Ready. Naming the
           column the card is not in costs someone a hunt for it. */
        const landed = (res.task.status as Column) ?? to;
        toast(`Moved to ${COLUMN_LABEL[landed] ?? res.task.status}`, 'success');
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Could not move the card', 'error');
      }
    },
    [updateTask, toast],
  );

  /**
   * Delete a card, with a window to take it back.
   *
   * The same bargain Sessions and Cron already make (see `lib/undo.ts`): the
   * card goes now, the request waits out the toast. Deleting a task is a
   * single tap on a card whose whole point is being dragged around under a
   * thumb, and Hermes has no restore — so the only honest Undo is one that
   * gets in before the request is sent.
   */
  const removeById = useCallback(
    (id: string) => {
      buzz('warn');
      setPendingDelete((prev) => new Set(prev).add(id));

      const unhide = () =>
        setPendingDelete((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });

      const { undo } = scheduleUndoable(
        {
          commit: () => {
            void deleteTask(id)
              // The row is gone for real now; drop it from the filter so the
              // set does not grow for the life of the screen.
              .then(unhide)
              .catch((e: unknown) => {
                unhide();
                toast(e instanceof Error ? e.message : 'Delete failed', 'error');
              });
          },
          revert: unhide,
        },
        UNDO_WINDOW_MS,
      );

      toast('Task deleted', 'success', {
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
    [deleteTask, toast],
  );

  const openTaskById = useCallback((id: string) => {
    setRevealed(null);
    setOpenTask(id);
  }, []);

  /**
   * Disarm the revealed card on anything that is not it.
   *
   * Without this the two buttons stay on the card until something else happens
   * to clear them, which is exactly the bug the Files row had: an armed
   * destructive action left showing after you have plainly moved on. Scroll
   * and blur count as moving on; so does a tap anywhere else.
   *
   * The card itself is excluded, and that exclusion is load-bearing: this runs
   * in the capture phase, so disarming on a press *inside* the card would hide
   * the button before the click it began could reach it — the action would
   * simply never fire.
   */
  useEffect(() => {
    if (!revealed) return;
    const disarm = (e: Event) => {
      const target = e.target;
      if (target instanceof Element && target.closest('.tcard--revealed')) return;
      setRevealed(null);
    };
    document.addEventListener('pointerdown', disarm, true);
    document.addEventListener('scroll', disarm, true);
    window.addEventListener('blur', disarm);
    return () => {
      document.removeEventListener('pointerdown', disarm, true);
      document.removeEventListener('scroll', disarm, true);
      window.removeEventListener('blur', disarm);
    };
  }, [revealed]);

  const toggleSelected = useCallback((id: string) => {
    buzz('tap');
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * Apply one change to every selected card.
   *
   * The per-id results are the point. Hermes applies each id independently and
   * refuses some — a claimed card cannot be reassigned without `reclaim_first`,
   * a transition may not be legal from where a particular card sits — so a
   * caller that trusted the HTTP status would report "12 moved" for a call
   * where nine moved and three did not, with no way to tell which.
   */
  const applyBulk = useCallback(
    async (patch: {
      status?: string;
      assignee?: string | null;
      archive?: boolean;
      reclaim_first?: boolean;
    }) => {
      const ids = [...selected];
      if (ids.length === 0) return;
      buzz('done');
      try {
        const res = await bulk.mutateAsync({ ...patch, ids });
        const failed = res.results.filter((r) => !r.ok);
        setSelected(new Set());
        setSelecting(false);
        if (failed.length === 0) {
          toast(`${ids.length} card${ids.length > 1 ? 's' : ''} updated`, 'success');
        } else {
          toast(
            `${ids.length - failed.length} of ${ids.length} updated — ${failed[0]!.error ?? 'the rest were refused'}`,
            'error',
          );
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Bulk change failed', 'error');
      }
    },
    [bulk, selected, toast],
  );

  // The kanban plugin may not be installed on every Hermes profile.
  const unavailable = error && (error as { status?: number }).status === 404;

  /**
   * Names to offer as filters: whoever the board reports, plus whoever is
   * actually on a card. The two disagree on a board still carrying tasks
   * assigned to a profile that has since been deleted, and dropping that name
   * would hide those cards behind a filter with no chip to release it.
   */
  const assignees = useMemo(() => {
    const names = new Set<string>(data?.assignees ?? []);
    for (const c of data?.columns ?? []) {
      for (const t of c.tasks) if (t.assignee) names.add(t.assignee);
    }
    return [...names].sort();
  }, [data]);

  /**
   * Paging between columns by swiping the list.
   *
   * Eight columns is a lot of chip-tapping, and a horizontal swipe on a board
   * means "next column" everywhere else. It used to mean "move this card",
   * which is why the card gave that gesture up for a long press — the two
   * cannot share an axis, and paging is the one used constantly.
   *
   * The drag follows the finger and snaps on release, because a swipe with no
   * feedback is indistinguishable from one the app ignored. At the ends there
   * is nowhere to go, so the drag is damped rather than blocked: a dead swipe
   * says "this is the last column", a blocked one says "the gesture is
   * broken".
   */
  const index = shownColumns.indexOf(shown);
  const [drag, setDrag] = useState(0);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const axis = useRef<'none' | 'x' | 'y'>('none');
  /**
   * Set by a committed drag, so the click it ends with does not open a card.
   *
   * Cleared at the *start* of every gesture rather than only by the click it
   * is meant to swallow, because a horizontal swipe does not always end in
   * one: `touchcancel` — the notification shade, the browser's own back-swipe,
   * any system gesture taking over mid-drag — runs `onPagerEnd` with no click
   * to follow. The flag then survived into the next touch and ate the first
   * genuine tap on a card, which reads as the board simply ignoring you. A
   * gesture's own `touchstart` always precedes it and always follows the
   * previous gesture's click, so it is the one place the reset is unambiguous.
   */
  const swiped = useRef(false);

  const pageTo = useCallback(
    (to: number) => {
      const next = shownColumns[to];
      if (!next) return;
      buzz('tap');
      setRevealed(null);
      setActive(next as Column);
    },
    [shownColumns],
  );

  const onPagerStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    swipeStart.current = { x: t.clientX, y: t.clientY };
    axis.current = 'none';
    swiped.current = false;
  }, []);

  const onPagerMove = useCallback(
    (e: React.TouchEvent) => {
      const t = e.touches[0];
      const from = swipeStart.current;
      if (!t || !from) return;
      const dx = t.clientX - from.x;
      const dy = t.clientY - from.y;

      if (axis.current === 'none') {
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
        axis.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      if (axis.current !== 'x') return;

      /* Stop the pull-to-refresh above from seeing the rest of this gesture.
         It only reacts to downward movement, so a horizontal swipe barely
         moves it — but a diagonal one would pull the spinner open under a
         page that is already sliding. */
      e.stopPropagation();
      swiped.current = true;

      // Damped at the ends: there is nothing to page to, and the resistance
      // is the message.
      const atStart = index <= 0 && dx > 0;
      const atEnd = index >= shownColumns.length - 1 && dx < 0;
      setDrag(atStart || atEnd ? dx * 0.18 : dx);
    },
    [index, shownColumns.length],
  );

  const onPagerEnd = useCallback(() => {
    const dx = drag;
    swipeStart.current = null;
    axis.current = 'none';
    setDrag(0);
    // A quarter of the viewport, floored, so a long list and a short one need
    // the same deliberate movement.
    const threshold = Math.min(90, Math.max(48, window.innerWidth * 0.22));
    if (dx <= -threshold) pageTo(index + 1);
    else if (dx >= threshold) pageTo(index - 1);
  }, [drag, index, pageTo]);

  const tenants = data?.tenants ?? [];
  const boardList = boards.data?.boards ?? [];
  const boardName = board ? (boardList.find((b) => b.slug === board)?.name ?? board) : null;
  const selectedCount = selected.size;

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
              placeholder="Search this board…"
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
            <button
              className="icon-btn"
              onClick={() => {
                setSelected(new Set());
                setSelecting(false);
              }}
              aria-label="Cancel selection"
            >
              <IconClose size={19} />
            </button>
            <div className="header__title">
              {selectedCount === 0 ? 'Tap cards to select' : `${selectedCount} selected`}
            </div>
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
              Kanban
              {boardName && <span className="header__sub"> · {boardName}</span>}
              {assignee !== ALL && <span className="header__sub"> · @{assignee}</span>}
            </div>
            <button className="icon-btn" onClick={() => setSearching(true)} aria-label="Search">
              <IconSearch size={20} />
            </button>
            <button className="icon-btn" onClick={() => setMenuOpen(true)} aria-label="Board menu">
              <IconSettings size={20} />
            </button>
          </>
        )}
      </div>

      {/* Which slice of the board, as dropdowns rather than a chip per value:
          each list grows with the install, and a rail of them wraps to three
          rows on a phone. Each renders only once there is more than one thing
          to tell apart — a filter offering a single choice is furniture. */}
      {!searching &&
        !selecting &&
        (boardList.length > 1 || assignees.length > 1 || tenants.length > 1) && (
          <div className="kanban__filter">
            {boardList.length > 1 && (
              <SelectChip
                label="Board"
                value={boardName ?? 'Server default'}
                active={board !== null}
                onOpen={() => setPickingBoard(true)}
              />
            )}
            {assignees.length > 1 && (
              <SelectChip
                label="Cards for"
                value={assignee === ALL ? 'Everyone' : `@${assignee}`}
                active={assignee !== ALL}
                onOpen={() => setPickingAssignee(true)}
              />
            )}
            {tenants.length > 1 && (
              <SelectChip
                label="Tenant"
                value={tenant === ALL ? 'All' : tenant}
                active={tenant !== ALL}
                onOpen={() => setPickingTenant(true)}
              />
            )}
          </div>
        )}

      {!wide && (
        <div
          className="btn-group"
          role="tablist"
          aria-label="Board columns"
          style={{ borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}
        >
          {shownColumns.map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={shown === c}
              className={`btn-group__item${shown === c ? ' btn-group__item--active' : ''}`}
              onClick={() => {
                buzz('tap');
                setRevealed(null);
                setActive(c as Column);
              }}
            >
              {COLUMN_LABEL[c as Column] ?? 'Archived'}
              {(counts.get(c) ?? 0) > 0 && <span className="btn-group__count">{counts.get(c)}</span>}
            </button>
          ))}
        </div>
      )}

      {unavailable ? (
        <Empty
          icon="📋"
          title="Kanban isn't available"
          hint="The Hermes kanban plugin isn't enabled on this backend."
        />
      ) : isLoading && !data ? (
        <SkeletonList n={4} h={78} />
      ) : error ? (
        <ErrorNote error={error} />
      ) : wide ? (
        /* No pull-to-refresh here: it is a touch gesture, and this layout only
           exists where there is a pointer. The 10s poll keeps it current. */
        <div className="kanban__board">
          {shownColumns.map((c) => (
            <Lane
              key={c}
              column={c}
              tasks={columns.get(c) ?? []}
              selecting={selecting}
              selected={selected}
              revealed={revealed}
              onReveal={setRevealed}
              onOpen={selecting ? toggleSelected : openTaskById}
              onAdvance={advanceById}
              onDelete={removeById}
            />
          ))}
        </div>
      ) : (
        <PullToRefresh onRefresh={() => refetch()}>
          <div
            className="kanban__pager has-fab"
            onTouchStart={onPagerStart}
            onTouchMove={onPagerMove}
            onTouchEnd={onPagerEnd}
            onTouchCancel={onPagerEnd}
            /* A swipe ends in a synthesized click on whatever was under the
               finger. The browser suppresses that when *it* scrolled; here the
               movement is a transform, so it does not — and the page swipe
               would open whichever card it finished on. */
            onClickCapture={(e) => {
              if (!swiped.current) return;
              swiped.current = false;
              e.stopPropagation();
              e.preventDefault();
            }}
            style={{
              padding: '10px 12px 16px',
              transform: drag ? `translateX(${drag}px)` : undefined,
              transition: drag ? 'none' : 'transform 0.22s cubic-bezier(0.2,0.8,0.2,1)',
              willChange: drag ? 'transform' : undefined,
            }}
          >
            {(counts.get(shown) ?? 0) === 0 ? (
              <Empty
                icon="—"
                title={
                  debouncedQuery.trim()
                    ? 'Nothing matches'
                    : `Nothing in ${COLUMN_LABEL[shown as Column] ?? 'Archived'}`
                }
                hint={
                  debouncedQuery.trim()
                    ? 'Search covers every column on this board — titles, descriptions, summaries and ids.'
                    : assignee === ALL
                      ? 'Cards the agent creates appear here automatically.'
                      : `No cards for @${assignee} in this column.`
                }
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(columns.get(shown) ?? []).map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    next={NEXT_STAGE[shown as Column] ?? null}
                    nextLabel={
                      NEXT_STAGE[shown as Column] ? COLUMN_LABEL[NEXT_STAGE[shown as Column]!] : ''
                    }
                    selecting={selecting}
                    selected={selected.has(t.id)}
                    revealed={revealed === t.id}
                    onReveal={setRevealed}
                    onOpen={selecting ? toggleSelected : openTaskById}
                    onAdvance={advanceById}
                    onDelete={removeById}
                  />
                ))}
              </div>
            )}
          </div>
        </PullToRefresh>
      )}

      {selecting && selectedCount > 0 && (
        <BulkBar count={selectedCount} busy={bulk.isPending} assignees={assignees} onApply={applyBulk} />
      )}

      {!unavailable && !selecting && (
        <button className="fab" onClick={() => setCreating(true)} aria-label="New task">
          <IconPlus size={22} />
        </button>
      )}

      <SelectSheet
        open={pickingBoard}
        title="Which board"
        options={[
          {
            value: SERVER_BOARD,
            label: 'Server default',
            hint: `Follows whichever board Hermes points at (${boards.data?.current ?? 'unknown'})`,
          },
          ...boardList.map((b) => ({
            value: b.slug,
            label: b.name || b.slug,
            hint: `${b.total} card${b.total === 1 ? '' : 's'}`,
          })),
        ]}
        value={board ?? SERVER_BOARD}
        onChange={(v) => {
          setRevealed(null);
          setBoard(v === SERVER_BOARD ? null : v);
          /* A different board has different columns populated, so a pinned
             column is meaningless there — falling back to "first with cards"
             is the same behaviour as a first load. The selection goes too: its
             ids belong to the board being left. */
          setActive(null);
          setSelected(new Set());
        }}
        onClose={() => setPickingBoard(false)}
      />
      <SelectSheet
        open={pickingAssignee}
        title="Whose cards"
        options={[
          { value: ALL, label: 'Everyone', hint: 'Every card on the board' },
          ...assignees.map((a) => ({ value: a, label: `@${a}` })),
        ]}
        value={assignee}
        onChange={setAssignee}
        onClose={() => setPickingAssignee(false)}
      />
      <SelectSheet
        open={pickingTenant}
        title="Which tenant"
        options={[
          { value: ALL, label: 'All tenants' },
          ...tenants.map((t) => ({ value: t, label: t })),
        ]}
        value={tenant}
        onChange={setTenant}
        onClose={() => setPickingTenant(false)}
      />

      <BoardMenuSheet
        open={menuOpen}
        archived={archived}
        onClose={() => setMenuOpen(false)}
        onPick={(action) => {
          /* A clean hand-off: this sheet closes as the next opens. That used to
             close the newcomer a frame after it appeared — `useHistoryDismiss`
             now recognises the pattern and hands the history entry over rather
             than popping it out from under. */
          setMenuOpen(false);
          if (action === 'health') setHealthOpen(true);
          else if (action === 'settings') setSettingsOpen(true);
          else if (action === 'select') {
            setRevealed(null);
            setSelecting(true);
          }
          else setShowArchived(!archived);
        }}
      />
      <BoardHealthSheet
        open={healthOpen}
        board={board}
        onClose={() => setHealthOpen(false)}
        onOpenTask={openTaskById}
      />
      <BoardSettingsSheet
        open={settingsOpen}
        board={board}
        onClose={() => setSettingsOpen(false)}
        onPickBoard={(slug) => {
          setBoard(slug);
          setActive(null);
        }}
      />

      <TaskSheet
        taskId={openTask}
        board={board}
        onClose={() => setOpenTask(null)}
        onOpenTask={setOpenTask}
      />
      <NewTaskSheet
        open={creating}
        board={board}
        onClose={() => setCreating(false)}
        onCreated={() => qc.invalidateQueries({ queryKey: ['kanban', board ?? null, 'board'] })}
      />
    </div>
  );
}

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
type BoardAction = 'health' | 'settings' | 'select' | 'archived';

function BoardMenuSheet({
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

/**
 * What can be done to a selection.
 *
 * Deliberately three verbs and not the whole PATCH surface: a bulk action is a
 * blunt instrument, and the ones worth having are the ones that are tedious
 * card by card. Archiving is offered instead of deleting because there is no
 * undo on a bulk delete anywhere in Hermes, and a mis-tapped selection is
 * exactly how one happens.
 */
function BulkBar({
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

/**
 * One swimlane. Scrolls on its own axis so a hundred-card Done column cannot
 * stretch the board, and keeps its heading pinned while it does.
 */
function Lane({
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
