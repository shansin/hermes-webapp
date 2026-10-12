/**
 * The few things worth doing to Hermes itself from a phone.
 *
 * Until this existed every one of them needed a terminal: reading a log to see
 * why a cron job failed, finding out whether an update is waiting, kicking a
 * messaging gateway that stopped answering on Discord. All three are backend
 * routes the desktop dashboard already uses.
 *
 * What is deliberately absent is a "restart Hermes" button, and the reason is
 * not obvious from the route's name. `POST /api/gateway/restart` runs
 * `hermes gateway restart`: it restarts the **messaging gateway** — the
 * process that also ticks cron — not the `hermes serve` backend this app talks
 * to. A button for the latter would have to be answered by the very process it
 * is meant to revive, so it could only ever work when it was not needed. That
 * backend is supervised by the proxy's systemd unit instead.
 *
 * Applying an update is absent too. It rewrites the checkout under a running
 * backend and wants a restart of both halves afterwards; that is a decision
 * for the machine, so the check says what to run rather than running it.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Sheet } from '../shared/Sheet';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

interface UpdateCheck {
  install_method?: string;
  current_version?: string;
  /** Commits behind; 0 up to date, -1 unknown, null when the check could not run. */
  behind?: number | null;
  update_available?: boolean;
  update_command?: string;
  message?: string | null;
}

const LOG_FILES = [
  { id: 'errors', label: 'Errors' },
  { id: 'agent', label: 'Agent' },
  { id: 'gateway', label: 'Gateway' },
] as const;
type LogFile = (typeof LOG_FILES)[number]['id'];

const smallBtn = { fontSize: 'var(--type-detail)', padding: '7px 11px' } as const;

function updateSummary(u: UpdateCheck): string {
  if (u.message) return u.message;
  if (u.behind == null) return 'Could not check for updates.';
  if (!u.update_available || u.behind === 0) return `Up to date (${u.current_version ?? 'unknown version'}).`;
  const count = u.behind > 0 ? `${u.behind.toLocaleString()} commit${u.behind === 1 ? '' : 's'} behind` : 'An update is available';
  return `${count}. Run \`${u.update_command || 'hermes update'}\` on the machine, then restart.`;
}

function LogsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [file, setFile] = useState<LogFile>('errors');
  const logs = useQuery({
    queryKey: ['hermes-logs', file],
    queryFn: () => api.get<{ lines?: string[] }>(`/api/logs?file=${file}&lines=200`),
    enabled: open,
    staleTime: 5_000,
  });
  // Newest first: on a phone the last line is the one you came for, and the
  // bottom of a 200-line pre is a long way down.
  const lines = [...(logs.data?.lines ?? [])].reverse();

  return (
    <Sheet open={open} onClose={onClose} title="Hermes logs">
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {LOG_FILES.map((f) => (
          <button
            key={f.id}
            className={`btn${file === f.id ? ' btn--primary' : ''}`}
            style={smallBtn}
            onClick={() => setFile(f.id)}
          >
            {f.label}
          </button>
        ))}
        <button className="btn" style={smallBtn} onClick={() => void logs.refetch()}>
          Refresh
        </button>
      </div>
      {logs.isLoading && <div style={{ color: 'var(--text-faint)' }}>Loading…</div>}
      {logs.isError && (
        <div style={{ color: 'var(--error)' }}>
          {logs.error instanceof Error ? logs.error.message : 'Could not read the log.'}
        </div>
      )}
      {logs.data && lines.length === 0 && <div style={{ color: 'var(--text-faint)' }}>Empty.</div>}
      {lines.length > 0 && (
        <pre
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 'var(--type-label-sm)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            margin: 0,
            lineHeight: 1.45,
            color: 'var(--text-dim)',
          }}
        >
          {lines.join('\n')}
        </pre>
      )}
    </Sheet>
  );
}

export function BackendControls() {
  const toast = useUi((s) => s.toast);
  const [logsOpen, setLogsOpen] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [update, setUpdate] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    buzz('tap');
    setChecking(true);
    try {
      setUpdate(updateSummary(await api.get<UpdateCheck>('/api/hermes/update/check')));
    } catch (err) {
      setUpdate(err instanceof Error ? err.message : 'Could not check for updates.');
    } finally {
      setChecking(false);
    }
  };

  const restart = async () => {
    setConfirmRestart(false);
    try {
      await api.post('/api/gateway/restart', {});
      toast('Messaging gateway restarting', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Restart failed', 'error');
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" style={smallBtn} onClick={() => setLogsOpen(true)}>
          View logs
        </button>
        <button className="btn" style={smallBtn} disabled={checking} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check for update'}
        </button>
        <button className="btn" style={smallBtn} onClick={() => setConfirmRestart(true)}>
          Restart messaging gateway
        </button>
      </div>
      {update && (
        <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-dim)', marginTop: 10, overflowWrap: 'anywhere' }}>
          {update}
        </div>
      )}

      <LogsSheet open={logsOpen} onClose={() => setLogsOpen(false)} />

      <Sheet open={confirmRestart} onClose={() => setConfirmRestart(false)} title="Restart messaging gateway?">
        <p style={{ marginTop: 0, color: 'var(--text-dim)', fontSize: 'var(--type-body-md)', lineHeight: 1.5 }}>
          Restarts the process that serves Discord, Telegram and the other chat platforms and runs
          scheduled jobs. A turn it is running there is interrupted. This app's own conversations are
          served separately and are not affected.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--danger" onClick={() => void restart()}>
            Restart
          </button>
          <button className="btn" onClick={() => setConfirmRestart(false)}>
            Cancel
          </button>
        </div>
      </Sheet>
    </div>
  );
}
