/**
 * Scheduled jobs: pause/resume/trigger, inspect runs, create new ones.
 */
import { useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { Empty, ErrorNote, SkeletonList, relTime } from '../shared/misc';
import { IconPlay, IconPause, IconPlus, IconTrash } from '../shared/Icons';
import {
  useCreateCronJob,
  useCronAction,
  useCronJobs,
  useCronRuns,
  useDeleteCronJob,
  type CronJob,
} from '../../api/hub';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

function jobName(j: CronJob): string {
  return j.name ?? j.id;
}

function isPaused(j: CronJob): boolean {
  // Different Hermes versions express this as `paused` or `enabled`.
  if (typeof j.paused === 'boolean') return j.paused;
  if (typeof j.enabled === 'boolean') return !j.enabled;
  return false;
}

export function CronTab() {
  const { data, isLoading, error } = useCronJobs();
  const action = useCronAction();
  const del = useDeleteCronJob();
  const create = useCreateCronJob();
  const toast = useUi((s) => s.toast);

  const [openRuns, setOpenRuns] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', prompt: '', schedule: '0 9 * * *' });

  const runs = useCronRuns(openRuns);

  const run = async (id: string, act: 'pause' | 'resume' | 'trigger') => {
    buzz('tap');
    try {
      await action.mutateAsync({ id, action: act });
      toast(act === 'trigger' ? 'Job triggered' : `Job ${act}d`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : `Could not ${act}`, 'error');
    }
  };

  const submit = async () => {
    if (!form.name.trim() || !form.prompt.trim()) return;
    try {
      await create.mutateAsync({
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        schedule: form.schedule.trim(),
      });
      toast('Job created', 'success');
      setForm({ name: '', prompt: '', schedule: '0 9 * * *' });
      setCreating(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Create failed', 'error');
    }
  };

  const runList = Array.isArray(runs.data) ? runs.data : (runs.data?.runs ?? []);

  return (
    <div style={{ padding: 12 }}>
      <button className="btn btn--sm" style={{ width: '100%', marginBottom: 12 }} onClick={() => setCreating(true)}>
        <IconPlus size={16} /> New scheduled job
      </button>

      {isLoading ? (
        <SkeletonList n={3} h={70} />
      ) : error ? (
        <ErrorNote error={error} />
      ) : !data || data.length === 0 ? (
        <Empty icon="⏰" title="No scheduled jobs" hint="Recurring agent runs will appear here." />
      ) : (
        data.map((j) => {
          const paused = isPaused(j);
          return (
            <div className="card" key={j.id} style={{ marginBottom: 9 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14.5 }}>{jobName(j)}</div>
                  {j.schedule && (
                    <div style={{ fontSize: 12, color: 'var(--text-faint)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                      {j.schedule}
                    </div>
                  )}
                  {j.prompt && (
                    <div
                      style={{
                        fontSize: 12.5,
                        color: 'var(--text-dim)',
                        marginTop: 5,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {j.prompt}
                    </div>
                  )}
                  <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6, display: 'flex', gap: 10 }}>
                    {paused ? (
                      <span style={{ color: 'var(--warn)' }}>paused</span>
                    ) : (
                      <span style={{ color: 'var(--ok)' }}>active</span>
                    )}
                    {j.last_run ? <span>last {relTime(j.last_run)}</span> : null}
                  </div>
                </div>

                <button
                  className="icon-btn"
                  onClick={() => void run(j.id, paused ? 'resume' : 'pause')}
                  aria-label={paused ? 'Resume' : 'Pause'}
                >
                  {paused ? <IconPlay size={17} /> : <IconPause size={17} />}
                </button>
              </div>

              <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
                <button className="btn btn--sm" onClick={() => void run(j.id, 'trigger')}>
                  Run now
                </button>
                <button className="btn btn--sm" onClick={() => setOpenRuns(j.id)}>
                  History
                </button>
                <button
                  className="btn btn--sm btn--ghost"
                  style={{ marginLeft: 'auto', color: 'var(--error)' }}
                  onClick={async () => {
                    try {
                      await del.mutateAsync(j.id);
                      toast('Job deleted', 'success');
                    } catch (e) {
                      toast(e instanceof Error ? e.message : 'Delete failed', 'error');
                    }
                  }}
                  aria-label="Delete job"
                >
                  <IconTrash size={15} />
                </button>
              </div>
            </div>
          );
        })
      )}

      <Sheet open={Boolean(openRuns)} onClose={() => setOpenRuns(null)} title="Run history">
        {runs.isLoading && <div style={{ color: 'var(--text-faint)' }}>Loading…</div>}
        {runList.length === 0 && !runs.isLoading && (
          <div style={{ color: 'var(--text-faint)' }}>No runs recorded yet.</div>
        )}
        {runList.map((r, i) => {
          const row = r as Record<string, unknown>;
          return (
            <div key={i} style={{ padding: '9px 0', borderBottom: '1px solid var(--border-soft)' }}>
              <div style={{ fontSize: 13.5 }}>
                {String(row.status ?? row.outcome ?? 'run')}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                {relTime(Number(row.started_at ?? row.created_at ?? 0))}
              </div>
              {typeof row.error === 'string' && row.error && (
                <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 3 }}>{row.error}</div>
              )}
            </div>
          );
        })}
      </Sheet>

      <Sheet open={creating} onClose={() => setCreating(false)} title="New scheduled job">
        <input
          className="field"
          placeholder="Job name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          style={{ marginBottom: 9 }}
        />
        <input
          className="field"
          placeholder="Cron schedule (e.g. 0 9 * * *)"
          value={form.schedule}
          onChange={(e) => setForm({ ...form, schedule: e.target.value })}
          style={{ marginBottom: 9, fontFamily: 'var(--mono)' }}
        />
        <textarea
          className="field"
          placeholder="What should the agent do?"
          rows={4}
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          style={{ resize: 'vertical', marginBottom: 12 }}
        />
        <button
          className="btn btn--primary"
          style={{ width: '100%' }}
          onClick={submit}
          disabled={!form.name.trim() || !form.prompt.trim() || create.isPending}
        >
          {create.isPending ? 'Creating…' : 'Create job'}
        </button>
      </Sheet>
    </div>
  );
}
