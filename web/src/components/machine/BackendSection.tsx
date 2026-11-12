/**
 * The Hermes backend behind the proxy: is it up, which version, is it running
 * the code on disk — plus the log tail and the update check.
 *
 * Read off `/healthz`, the proxy's own probe, rather than off Hermes: it is the
 * one read that can say `unauthorized` (Hermes up, holding a token this proxy
 * does not have — every screen fails while `/api/health` looks fine) and
 * `restartNeeded` (updated on disk, still serving the old commit). See "The
 * session token" in CLAUDE.md.
 *
 * Moved here from Settings, which keeps only a one-line status and a link:
 * Settings is this app's preferences, and these are the machine's.
 */
import { useHealth } from '../../api/hub';
import { BackendControls } from '../hub/BackendControls';
import { Hint, Row } from './parts';

export function BackendSection() {
  const health = useHealth();
  const h = health.data;
  const state = h?.backend;

  return (
    <>
      <div className="group-head">BACKEND</div>
      <div className="card" style={{ marginBottom: 10 }}>
        <Row
          label="Hermes"
          value={h ? `${state}${h.version ? ` ${h.version}` : ''}` : health.isError ? 'proxy unreachable' : '…'}
          tone={state === 'up' ? 'ok' : h || health.isError ? 'error' : undefined}
        />
        <Row label="Upstream" value={h?.upstream ?? '…'} />
        {h?.restartNeeded && <Row label="Restart needed" value="updated on disk" tone="warn" />}
        {state === 'unauthorized' && (
          <Hint tone="error">
            Hermes is running with a session token this proxy does not hold, so every request is
            refused. Set HERMES_TOKEN in the proxy's .env to the backend's token, or restart both
            with start.sh.
          </Hint>
        )}
        {h?.restartNeeded && (
          <Hint tone="warn">
            Hermes was updated on disk and is still serving the old code. Restart hermes-backend on
            the machine to pick it up — this app cannot restart the process it is talking through.
          </Hint>
        )}
      </div>
      <BackendControls />
    </>
  );
}
