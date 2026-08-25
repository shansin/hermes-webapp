/**
 * App settings: theme, haptics, onboarding QR, backend status, and the hidden
 * dev panel (triple-tap the heading) that shows raw JSON-RPC frames.
 *
 * Everything here is this app's own preference — nothing on this screen writes
 * Hermes' config. The default model used to live here and now sits on the
 * Models screen, which is what the name is meant to signal.
 */
import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useHealth } from '../../api/hub';
import { ACCENTS, useUi, type Accent, type Theme } from '../../store/ui';
import { Skeleton, Switch } from '../shared/misc';
import { hermes } from '../../ws/client';
import { buzz } from '../../lib/haptics';
import {
  disablePush,
  enablePush,
  isIosSafari,
  isStandalone,
  pushStatus,
  sendTestPush,
  type PushState,
} from '../../lib/push';

/**
 * Web push.
 *
 * Three things have to be true before a banner arrives — HTTPS, permission,
 * and a subscription the proxy knows about — and the section says which one is
 * missing rather than offering a toggle that silently does nothing. The iOS
 * case gets its own line because "install to the home screen first" is not
 * something anyone guesses.
 */
function NotificationsSection() {
  const toast = useUi((s) => s.toast);
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void pushStatus().then((s) => {
      if (live) setState(s.state);
    });
    return () => {
      live = false;
    };
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) {
        // Must stay inside the click: iOS refuses `requestPermission()` outside
        // a user gesture, and awaiting anything first can forfeit it.
        const result = await enablePush();
        setState(result.state);
        if (result.state === 'on') {
          buzz('done');
          toast('Notifications on for this device', 'success');
        } else if (result.state === 'denied') {
          toast('Notifications are blocked in your browser settings', 'warn');
        }
      } else {
        await disablePush();
        setState('off');
        toast('Notifications off for this device', 'info');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change notifications', 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * iOS exposes no Push API to a Safari *tab*, only to an installed app — so
   * 'unsupported' there means "not installed yet", which is worth saying. On
   * every other browser it means plain HTTP, and the secure-context card below
   * already explains that.
   */
  const needsInstall = isIosSafari() && !isStandalone();

  /**
   * A placeholder while the push status resolves, not nothing.
   *
   * `pushStatus()` reads the service worker registration and the current
   * subscription, which on a cold start is slow enough to see — and rendering
   * `null` meant the NOTIFICATIONS heading and its card appeared a beat after
   * everything else, shoving the BUILD section down the screen under a thumb
   * already reaching for it.
   */
  if (state === 'loading') {
    return (
      <>
        <div className="group-head">
          NOTIFICATIONS
        </div>
        <div className="card" style={{ marginBottom: 16 }}>
          <Skeleton h={38} mb={0} />
        </div>
      </>
    );
  }
  if (state === 'unsupported' && !needsInstall) return null;

  /**
   * Nothing to offer when the server has no push: `server-off` is a setting on
   * the host and `server-unsupported` is a proxy that needs restarting there.
   * Neither is actionable from the phone, and a switch that explains why it
   * cannot be used is worse than no switch — so the whole section goes.
   */
  if (state === 'server-off' || state === 'server-unsupported') return null;

  return (
    <>
      <div className="group-head">
        NOTIFICATIONS
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 550, fontSize: 'var(--type-title-sm)' }}>Push</div>
            <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)' }}>
              Banners when the agent replies, a background task finishes, or an
              approval is needed — with the app closed
            </div>
          </div>
          <Switch
            checked={state === 'on'}
            onChange={(next) => {
              // 'denied' is undoable only in browser settings; 'unsupported'
              // here is the iOS not-installed-yet case. Both explain
              // themselves below rather than acting.
              const dead: PushState[] = ['denied', 'unsupported'];
              if (busy || dead.includes(state)) return;
              void toggle(next);
            }}
            label="Push notifications"
          />
        </div>

        {needsInstall && (
          <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--warn)', marginTop: 10 }}>
            On iPhone and iPad, notifications only work once the app is added to
            the Home Screen — Safari tabs never get them. Share → Add to Home
            Screen, then open it from there.
          </div>
        )}

        {state === 'denied' && (
          <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--warn)', marginTop: 10 }}>
            Blocked. The browser won't ask again — allow notifications for this
            site in its own settings, then come back.
          </div>
        )}

        {state === 'on' && (
          <button
            onClick={async () => {
              buzz('tap');
              try {
                const delivered = await sendTestPush();
                toast(
                  delivered ? `Sent to ${delivered} device(s)` : 'No devices registered',
                  delivered ? 'success' : 'warn',
                );
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Test failed', 'error');
              }
            }}
            style={{
              marginTop: 12,
              background: 'var(--bg-elev)',
              border: '1px solid var(--border-soft)',
              borderRadius: 8,
              color: 'var(--text)',
              fontSize: 'var(--type-detail)',
              padding: '8px 12px',
            }}
          >
            Send a test notification
          </button>
        )}
      </div>
    </>
  );
}

