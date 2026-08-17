/**
 * A kanban card. Swipe right to advance a stage, left to delete.
 * Shares the axis-locking gesture approach used by the session rows.
 */
import { useRef, useState } from 'react';
import { IconChevron, IconTrash } from '../shared/Icons';
import { relTime } from '../shared/misc';
import { buzz } from '../../lib/haptics';
import type { Task } from '../../api/kanban';

const COMMIT_PX = 92;
const MAX_PX = 124;

const PRIORITY_COLOR = ['var(--text-faint)', 'var(--info)', 'var(--warn)', 'var(--error)'];

interface Props {
  task: Task;
  canAdvance: boolean;
  nextLabel: string;
  onOpen: () => void;
  onAdvance: () => void;
  onDelete: () => void;
}

export function TaskCard({ task, canAdvance, nextLabel, onOpen, onAdvance, onDelete }: Props) {
  const [dx, setDx] = useState(0);
  const startX = useRef(0);
  const startY = useRef(0);
  const axis = useRef<'none' | 'x' | 'y'>('none');
  const armed = useRef(false);

  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    const dX = t.clientX - startX.current;
    const dY = t.clientY - startY.current;

    if (axis.current === 'none') {
      if (Math.abs(dX) > 10 || Math.abs(dY) > 10) {
        axis.current = Math.abs(dX) > Math.abs(dY) ? 'x' : 'y';
      } else return;
    }
    if (axis.current !== 'x') return;

    // Don't let the card drag right when there is nowhere to advance to.
    const bounded = dX > 0 && !canAdvance ? 0 : dX;
    const clamped = Math.max(-MAX_PX, Math.min(MAX_PX, bounded));
    if (Math.abs(clamped) >= COMMIT_PX && !armed.current) {
      armed.current = true;
      buzz('tap');
    } else if (Math.abs(clamped) < COMMIT_PX) {
      armed.current = false;
    }
    setDx(clamped);
  };

  const onTouchEnd = () => {
    if (dx <= -COMMIT_PX) onDelete();
    else if (dx >= COMMIT_PX && canAdvance) onAdvance();
    setDx(0);
    axis.current = 'none';
    armed.current = false;
  };

  const failing = task.consecutive_failures > 0;

  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 'var(--radius-sm)' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          background: dx < 0 ? 'var(--error)' : 'var(--ok)',
          color: '#fff',
          fontSize: 13,
          fontWeight: 600,
          opacity: Math.min(1, Math.abs(dx) / COMMIT_PX),
        }}
      >
        <span style={{ opacity: dx > 0 ? 1 : 0, display: 'flex', alignItems: 'center', gap: 5 }}>
          <IconChevron size={16} /> {nextLabel}
        </span>
        <IconTrash size={18} style={{ opacity: dx < 0 ? 1 : 0 }} />
      </div>

      <div
        onTouchStart={(e) => {
          const t = e.touches[0];
          if (!t) return;
          startX.current = t.clientX;
          startY.current = t.clientY;
          axis.current = 'none';
        }}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={() => {
          buzz('tap');
          onOpen();
        }}
        style={{
          position: 'relative',
          transform: `translateX(${dx}px)`,
          transition: dx === 0 ? 'transform 0.2s cubic-bezier(0.2,0.8,0.2,1)' : 'none',
          background: 'var(--bg-elev)',
          border: `1px solid ${failing ? 'var(--error)' : 'var(--border-soft)'}`,
          borderLeft: `3px solid ${PRIORITY_COLOR[Math.min(task.priority, 3)]}`,
          borderRadius: 'var(--radius-sm)',
          padding: '12px 13px',
          cursor: 'pointer',
        }}
      >
        <div style={{ fontWeight: 550, fontSize: 14.5, lineHeight: 1.35 }}>{task.title}</div>

        {task.latest_summary && (
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--text-dim)',
              marginTop: 5,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {task.latest_summary}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            gap: 9,
            marginTop: 8,
            fontSize: 11.5,
            color: 'var(--text-faint)',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontFamily: 'var(--mono)' }}>{task.id}</span>
          {task.assignee && <span>@{task.assignee}</span>}
          {(task.comment_count ?? 0) > 0 && <span>💬 {task.comment_count}</span>}
          {failing && (
            <span style={{ color: 'var(--error)', fontWeight: 600 }}>
              ⚠ {task.consecutive_failures} fail{task.consecutive_failures > 1 ? 's' : ''}
            </span>
          )}
          {task.block_kind && <span style={{ color: 'var(--warn)' }}>blocked: {task.block_kind}</span>}
          <span style={{ marginLeft: 'auto' }}>{relTime(task.created_at)}</span>
        </div>
      </div>
    </div>
  );
}
