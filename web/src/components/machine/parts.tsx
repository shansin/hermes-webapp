/**
 * Small pieces the Machine sections share: a label/value row, a status dot, a
 * meter, and the confirmation every destructive action goes through.
 *
 * The confirmation is a sheet rather than `window.confirm`, for the reason the
 * gateway restart already was one: a native dialog in an installed PWA is a
 * browser-chrome box that names the origin instead of the action, and on iOS
 * it can be suppressed outright.
 */
import type { ReactNode } from 'react';
import { Sheet } from '../shared/Sheet';
import type { Tone } from '../../lib/machine';

export const smallBtn = { fontSize: 'var(--type-detail)', padding: '7px 11px' } as const;

export const toneColor: Record<Tone, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  error: 'var(--error)',
  off: 'var(--text-faint)',
};

export function Dot({ tone }: { tone: Tone }) {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: toneColor[tone],
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}

export function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '5px 0', fontSize: 'var(--type-detail)' }}>
      <span style={{ flex: 1, color: 'var(--text-faint)' }}>{label}</span>
      <span
        style={{
          color: tone ? toneColor[tone] : 'var(--text-dim)',
          fontFamily: 'var(--mono)',
          fontSize: 'var(--type-body-sm)',
          textAlign: 'right',
          overflowWrap: 'anywhere',
          minWidth: 0,
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function Hint({ children, tone }: { children: ReactNode; tone?: Tone }) {
  return (
    <div
      style={{
        fontSize: 'var(--type-body-sm)',
        color: tone ? toneColor[tone] : 'var(--text-faint)',
        lineHeight: 1.45,
        overflowWrap: 'anywhere',
      }}
    >
      {children}
    </div>
  );
}

/** A horizontal meter, coloured by how worried to be. */
export function Meter({ percent, tone, label }: { percent: number; tone: Tone; label: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      style={{ height: 6, borderRadius: 3, background: 'var(--bg-elev)', overflow: 'hidden', margin: '4px 0 2px' }}
    >
      <div style={{ width: `${clamped}%`, height: '100%', background: toneColor[tone], transition: 'width 0.4s' }} />
    </div>
  );
}

/**
 * Yes/no for one destructive action. `confirmLabel` names the act ("Delete
 * 12 sessions"), so the button read alone still says what it does.
 */
export function ConfirmSheet({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div style={{ marginTop: 0, color: 'var(--text-dim)', fontSize: 'var(--type-body-md)', lineHeight: 1.5, marginBottom: 14 }}>
        {children}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn--danger"
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
