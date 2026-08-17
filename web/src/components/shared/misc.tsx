import type { ReactNode } from 'react';
import { useUi } from '../../store/ui';

export function Skeleton({ h = 60, mb = 10 }: { h?: number; mb?: number }) {
  return <div className="skeleton" style={{ height: h, marginBottom: mb }} />;
}

export function SkeletonList({ n = 5, h = 60 }: { n?: number; h?: number }) {
  return (
    <div style={{ padding: 12 }}>
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} h={h} />
      ))}
    </div>
  );
}

export function Empty({
  icon = '·',
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__icon">{icon}</div>
      <div className="empty__title">{title}</div>
      {hint && <div style={{ fontSize: 13.5, maxWidth: 300 }}>{hint}</div>}
      {action}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return (
    <div className="empty">
      <div className="empty__icon" style={{ color: 'var(--error)' }}>
        !
      </div>
      <div className="empty__title">Couldn't load</div>
      <div style={{ fontSize: 13.5, maxWidth: 320 }}>{msg}</div>
    </div>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Compact relative time: "3m", "2h", "5d". */
export function relTime(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return '';
  const diff = Date.now() / 1000 - epochSeconds;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/** "Today" / "Yesterday" / a date — used for session list group headers. */
export function dayGroup(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const today = new Date();
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yest)) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

export function formatTokens(n: number | null | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
