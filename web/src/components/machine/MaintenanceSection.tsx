/**
 * Housekeeping: the curator, doctor, the security audit, backup, checkpoint
 * pruning and empty sessions.
 *
 * Mirrors the desktop's maintenance panel
 * (`apps/desktop/src/app/command-center/maintenance.tsx`): the spawned
 * commands run one at a time, the last one's log is tailed in place, and
 * nothing is started without the profile it acts on. Two departures, both for
 * a phone:
 *
 * - **Every destructive action asks first** — a curator run (it archives and
 *   rewrites agent-made skills), a checkpoint prune and the empty-session
 *   delete. The desktop confirms only some of these; a thumb brushing a row is
 *   likelier than a mouse misclick, and none of the three can be undone.
 * - **A backup can be downloaded** once it finishes, through the same
 *   same-origin `<a>` the kanban attachments use: the proxy adds the token and
 *   Access is satisfied by the cookie, so the archive never passes through the
 *   page.
 *
 * The profile picker scopes the whole section. `null` follows the active
 * profile, but what is *sent* is always a name — `destructive_profile` refuses
 * an unnamed curator run, prune or delete as soon as the backend serves more
 * than one profile.
 */
import { useEffect, useRef, useState } from 'react';
import { useActiveProfile } from '../../api/profiles';
import {
  OPS,
  backupDownloadUrl,
  useActionTail,
  useCheckpointUsage,
  useCurator,
  useDeleteEmptySessions,
  useEmptySessionCount,
  useSetCuratorPaused,
  type OpId,
} from '../../api/machine';
import { actionOutcome, formatBytes } from '../../lib/machine';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';
import { ProfileFilter } from '../shared/ProfileSelect';
import { relTime } from '../shared/misc';
import { ConfirmSheet, Hint, smallBtn } from './parts';

/** What each one does, in the desktop's words where it had some. */
const DESCRIPTIONS: Record<OpId, string> = {
  doctor: 'Health-check the install, config and providers.',
  audit: 'Scan config and skills for risky settings.',
  backup: 'Zip config, memories, skills and sessions into the profile’s backups folder.',
  prune: 'Drop /rollback snapshots untouched for a week and trim the store to 500 MB.',
  curator: 'Review agent-made skills now.',
};

type Confirming = 'curator' | 'prune' | 'empty' | null;

function OpRow({
  title,
  description,
  children,
}: {
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid var(--border-soft)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--type-detail)', fontWeight: 550 }}>{title}</div>
        <Hint>{description}</Hint>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>{children}</div>
    </div>
  );
}