// `system` leads: it is the option most people want once they know it exists,
// and its swatch is split down the middle to say so without a caption.
const THEMES: { id: Theme; label: string; swatch: string }[] = [
  { id: 'system', label: 'System', swatch: 'linear-gradient(135deg, #0b0b0f 0 50%, #f7f7fa 50% 100%)' },
  { id: 'dark', label: 'Dark', swatch: '#0b0b0f' },
  { id: 'amoled', label: 'AMOLED', swatch: '#000000' },
  { id: 'light', label: 'Light', swatch: '#f7f7fa' },
];

/**
 * Swatch colours for the accent buttons.
 *
 * A copy of the two hexes each accent carries in `global.css`, because the
 * swatch has to paint a colour the page is *not* currently using — CSS could
 * only hand back `var(--accent)`, which is the same for all six. Which of the
 * pair is shown follows the resolved theme, so the dot matches what tapping it
 * would actually do.
 */
const ACCENT_SWATCH: Record<Accent, { dark: string; light: string; label: string }> = {
  amber: { dark: '#ffbf00', light: '#b8860b', label: 'Amber' },
  blue: { dark: '#6cb2ff', light: '#1565c0', label: 'Blue' },
  violet: { dark: '#b79cff', light: '#6a41d1', label: 'Violet' },
  green: { dark: '#5ed68a', light: '#157a46', label: 'Green' },
  rose: { dark: '#ff8fa8', light: '#be2d55', label: 'Rose' },
  teal: { dark: '#4fd6d0', light: '#0f7a75', label: 'Teal' },
};

/**
 * The accent picker.
 *
 * Dots rather than the labelled tiles used for the theme: the colour *is* the
 * label here, and six tiles would push the backend section off a phone screen.
 * The name still appears underneath the selected one so the choice is
 * announceable and not colour-only.
 */
