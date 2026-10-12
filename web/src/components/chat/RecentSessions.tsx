/**
 * "Pick up where you left off": the recent conversations on the empty chat.
 *
 * Its own file because it shares nothing with the transcript around it — its
 * own query, its own measurement loop — and only renders when there is no
 * transcript at all.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessions } from '../../api/sessions';
import { kindOf } from '../../lib/sessionKinds';
import { relTime } from '../shared/misc';
import { IconChevron } from '../shared/Icons';
import { buzz } from '../../lib/haptics';

/**
 * How many rows the list may ever show, and what one costs vertically.
 *
 * The cap is a judgement rather than a limit: past about eight this stops
 * being "pick up where you left off" and becomes the Sessions screen, which is
 * one tap away and does the job better. `ROW_PX` is the row's height plus its
 * gap, used only to work out how many will fit.
 */
const MAX_RECENTS = 8;
/**
 * How many rows to ask for so that eight *conversations* survive the filter.
 *
 * The list below shows only what a person started, and on this install the
 * automated sessions outnumber those heavily — a morning of cron runs and a
 * decomposed board can be thirty rows deep before yesterday's chat. Asking for
 * eight and filtering would routinely render one row, or none. The endpoint
 * has no `source` filter, so the pool is fetched and narrowed here; it is
 * still one request, of compact rows, and it is the only `useSessions` call in
 * the app.
 */
const RECENTS_POOL = 60;
const ROW_PX = 50;
/** Never fewer than this, even on a short screen — one row reads as an error. */
const MIN_RECENTS = 3;

/**
 * The most recent conversations, offered on the empty chat.
 *
 * This is the screen the app opens on, and picking up yesterday's thread is
 * the most common thing to want next — it was previously three taps away
 * through the drawer and the session list, on a screen that was otherwise
 * two-thirds empty.
 *
 * The count is **measured, not fixed**. Three was chosen for a phone and left
 * a tablet and a desktop window mostly blank, while a fixed larger number
 * would overflow a small phone and push the list under the composer. So the
 * space actually left below the heading decides, clamped at both ends: enough
 * rows to be worth reading, never so many that this becomes a second session
 * list.
 *
 * One query either way. `useSessions` is keyed on its limit, so fetching the
 * maximum once and slicing is a single request that survives a resize, where
 * fetching the measured count would refetch every time the window changed.
 *
 * Cron runs and kanban workers are excluded. This is "pick up where you left
 * off", and neither of those is somewhere you left off — they are the agent's
 * own scheduled and dispatched work, they carry no thread of yours to resume,
 * and on a busy machine they are most of the list. `kindOf` is the Sessions
 * screen's own rule, including its one guarantee: an unrecognised source
 * counts as yours, so a surface a future Hermes adds appears here rather than
 * disappearing silently.
 */
export function RecentSessions() {
  const navigate = useNavigate();
  const { data } = useSessions(RECENTS_POOL);
  const [fits, setFits] = useState(MIN_RECENTS);
  const box = useRef<HTMLDivElement | null>(null);

  const mine = useMemo(
    () => (data?.sessions ?? []).filter((s) => kindOf(s.source) === 'mine'),
    [data?.sessions],
  );

  /**
   * Work out how many rows fit.
   *
   * **Not** from this element's distance to the bottom of the screen, which is
   * the obvious measurement and is circular: the empty state is vertically
   * centred, so adding a row moves the whole block *up*, which frees room
   * below, which admits another row. Measured that way it settles wherever it
   * started — three rows on a phone with space for eight.
   *
   * So the two stable quantities are used instead: the scroll viewport, whose
   * height does not depend on its content, and the height of everything in the
   * empty state that is *not* this list (the mark, the title, the hint). Their
   * difference is constant however many rows are drawn, so the count converges
   * on the first pass.
   *
   * A `ResizeObserver` rather than a window listener because the composer
   * grows as you type and the keyboard takes half a phone's screen, and
   * neither of those is a window resize.
   */
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      const viewport = el.closest('.chat__list');
      const empty = el.closest('.empty');
      if (!viewport || !empty) return;
      // Everything above this list inside the empty state. Constant.
      const chrome = (empty as HTMLElement).offsetHeight - el.offsetHeight;
      // The real row height, so this follows the type scale rather than
      // assuming it; the constant is only a fallback for an empty list.
      const row = (el.querySelector('.recents__row') as HTMLElement | null)?.offsetHeight;
      const step = (row ?? ROW_PX - 6) + 6;
      const room = viewport.clientHeight - chrome - 32;
      const n = Math.floor(room / step);
      setFits(Math.max(MIN_RECENTS, Math.min(MAX_RECENTS, n)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const viewport = el.closest('.chat__list');
    if (viewport) observer.observe(viewport);
    return () => observer.disconnect();
    /* Keyed on how many sessions came back, not on how many are shown. This
       component renders nothing until the query resolves, so on the first pass
       the ref is null and there is nothing to measure or observe — with an
       empty dependency list that was the only pass there ever was, and the
       count stayed at its floor for ever. Depending on the *displayed* count
       instead would tear the observer down and rebuild it on every adjustment
       it made. */
  }, [mine.length]);

  const rows = mine.slice(0, fits);
  if (rows.length === 0) return null;

  return (
    <div className="recents" ref={box}>
      <div className="recents__label">PICK UP WHERE YOU LEFT OFF</div>
      <div className="recents__list">
        {rows.map((r) => (
          <button
            key={r.id}
            className="card recents__row"
            onClick={() => {
              buzz('tap');
              // Replace: this list is *on* /chat, so pushing another /chat
              // entry left back landing on the same route without remounting
              // — a press that visibly did nothing, and a second one that left
              // the app.
              navigate(`/chat?resume=${encodeURIComponent(r.id)}`, { replace: true });
            }}
          >
            <span className="recents__text">
              <span className="recents__title">{r.title || 'Untitled'}</span>
              <span className="recents__meta">
                {r.message_count} msg · {relTime(r.ended_at ?? r.started_at)}
              </span>
            </span>
            <IconChevron size={15} />
          </button>
        ))}
      </div>
    </div>
  );
}
