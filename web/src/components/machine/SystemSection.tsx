/**
 * The host: CPU, memory, disk, uptime, and the backend process.
 *
 * `/api/system/stats` samples CPU for a tenth of a second on every call and
 * reads psutil for the rest, so it is polled only while this section is
 * actually on screen — an IntersectionObserver gates the query, and TanStack
 * already stops intervals in a hidden tab. Scrolled past or backgrounded, it
 * costs nothing.
 *
 * Without psutil on the backend only identity and load average come back;
 * the meters are left out rather than drawn at zero.
 */
import { useEffect, useRef, useState } from 'react';
import { useSystemStats } from '../../api/machine';
import { formatBytes, formatUptime, loadTone } from '../../lib/machine';
import { Skeleton } from '../shared/misc';
import { Hint, Meter, Row } from './parts';

function useOnScreen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // No observer (an old WebView, jsdom): poll whenever the screen is open.
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, visible];
}

function Gauge({ label, percent, detail }: { label: string; percent: number | undefined; detail: string }) {
  if (typeof percent !== 'number') return null;
  return (
    <div style={{ padding: '6px 0' }}>
      <div style={{ display: 'flex', fontSize: 'var(--type-detail)' }}>
        <span style={{ flex: 1, color: 'var(--text-faint)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--type-body-sm)', color: 'var(--text-dim)' }}>
          {Math.round(percent)}%
        </span>
      </div>
      <Meter percent={percent} tone={loadTone(percent)} label={`${label} ${Math.round(percent)}%`} />
      <Hint>{detail}</Hint>
    </div>
  );
}

export function SystemSection() {
  const [ref, onScreen] = useOnScreen<HTMLDivElement>();
  const stats = useSystemStats(onScreen);
  const s = stats.data;

  return (
    <>
      <div className="group-head">SYSTEM</div>
      <div ref={ref} className="card" style={{ marginBottom: 16 }}>
        {!s ? (
          stats.isError ? (
            <Hint tone="error">{stats.error instanceof Error ? stats.error.message : 'Could not read host stats.'}</Hint>
          ) : (
            <Skeleton h={90} mb={0} />
          )
        ) : (
          <>
            <Gauge
              label="CPU"
              percent={s.cpu_percent}
              detail={`${s.cpu_count ?? '?'} cores${
                s.load_avg?.length ? ` · load ${s.load_avg.map((n) => n.toFixed(2)).join(' ')}` : ''
              }`}
            />
            {s.memory && (
              <Gauge
                label="Memory"
                percent={s.memory.percent}
                detail={`${formatBytes(s.memory.used)} of ${formatBytes(s.memory.total)} · ${formatBytes(s.memory.available)} available`}
              />
            )}
            {s.disk && (
              <Gauge
                label="Disk (Hermes home)"
                percent={s.disk.percent}
                detail={`${formatBytes(s.disk.free)} free of ${formatBytes(s.disk.total)}`}
              />
            )}
            {typeof s.cpu_percent !== 'number' && s.load_avg?.length ? (
              <Row label="Load" value={s.load_avg.map((n) => n.toFixed(2)).join(' ')} />
            ) : null}
            <div style={{ borderTop: '1px solid var(--border-soft)', marginTop: 6, paddingTop: 4 }}>
              <Row label="Host" value={s.hostname ?? '—'} />
              <Row label="OS" value={[s.os, s.os_release, s.arch].filter(Boolean).join(' ') || '—'} />
              {s.uptime_seconds != null && <Row label="Up" value={formatUptime(s.uptime_seconds)} />}
              {s.process && (
                <Row
                  label="Hermes process"
                  value={`${formatBytes(s.process.rss)} · ${s.process.num_threads} threads`}
                />
              )}
            </div>
            {s.psutil === false && (
              <Hint>psutil is not installed in Hermes' environment, so CPU, memory and disk are unavailable.</Hint>
            )}
          </>
        )}
      </div>
    </>
  );
}
