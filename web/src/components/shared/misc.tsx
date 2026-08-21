import type { ReactNode } from 'react';
import { useUi } from '../../store/ui';
import { IconCheck } from './Icons';

export function Skeleton({ h = 60, mb = 10 }: { h?: number; mb?: number }) {
  return <div className="skeleton" style={{ height: h, marginBottom: mb }} />;
}

/**
 * Material switch — the correct control for a setting that applies at once,
 * and a replacement for the raw checkbox, which rendered as the stock system
 * tick regardless of theme. The handle grows and carries a check when on.
 */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      onClick={() => onChange(!checked)}
    >
      <span className="switch__handle">
        <IconCheck size={14} />
      </span>
    </button>
  );
}

/**
 * Material 3 Expressive's loading indicator, which replaces indeterminate
 * circular progress for waits under about five seconds.
 */
export function Loader({ size = 'md', muted = false }: { size?: 'sm' | 'md'; muted?: boolean }) {
  return (
    <div
      className={`loader${size === 'sm' ? ' loader--sm' : ''}${muted ? ' loader--muted' : ''}`}
      role="status"
      aria-label="Loading"
    />
  );
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

/**
 * The app's feedback channel.
 *
 * Announced, because this is where errors land — a failed send, a rejected
 * rename, a cron run that failed while you were on another screen — and a
 * channel that only exists visually reports none of it to anyone using a
 * screen reader. `assertive` for errors, since those interrupt what someone is
 * doing; `polite` for everything else, which can wait for a gap.
 *
 * The body is a button rather than a div with a click handler, so dismissing
 * works from a keyboard and the control announces itself as one.
 */
export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);

  const hasError = toasts.some((t) => t.tone === 'error');

  return (
    <div
      className="toasts"
      role={hasError ? 'alert' : 'status'}
      aria-live={hasError ? 'assertive' : 'polite'}
      // Read the whole toast when it changes, not just the words that differ.
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`}>
          <button
            type="button"
            className="toast__body"
            onClick={() => dismiss(t.id)}
            aria-label={`${t.text}. Dismiss`}
          >
            {t.text}
          </button>
          {t.action && (
            <button
              type="button"
              className="toast__action"
              onClick={() => {
                t.action?.onAction();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
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
