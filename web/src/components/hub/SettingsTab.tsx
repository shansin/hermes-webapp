/**
 * Settings: theme, haptics, the default model, onboarding QR, backend status,
 * and the hidden dev panel (triple-tap the heading) that shows raw JSON-RPC
 * frames.
 */
import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useDefaultModel, useHealth, useSetDefaultModel } from '../../api/hub';
import { useUi, type Theme } from '../../store/ui';
import { Switch } from '../shared/misc';
import { Sheet } from '../shared/Sheet';
import { ModelPicker } from '../shared/ModelPicker';
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
   * already explains that; a second dead toggle would only be noise.
   */
  const needsInstall = isIosSafari() && !isStandalone();

  if (state === 'loading') return null;
  if (state === 'unsupported' && !needsInstall) return null;

  return (
    <>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', fontWeight: 650, marginBottom: 8 }}>
        NOTIFICATIONS
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 550, fontSize: 'var(--type-title-sm)' }}>Push</div>
            <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)' }}>
              Banners when a background task finishes, a scheduled job runs, or the
              agent needs an approval — even with the app closed
            </div>
          </div>
          <Switch
            checked={state === 'on'}
            onChange={(next) => {
              const dead: PushState[] = ['denied', 'server-off', 'server-unsupported', 'unsupported'];
              if (busy || dead.includes(state)) return;
              void toggle(next);
            }}
            label="Push notifications"
          />
        </div>

        {needsInstall && (
          <div style={{ fontSize: 12.5, color: 'var(--warn)', marginTop: 10 }}>
            On iPhone and iPad, notifications only work once the app is added to
            the Home Screen — Safari tabs never get them. Share → Add to Home
            Screen, then open it from there.
          </div>
        )}

        {state === 'denied' && (
          <div style={{ fontSize: 12.5, color: 'var(--warn)', marginTop: 10 }}>
            Blocked. The browser won't ask again — allow notifications for this
            site in its own settings, then come back.
          </div>
        )}

        {state === 'server-off' && (
          <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginTop: 10 }}>
            The proxy has push switched off (<code>PUSH_ENABLED=0</code>).
          </div>
        )}

        {state === 'server-unsupported' && (
          <div style={{ fontSize: 12.5, color: 'var(--warn)', marginTop: 10 }}>
            This proxy is running a build without push. Restart it on the host —{' '}
            <code>bash start.sh</code> — and reload.
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
              fontSize: 13,
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

/**
 * The model new chats start with.
 *
 * Deliberately separate from the model sheet in chat: that one hot-swaps the
 * running session and leaves this untouched, this one writes Hermes' own config
 * and leaves running sessions untouched. Saying so on the card is the only way
 * a user can tell the two apart from the phone.
 */
function DefaultModelSection() {
  const { data, isLoading } = useDefaultModel();
  const setDefault = useSetDefaultModel();
  const toast = useUi((s) => s.toast);

  const [open, setOpen] = useState(false);
  // Set when Hermes wants a second look at an expensive model. Holds the pick
  // so confirming can resend it without making the user find it again.
  const [confirm, setConfirm] = useState<{ model: string; provider: string; message: string } | null>(
    null,
  );

  const main = data?.main;
  const busy = setDefault.isPending;

  const apply = async (model: string, provider: string, confirmExpensive = false) => {
    try {
      const res = await setDefault.mutateAsync({ model, provider, confirmExpensive });
      if (res.confirm_required) {
        setConfirm({ model, provider, message: res.confirm_message || 'This model is expensive.' });
        return;
      }
      buzz('done');
      toast(`New chats will use ${model}`, 'success');
      setConfirm(null);
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not set the default model', 'error');
    }
  };

  return (
    <>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', fontWeight: 650, marginBottom: 8 }}>
        DEFAULT MODEL
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <button
          onClick={() => {
            buzz('tap');
            setOpen(true);
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            background: 'none',
            border: 'none',
            padding: 0,
            textAlign: 'left',
            color: 'var(--text)',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 13.5,
                overflowWrap: 'anywhere',
              }}
            >
              {isLoading ? '…' : main?.model || 'Not set'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>
              {main?.provider ? `via ${main.provider}` : 'Hermes picks one automatically'}
            </div>
          </div>
          <span style={{ fontSize: 13, color: 'var(--accent)' }}>Change</span>
        </button>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 9, lineHeight: 1.45 }}>
          Used by new chats, everywhere Hermes runs — including the terminal.
          The chat you have open keeps its own model; change that from the model
          button in the composer.
        </div>
      </div>

      <Sheet open={open} onClose={() => setOpen(false)} title="Default model">
        {confirm ? (
          <div>
            <div style={{ fontSize: 13.5, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 14 }}>
              {confirm.message}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" style={{ flex: 1 }} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn--primary"
                style={{ flex: 1 }}
                disabled={busy}
                onClick={() => void apply(confirm.model, confirm.provider, true)}
              >
                Use it anyway
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginBottom: 12, lineHeight: 1.45 }}>
              Saved to Hermes' config and used by every new chat. Running chats
              are unaffected.
            </div>
            <ModelPicker
              selected={main?.model}
              onPick={(m, p) => void apply(m, p)}
              busy={busy}
            />
          </>
        )}
      </Sheet>
    </>
  );
}

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

      <DefaultModelSection />

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
