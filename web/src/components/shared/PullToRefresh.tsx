/**
 * Pull-to-refresh for scroll containers.
 *
 * Only engages when the container is already at the top, so it never fights
 * normal scrolling. Resistance is applied to the drag so the gesture feels
 * weighted rather than linear.
 */
import { useRef, useState, type ReactNode } from 'react';
import { IconRefresh } from './Icons';
import { buzz } from '../../lib/haptics';

const THRESHOLD = 64;
const RESISTANCE = 0.45;

interface Props {
  onRefresh: () => Promise<unknown> | void;
  children: ReactNode;
  className?: string;
}

export function PullToRefresh({ onRefresh, children, className = 'scroll' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const armed = useRef(false);
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);

  const onTouchStart = (e: React.TouchEvent) => {
    if (busy) return;
    const el = ref.current;
    armed.current = !!el && el.scrollTop <= 0;
    startY.current = e.touches[0]?.clientY ?? null;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!armed.current || startY.current === null || busy) return;
    const dy = (e.touches[0]?.clientY ?? 0) - startY.current;
    if (dy <= 0) {
      setPull(0);
      return;
    }
    const next = Math.min(dy * RESISTANCE, THRESHOLD * 1.6);
    // Crossing the threshold is the moment worth confirming by touch.
    if (next >= THRESHOLD && pull < THRESHOLD) buzz('tap');
    setPull(next);
  };

  const onTouchEnd = async () => {
    if (pull >= THRESHOLD && !busy) {
      setBusy(true);
      setPull(THRESHOLD * 0.6);
      try {
        await onRefresh();
      } finally {
        setBusy(false);
        setPull(0);
      }
    } else {
      setPull(0);
    }
    armed.current = false;
    startY.current = null;
  };

  return (
    <div
      ref={ref}
      className={className}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div className="ptr" style={{ height: pull }}>
        {pull > 8 && (
          <span className={busy ? 'spin' : undefined} style={{ display: 'grid' }}>
            <IconRefresh size={17} />
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