function AccentSection() {
  const accent = useUi((s) => s.accent);
  const setAccent = useUi((s) => s.setAccent);
  const resolvedTheme = useUi((s) => s.resolvedTheme);

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 6 }}>
        {ACCENTS.map((id) => {
          const swatch = ACCENT_SWATCH[id];
          const color = resolvedTheme === 'light' ? swatch.light : swatch.dark;
          const selected = accent === id;
          return (
            <button
              key={id}
              onClick={() => {
                buzz('tap');
                setAccent(id);
              }}
              aria-pressed={selected}
              aria-label={swatch.label}
              title={swatch.label}
              style={{
                // Painted at 30px but padded out to Material's 48dp target.
                width: 30,
                height: 30,
                padding: 0,
                margin: 9,
                borderRadius: '50%',
                background: color,
                border: 'none',
                position: 'relative',
                // A ring rather than a border, so the dot itself never shrinks
                // and the row stays visually even.
                boxShadow: selected ? `0 0 0 2px var(--bg), 0 0 0 4px ${color}` : 'none',
              }}
            >
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  inset: -9,
                }}
              />
            </button>
          );
        })}
      </div>
      <div
        style={{
          fontSize: 'var(--type-body-sm)',
          color: 'var(--text-faint)',
          margin: '0 2px 16px',
          minHeight: 16,
        }}
      >
        Accent — {ACCENT_SWATCH[accent].label}. Used for buttons, links and
        highlights across every theme.
      </div>
    </>
  );
}

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
        <div style={{ fontWeight: 600, fontSize: 'var(--type-body-md)', flex: 1 }}>Raw WS frames</div>
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
          fontSize: 'var(--type-micro)',
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
  const resolvedTheme = useUi((s) => s.resolvedTheme);
  const setTheme = useUi((s) => s.setTheme);
  const haptics = useUi((s) => s.haptics);
  const setHaptics = useUi((s) => s.setHaptics);
  const devPanel = useUi((s) => s.devPanel);
  const setDevPanel = useUi((s) => s.setDevPanel);
  const connection = useUi((s) => s.connection);

  const health = useHealth();

  /**
   * The bundle in this tab is older than the one on disk.
   *
   * Only ever reported when the server actually knows its own build: a dist
   * built before the stamp existed reports null, and "null !== ours" is not a
   * reason to tell someone their app is stale.
   */
  const serverBuild = health.data?.webBuild;
  const staleBundle = Boolean(serverBuild) && serverBuild !== __BUILD_ID__;

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

  // Prefer an address the server reports: `location.origin` is whatever *this*
  // device used to connect, so on localhost the QR encoded 127.0.0.1 — which
  // resolves to the scanning phone itself. A public URL (`tailscale serve`)
  // beats the LAN one: it is HTTPS, so the phone that scans it can install the
  // app rather than just bookmark it, and it works away from the house.
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const url = health.data?.publicUrl ?? health.data?.lanUrl ?? origin;
  const qrIsLoopback = /^https?:\/\/(localhost|127\.|\[::1\])/.test(url);

  return (
    <div style={{ padding: 12 }}>
      <div
        onClick={onHeadingTap}
        className="group-head"
      >
        APPEARANCE
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {THEMES.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              buzz('tap');
              setTheme(t.id);
            }}
            aria-pressed={theme === t.id}
            style={{
              // Two per row on a narrow phone, four across when there's room.
              flex: '1 1 calc(50% - 4px)',
              minWidth: 74,
              padding: '11px 8px',
              borderRadius: 'var(--radius-sm)',
              background: theme === t.id ? 'var(--accent-soft)' : 'var(--bg-elev)',
              border: `1px solid ${theme === t.id ? 'var(--accent)' : 'var(--border-soft)'}`,
              color: theme === t.id ? 'var(--accent)' : 'var(--text)',
              fontSize: 'var(--type-detail)',
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

      {/* Only shown for `system`, where the button label alone doesn't say what
          is actually on screen — the other three are self-evident. */}
      <div
        style={{
          fontSize: 'var(--type-body-sm)',
          color: 'var(--text-faint)',
          margin: '0 2px 16px',
          minHeight: 16,
        }}
      >
        {theme === 'system'
          ? `Following your device — currently ${resolvedTheme}. AMOLED stays a manual choice.`
          : ''}
      </div>

      <AccentSection />

      <div
        className="card"
        style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 550, fontSize: 'var(--type-title-sm)' }}>Haptics</div>
          <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)' }}>
            Vibrate on tool events, approvals and completion
          </div>
        </div>
        <Switch checked={haptics} onChange={setHaptics} label="Haptics" />
      </div>

      <NotificationsSection />

      <div className="group-head">
        BUILD
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <Row label="App" value={__BUILD_ID__} />
        <Row label="Server" value={health.data?.webBuild ?? '…'} />
        <Row label="Proxy up since" value={formatStarted(health.data?.serverStartedAt)} />
        {staleBundle && (
          <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--warn)', marginTop: 8 }}>
            The server has a newer build than this tab is running. Reload to pick
            it up — an installed app may need closing and reopening.
          </div>
        )}
      </div>

      <div className="group-head">
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
          style={{ marginBottom: 16, borderColor: 'var(--warn)', fontSize: 'var(--type-detail)', color: 'var(--text-dim)' }}
        >
          Running over plain HTTP, so install-to-home-screen, offline caching,
          push notifications and <strong>voice input</strong> stay dormant — the
          browser withholds the microphone and its dictation service outside a
          secure context.{' '}
          {health.data?.publicUrl ? (
            <>
              This machine already has an HTTPS front — open{' '}
              <a href={health.data.publicUrl} style={{ color: 'var(--accent)' }}>
                {health.data.publicUrl}
              </a>{' '}
              instead and everything above switches on.
            </>
          ) : (
            <>
              Add TLS to switch them on — see the README for the one-line{' '}
              <code>tailscale serve</code> or mkcert setup.
            </>
          )}
        </div>
      )}

      <div className="group-head">
        OPEN ON ANOTHER PHONE
      </div>
      <div className="card" style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ background: '#fff', padding: 12, borderRadius: 10, display: 'inline-block' }}>
          <QRCodeSVG value={url} size={148} />
        </div>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 'var(--type-body-sm)',
            color: 'var(--text-dim)',
            marginTop: 9,
            overflowWrap: 'anywhere',
          }}
        >
          {url}
        </div>
        {qrIsLoopback && (
          <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--warn)', marginTop: 8 }}>
            This is a loopback address — it will point the other phone at itself.
            The proxy could not detect a LAN address on this machine.
          </div>
        )}
      </div>

      {devPanel && <DevPanel />}
    </div>
  );
}

/**
 * "3h ago (16:41Z)" — the elapsed time is what someone actually wants when
 * asking whether a restart took, and the absolute value is what they need to
 * match against a log line.
 */
function formatStarted(iso?: string): string {
  if (!iso) return '…';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  const ago = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
  return `${ago} ago (${iso.slice(11, 16)}Z)`;
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
    <div style={{ display: 'flex', padding: '5px 0', fontSize: 'var(--type-detail)' }}>
      <span style={{ flex: 1, color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ color, fontFamily: 'var(--mono)', fontSize: 'var(--type-body-sm)' }}>{value}</span>
    </div>
  );
}
