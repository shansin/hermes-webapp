/**
 * A swipeable session row.
 *
 * Swipe left reveals delete, swipe right resumes immediately. The row tracks
 * the finger, then either snaps back or commits past a threshold — the usual
 * mobile list idiom, so it needs no instructions.
 */
import { memo, useRef, useState } from 'react';
import { IconTrash, IconChat } from '../shared/Icons';
import { relTime } from '../shared/misc';
import { buzz } from '../../lib/haptics';
import { isOn, type SessionRow as Row } from '../../api/sessions';
import { parseTags, tagHue } from '../../lib/sessionTags';

const COMMIT_PX = 96;
const MAX_PX = 130;

const SOURCE_ICON: Record<string, string> = {
  web: '🌐',
  discord: '💬',
  cli: '›_',
  tui: '›_',
  cron: '⏰',
  telegram: '✈️',
};

interface Props {
  session: Row;
  selected: boolean;
  selecting: boolean;
  /**
   * The model every visible row shares, if there is one. Repeating it down the
   * whole list is noise, so a row hides its model when it matches.
   */
  commonModel?: string | null;
  /**
   * Handlers take the session id instead of closing over it, so the list can
   * hand every row the same functions. Per-row arrows would defeat the memo
   * below — a fresh closure each render reads as a changed prop.
   */
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onLongPress: (id: string) => void;
  /** Opens the pin / archive / export sheet for this session. */
  onActions: (id: string) => void;
  /** Tapping a tag chip filters the list to it. */
  onPickTag: (tag: string) => void;
}

export const SessionRowItem = memo(function SessionRowItem({
  session,
  selected,
  selecting,
  commonModel,
  onResume,
  onDelete,
  onToggleSelect,
  onLongPress,
  onActions,
  onPickTag,
}: Props) {
  const modelIsRedundant = Boolean(commonModel) && session.model === commonModel;
  const pinned = isOn(session.pinned);
  const archived = isOn(session.archived);
  const [dx, setDx] = useState(0);
  const startX = useRef(0);
  const startY = useRef(0);
  const axis = useRef<'none' | 'x' | 'y'>('none');
  const longTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armed = useRef(false);

  const cancelLongPress = () => {
    if (longTimer.current) clearTimeout(longTimer.current);
    longTimer.current = null;
  };

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    startX.current = t.clientX;
    startY.current = t.clientY;
    axis.current = 'none';
    armed.current = false;
    longTimer.current = setTimeout(() => {
      buzz('warn');
      onLongPress(session.id);
    }, 480);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    const dX = t.clientX - startX.current;
    const dY = t.clientY - startY.current;

    // Lock to an axis once the gesture is unambiguous, so a vertical scroll
    // never drags the row sideways.
    if (axis.current === 'none') {
      if (Math.abs(dX) > 10 || Math.abs(dY) > 10) {
        axis.current = Math.abs(dX) > Math.abs(dY) ? 'x' : 'y';
        cancelLongPress();
      } else {
        return;
      }
    }
    if (axis.current !== 'x' || selecting) return;

    const clamped = Math.max(-MAX_PX, Math.min(MAX_PX, dX));
    if (Math.abs(clamped) >= COMMIT_PX && !armed.current) {
      armed.current = true;
      buzz('tap');
    } else if (Math.abs(clamped) < COMMIT_PX) {
      armed.current = false;
    }
    setDx(clamped);
  };

  const onTouchEnd = () => {
    cancelLongPress();
    if (dx <= -COMMIT_PX) {
      buzz('warn');
      onDelete(session.id);
    } else if (dx >= COMMIT_PX) {
      buzz('done');
      onResume(session.id);
    }
    setDx(0);
    axis.current = 'none';
  };

  // `#tag` in a title is how tags are stored — show them as chips and keep the
  // title itself clean.
  const parsed = parseTags(session.title);
  const title = parsed.text || 'Untitled session';

  return (
    <div
      className="srow"
      style={{ position: 'relative', overflow: 'hidden', borderRadius: 'var(--radius-sm)' }}
    >
      {/* Action layers, revealed by the drag */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 18px',
          background: dx < 0 ? 'var(--error)' : 'var(--ok)',
          color: '#fff',
          opacity: Math.min(1, Math.abs(dx) / COMMIT_PX),
        }}
      >
        <IconChat size={19} style={{ opacity: dx > 0 ? 1 : 0 }} />
        <IconTrash size={19} style={{ opacity: dx < 0 ? 1 : 0 }} />
      </div>

      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={() => (selecting ? onToggleSelect(session.id) : onResume(session.id))}
        style={{
          position: 'relative',
          transform: `translateX(${dx}px)`,
          transition: dx === 0 ? 'transform var(--motion-spatial)' : 'none',
          background: selected ? 'var(--accent-soft)' : 'var(--bg-elev)',
          border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-soft)'}`,
          borderRadius: 'var(--radius-sm)',
          padding: '11px 13px',
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          cursor: 'pointer',
        }}
      >
        {selecting && (
          <span
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              border: `2px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
              background: selected ? 'var(--accent)' : 'transparent',
              flexShrink: 0,
            }}
          />
        )}

        <span style={{ fontSize: 'var(--type-body-lg)', flexShrink: 0, width: 20, textAlign: 'center' }}>
          {SOURCE_ICON[session.source ?? ''] ?? '·'}
        </span>

        {pinned && (
          <span
            aria-label="Pinned"
            title="Pinned"
            style={{ color: 'var(--accent)', fontSize: 'var(--type-detail)', flexShrink: 0 }}
          >
            ★
          </span>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Two lines rather than one: most titles are sentences, and a
              single-line ellipsis was cutting them mid-word. The clamp can
              only place its ellipsis at a break opportunity, so a title that
              is one long unbreakable token — a path, typically, from a prompt
              about a file — hard-clipped mid-word instead. `anywhere` gives
              the clamp somewhere to break. */}
          <div
            style={{
              fontWeight: 550,
              fontSize: 'var(--type-title-sm)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              overflowWrap: 'anywhere',
              lineHeight: 1.35,
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 'var(--type-label-sm)',
              color: 'var(--text-faint)',
              display: 'flex',
              gap: 8,
              marginTop: 2,
            }}
          >
            {parsed.tags.map((t) => (
              <button
                key={t}
                className="tag-chip"
                style={{ '--tag-hue': tagHue(t) } as React.CSSProperties}
                onTouchStart={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  buzz('tap');
                  onPickTag(t);
                }}
              >
                #{t}
              </button>
            ))}
            <span>{session.message_count} msg</span>
            {archived && <span>Archived</span>}
            {session.model && !modelIsRedundant && (
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 150,
                }}
              >
                {session.model}
              </span>
            )}
          </div>
        </div>

        <span style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', flexShrink: 0 }}>
          {relTime(session.started_at)}
        </span>

        {!selecting && (
          // Swiping covers resume and delete; everything else needs somewhere
          // to live. Stop the touch here so opening the menu can't also arm
          // the row's long-press or swipe.
          <button
            className="icon-btn"
            aria-label="Session actions"
            onTouchStart={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              buzz('tap');
              onActions(session.id);
            }}
            style={{ flexShrink: 0, minWidth: 32, minHeight: 32, marginRight: -4 }}
          >
            ⋯
          </button>
        )}
      </div>
    </div>
  );
});