export function MaintenanceSection() {
  const toast = useUi((s) => s.toast);
  const active = useActiveProfile().data?.active ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  /* The name that travels — see the header. Null only before the active
     profile is known, which disables the buttons rather than guessing. */
  const profile = picked ?? active;

  const curator = useCurator(profile);
  const setPaused = useSetCuratorPaused();
  const checkpoints = useCheckpointUsage(profile);
  const empty = useEmptySessionCount(profile);
  const deleteEmpty = useDeleteEmptySessions();
  const { tail, status, start, running, clear } = useActionTail();
  const [confirming, setConfirming] = useState<Confirming>(null);

  const launch = async (op: OpId) => {
    buzz('tap');
    try {
      await start.mutateAsync({ op, profile });
    } catch (err) {
      toast(err instanceof Error ? err.message : `${OPS[op].label} failed to start`, 'error');
    }
  };

  const removeEmpty = async () => {
    try {
      const res = await deleteEmpty.mutateAsync(profile);
      toast(`Deleted ${res.deleted ?? 0} empty session${res.deleted === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  };

  const togglePause = async () => {
    if (!curator.data) return;
    buzz('tap');
    try {
      await setPaused.mutateAsync({ profile, paused: !curator.data.paused });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change the curator', 'error');
    }
  };

  // Keep the newest log line in view while it streams.
  const pre = useRef<HTMLPreElement>(null);
  const lines = status.data?.lines ?? [];
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [lines.length]);

  const outcome = actionOutcome(status.data);
  const disabled = running || !profile;
  const c = curator.data;
  const cpBytes = checkpoints.data?.total_bytes ?? 0;
  const cpCount = checkpoints.data?.sessions?.length ?? 0;
  const emptyCount = empty.data?.count ?? 0;
  const lastRun = c?.last_run_at ? Date.parse(c.last_run_at) / 1000 : null;

  return (
    <>
      <div className="group-head">MAINTENANCE</div>
      <div style={{ marginBottom: 8 }}>
        <ProfileFilter value={picked} onChange={setPicked} />
      </div>
      <div className="card" style={{ marginBottom: 16, paddingTop: 4 }}>
        <OpRow
          title="Curator"
          description={
            c
              ? `${c.enabled === false ? 'Disabled' : c.paused ? 'Paused' : 'Active'}${
                  c.interval_hours ? ` · every ${c.interval_hours}h` : ''
                } · ${lastRun ? `last ran ${relTime(lastRun)} ago` : 'never ran'}. Archives stale agent-made skills.`
              : curator.isError
                ? 'Curator status unavailable.'
                : 'Background review of agent-made skills.'
          }
        >
          {c && c.enabled !== false && (
            <button className="btn" style={smallBtn} disabled={setPaused.isPending || !profile} onClick={() => void togglePause()}>
              {c.paused ? 'Resume' : 'Pause'}
            </button>
          )}
          <button className="btn" style={smallBtn} disabled={disabled} onClick={() => setConfirming('curator')}>
            Run now
          </button>
        </OpRow>

        <OpRow title="Doctor" description={DESCRIPTIONS.doctor}>
          <button className="btn" style={smallBtn} disabled={disabled} onClick={() => void launch('doctor')}>
            Run
          </button>
        </OpRow>
        <OpRow title="Security audit" description={DESCRIPTIONS.audit}>
          <button className="btn" style={smallBtn} disabled={disabled} onClick={() => void launch('audit')}>
            Run
          </button>
        </OpRow>
        <OpRow title="Backup" description={DESCRIPTIONS.backup}>
          <button className="btn" style={smallBtn} disabled={disabled} onClick={() => void launch('backup')}>
            Back up
          </button>
        </OpRow>
        <OpRow
          title="Checkpoints"
          description={
            checkpoints.data
              ? cpCount
                ? `${formatBytes(cpBytes)} across ${cpCount} session${cpCount === 1 ? '' : 's'}. ${DESCRIPTIONS.prune}`
                : 'No /rollback snapshots stored.'
              : DESCRIPTIONS.prune
          }
        >
          <button
            className="btn"
            style={smallBtn}
            disabled={disabled || (checkpoints.data != null && cpCount === 0)}
            onClick={() => setConfirming('prune')}
          >
            Prune
          </button>
        </OpRow>
        <OpRow
          title="Empty sessions"
          description={
            empty.data
              ? emptyCount
                ? `${emptyCount} ended session${emptyCount === 1 ? '' : 's'} with no messages.`
                : 'None to clean up.'
              : 'Ended sessions that never got a message.'
          }
        >
          <button
            className="btn"
            style={smallBtn}
            disabled={!profile || deleteEmpty.isPending || emptyCount === 0}
            onClick={() => setConfirming('empty')}
          >
            Clean up
          </button>
        </OpRow>

        {tail && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ flex: 1, fontSize: 'var(--type-body-sm)', fontWeight: 550 }}>
                {OPS[tail.op].label}
                {tail.profile ? ` · ${tail.profile}` : ''}
                <span
                  style={{
                    fontWeight: 400,
                    marginLeft: 6,
                    color:
                      outcome.state === 'failed'
                        ? 'var(--error)'
                        : outcome.state === 'ok'
                          ? 'var(--ok)'
                          : 'var(--text-faint)',
                  }}
                >
                  {status.isError ? 'Could not read its log' : outcome.label}
                </span>
              </div>
              {!running && (
                <button className="btn btn--sm" onClick={clear}>
                  Dismiss
                </button>
              )}
            </div>
            {tail.op === 'backup' && tail.archive && outcome.state === 'ok' && (
              <a
                className="btn btn--sm"
                href={backupDownloadUrl(tail.archive, tail.profile)}
                download
                style={{ marginBottom: 8, display: 'inline-flex' }}
              >
                Download backup
              </a>
            )}
            {lines.length > 0 && (
              <pre
                ref={pre}
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 'var(--type-label-sm)',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  margin: 0,
                  maxHeight: 260,
                  overflowY: 'auto',
                  lineHeight: 1.45,
                  color: 'var(--text-dim)',
                  background: 'var(--bg-elev)',
                  borderRadius: 8,
                  padding: 9,
                }}
              >
                {lines.join('\n')}
              </pre>
            )}
          </div>
        )}
      </div>

      <ConfirmSheet
        open={confirming === 'curator'}
        title="Run the curator now?"
        confirmLabel="Run curator"
        onConfirm={() => void launch('curator')}
        onClose={() => setConfirming(null)}
      >
        It reviews the skills the agent wrote{profile ? ` in ${profile}` : ''}, archiving stale ones and
        rewriting others. Archived skills stop loading until restored.
      </ConfirmSheet>

      <ConfirmSheet
        open={confirming === 'prune'}
        title="Prune checkpoints?"
        confirmLabel="Prune"
        onConfirm={() => void launch('prune')}
        onClose={() => setConfirming(null)}
      >
        Runs <code>hermes checkpoints prune</code>{profile ? ` for ${profile}` : ''}: snapshots of projects
        untouched for seven days go, and the oldest are dropped until the store is under 500 MB
        {cpBytes ? ` (${formatBytes(cpBytes)} now)` : ''}. A pruned snapshot can no longer be restored.
        If any snapshots belong to folders that no longer exist, the command stops to ask about them
        — a question only the command line can answer — and its log ends in “Aborted.”
      </ConfirmSheet>

      <ConfirmSheet
        open={confirming === 'empty'}
        title={`Delete ${emptyCount} empty session${emptyCount === 1 ? '' : 's'}?`}
        confirmLabel="Delete"
        onConfirm={() => void removeEmpty()}
        onClose={() => setConfirming(null)}
      >
        Removes ended sessions{profile ? ` in ${profile}` : ''} that have no messages at all. Running and
        archived sessions are left alone. This cannot be undone.
      </ConfirmSheet>
    </>
  );
}
