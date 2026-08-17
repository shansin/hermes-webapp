/**
 * A swipeable session row.
 *
 * Swipe left reveals delete, swipe right resumes immediately. The row tracks
 * the finger, then either snaps back or commits past a threshold — the usual
 * mobile list idiom, so it needs no instructions.
 */
import { useRef, useState } from 'react';
import { IconTrash, IconChat } from '../shared/Icons';
import { relTime } from '../shared/misc';
import { buzz } from '../../lib/haptics';
import type { SessionRow as Row } from '../../api/sessions';

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
  onResume: () => void;
  onDelete: () => void;
  onToggleSelect: () => void;
  onLongPress: () => void;
}

export function SessionRowItem({
  session,
  selected,
  selecting,
  onResume,
  onDelete,
  onToggleSelect,
  onLongPress,
}: Props) {
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
      onLongPress();
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
      onDelete();
    } else if (dx >= COMMIT_PX) {
      buzz('done');
      onResume();
    }
    setDx(0);
    axis.current = 'none';
  };

  const title = session.title || 'Untitled session';

  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 'var(--radius-sm)' }}>
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
        onClick={() => (selecting ? onToggleSelect() : onResume())}
        style={{
          position: 'relative',
          transform: `translateX(${dx}px)`,
          transition: dx === 0 ? 'transform 0.2s cubic-bezier(0.2,0.8,0.2,1)' : 'none',
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

        <span style={{ fontSize: 16, flexShrink: 0, width: 20, textAlign: 'center' }}>
          {SOURCE_ICON[session.source ?? ''] ?? '·'}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 550,
              fontSize: 14.5,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--text-faint)',
              display: 'flex',
              gap: 8,
              marginTop: 2,
            }}
          >
            <span>{session.message_count} msg</span>
            {session.model && (
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

        <span style={{ fontSize: 11.5, color: 'var(--text-faint)', flexShrink: 0 }}>
          {relTime(session.started_at)}
        </span>
      </div>
    </div>
  );
}
