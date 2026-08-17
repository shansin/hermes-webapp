/**
 * Settings: theme, haptics, onboarding QR, backend status, and the hidden dev
 * panel (triple-tap the heading) that shows raw JSON-RPC frames.
 */
import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useHealth } from '../../api/hub';
import { useUi, type Theme } from '../../store/ui';
import { hermes } from '../../ws/client';
import { buzz } from '../../lib/haptics';

const THEMES: { id: Theme; label: string; swatch: string }[] = [
  { id: 'dark', label: 'Dark', swatch: '#0b0b0f' },
  { id: 'amoled', label: 'AMOLED', swatch: '#000000' },
  { id: 'light', label: 'Light', swatch: '#f7f7fa' },
];

function DevPanel() {
  const [frames, setFrames] = useState<{ dir: 'in' | 'out'; raw: string; at: number }[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(
    () =>
      hermes.onFrame((dir, raw) => {
        if (pausedRef.current) return;
        // Keep only a bounded tail — a streaming turn emits hundreds.
        setFrames((f) => [...f.slice(-180), { dir, raw, at: Date.now() }]);
      }),
    [],
  );

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
        <div style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>Raw WS frames</div>
        <button className="btn btn--sm" onClick={() => setPaused((p) => !p)}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button className="btn btn--sm" onClick={() => setFrames([])}>
          Clear
        </button>
      </div>
      <div
        style={{
          maxHeight: 320,
          overflowY: 'auto',
          fontFamily: 'var(--mono)',
          fontSize: 10.5,
          lineHeight: 1.45,
        }}
      >
        {frames.length === 0 && (
          <div style={{ color: 'var(--text-faint)' }}>Waiting for traffic…</div>
        )}
        {frames.map((f, i) => (
          <div
            key={i}
            style={{
              padding: '3px 0',
              borderBottom: '1px solid var(--border-soft)',
              color: f.dir === 'out' ? 'var(--info)' : 'var(--text-dim)',
              overflowWrap: 'anywhere',
            }}
          >
            <strong>{f.dir === 'out' ? '→' : '←'}</strong> {f.raw.slice(0, 600)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SettingsTab() {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const haptics = useUi((s) => s.haptics);
  const setHaptics = useUi((s) => s.setHaptics);
  const devPanel = useUi((s) => s.devPanel);
  const setDevPanel = useUi((s) => s.setDevPanel);
  const connection = useUi((s) => s.connection);

  const health = useHealth();

  // Triple-tap the heading to reveal the dev panel.
  const taps = useRef<number[]>([]);
  const onHeadingTap = () => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < 900), now];
    if (taps.current.length >= 3) {
      taps.current = [];
      buzz('done');
      setDevPanel(!devPanel);
    }
  };

  const url = typeof location !== 'undefined' ? location.origin : '';

  return (
    <div style={{ padding: 12 }}>
      <div
        onClick={onHeadingTap}
        style={{ fontSize: 11.5, color: 'var(--text-faint)', fontWeight: 650, marginBottom: 8 }}
      >
        APPEARANCE
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {THEMES.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              buzz('tap');
              setTheme(t.id);
            }}
            style={{
              flex: 1,
              padding: '11px 8px',
              borderRadius: 'var(--radius-sm)',
              background: theme === t.id ? 'var(--accent-soft)' : 'var(--bg-elev)',
              border: `1px solid ${theme === t.id ? 'var(--accent)' : 'var(--border-soft)'}`,
              color: theme === t.id ? 'var(--accent)' : 'var(--text)',
              fontSize: 13,
              fontWeight: 550,
            }}
          >
            <span
              style={{
                display: 'block',
                width: 26,
                height: 26,
                borderRadius: 7,
                background: t.swatch,
                border: '1px solid var(--border)',
                margin: '0 auto 6px',
              }}
            />
            {t.label}
          </button>
        ))}
      </div>

      <label
        className="card"
        style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, cursor: 'pointer' }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 550, fontSize: 14.5 }}>Haptics</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            Vibrate on tool events, approvals and completion
          </div>
        </div>
        <input type="checkbox" checked={haptics} onChange={(e) => setHaptics(e.target.checked)} />
      </label>

      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', fontWeight: 650, marginBottom: 8 }}>
        BACKEND
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <Row label="Connection" value={connection} tone={connection === 'open' ? 'ok' : 'warn'} />
        <Row
          label="Hermes"
          value={health.data ? `${health.data.backend} ${health.data.version ?? ''}` : '…'}
          tone={health.data?.backend === 'up' ? 'ok' : 'error'}
        />
        <Row label="Upstream" value={health.data?.upstream ?? '…'} />
        <Row
          label="Secure context"
          value={typeof window !== 'undefined' && window.isSecureContext ? 'yes' : 'no (HTTP)'}
          tone={typeof window !== 'undefined' && window.isSecureContext ? 'ok' : 'warn'}
        />
      </div>

      {!(typeof window !== 'undefined' && window.isSecureContext) && (
        <div
          className="card"
          style={{ marginBottom: 16, borderColor: 'var(--warn)', fontSize: 13, color: 'var(--text-dim)' }}
        >
          Running over plain HTTP, so install-to-home-screen, offline caching,
          push notifications and <strong>voice input</strong> stay dormant — the
          browser withholds the microphone and its dictation service outside a
          secure context. Add TLS to switch them on — see the README for the
          one-line <code>tailscale serve</code> or mkcert setup.
        </div>
      )}

      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', fontWeight: 650, marginBottom: 8 }}>
        OPEN ON ANOTHER PHONE
      </div>
      <div className="card" style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ background: '#fff', padding: 12, borderRadius: 10, display: 'inline-block' }}>
          <QRCodeSVG value={url} size={148} />
        </div>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12.5,
            color: 'var(--text-dim)',
            marginTop: 9,
            overflowWrap: 'anywhere',
          }}
        >
          {url}
        </div>
      </div>

      {devPanel && <DevPanel />}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'error';
}) {
  const color =
    tone === 'ok'
      ? 'var(--ok)'
      : tone === 'warn'
        ? 'var(--warn)'
        : tone === 'error'
          ? 'var(--error)'
          : 'var(--text-dim)';
  return (
    <div style={{ display: 'flex', padding: '5px 0', fontSize: 13.5 }}>
      <span style={{ flex: 1, color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ color, fontFamily: 'var(--mono)', fontSize: 12.5 }}>{value}</span>
    </div>
  );
}
