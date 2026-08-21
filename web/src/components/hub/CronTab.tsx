/**
 * Scheduled jobs: pause/resume/trigger, inspect runs, create new ones.
 */
import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Sheet } from '../shared/Sheet';
import { ModelPicker } from '../shared/ModelPicker';
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
import { UNDO_WINDOW_MS, scheduleUndoable } from '../../lib/undo';

function jobName(j: CronJob): string {
  return j.name ?? j.id;
}

/**
 * The schedule as one line of text.
 *
 * Current Hermes sends `schedule` as an object and a pre-rendered
 * `schedule_display` beside it; older builds sent a bare cron string. Putting
 * the object into JSX is what blanked this tab, so nothing renders `schedule`
 * directly any more.
 */
function scheduleText(j: CronJob): string {
  if (j.schedule_display) return j.schedule_display;
  const s = j.schedule;
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object') return s.display ?? s.kind ?? '';
  return '';
}

/**
 * Epoch seconds from whatever the backend used for a timestamp: an ISO string
 * now, a number on older builds. `relTime` counts in seconds, so a
 * millisecond value has to be scaled or every job reads as decades away.
 */
function epochSeconds(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? v / 1000 : v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms / 1000;
  }
  return null;
}

function isPaused(j: CronJob): boolean {
  // Different Hermes versions express this as `paused` or `enabled`.
  if (typeof j.paused === 'boolean') return j.paused;
  if (j.paused_at) return true;
  // A one-shot that has already run reports `enabled: false` because it is
  // finished, not because anyone paused it — so check that before falling
  // back to `enabled` and mislabelling every completed job as "paused".
  if (j.state === 'completed') return false;
  if (typeof j.enabled === 'boolean') return !j.enabled;
  return false;
}

/**
 * A job with no `model`/`provider` of its own runs on whatever the global
 * default happens to be *at fire time*. Hermes notices that drift and, unless
 * `cron.model_drift_guard` is off, refuses to run the job at all rather than
 * silently spending on a model the job was never tested against. Pinning here
 * is what takes a job out of that class.
 */
const BLANK_FORM = {
  name: '',
  prompt: '',
  schedule: '0 9 * * *',
  model: '' as string,
  provider: '' as string,
};

export function CronTab() {
  const { data, isLoading, error } = useCronJobs();
  const action = useCronAction();
  const del = useDeleteCronJob();
  const qc = useQueryClient();
  const create = useCreateCronJob();
  const toast = useUi((s) => s.toast);

  /**
   * Which job's run history is open lives in the URL, not in local state, so
   * `/cron?job=<id>` opens straight onto it — that is where a cron push
   * notification points when it has no session to link to.
   *
   * It has to be the URL rather than an initial `useState` value: a push tap
   * is handled by `useEventToasts`, which routes in place with `navigate()`.
   * Arriving at `/cron?job=b` while already sitting on `/cron?job=a` changes
   * the search params without remounting this component, and a seeded
   * `useState` would ignore the second one.
   *
   * `replace` keeps opening and closing the sheet from stacking history
   * entries behind the back button in `HubPage`.
   */
  const [search, setSearch] = useSearchParams();

  /**
   * Delete a job, with a window to take it back.
   *
   * A single tap on a trash icon used to destroy a schedule outright — no
   * confirmation, nothing to undo, and a cron job is a thing someone wrote
   * once and has not thought about since. Same bargain as the session list:
   * the row goes now, the request waits, and Undo means it never happened.
   */
  const removeJob = useCallback(
    (job: CronJob) => {
      const snapshot = qc.getQueriesData({ queryKey: ['cron'] });
      qc.setQueriesData<CronJob[] | { jobs: CronJob[] }>({ queryKey: ['cron'] }, (old) => {
        if (Array.isArray(old)) return old.filter((j) => j.id !== job.id);
        if (old?.jobs) return { ...old, jobs: old.jobs.filter((j) => j.id !== job.id) };
        return old;
      });

      const restore = () => {
        for (const [key, data] of snapshot) qc.setQueryData(key, data);
      };

      const { undo } = scheduleUndoable(
        {
          commit: () => {
            void del.mutateAsync(job.id).catch((e: unknown) => {
              restore();
              toast(e instanceof Error ? e.message : 'Delete failed', 'error');
            });
          },
          revert: restore,
        },
        UNDO_WINDOW_MS,
      );

      toast(`Deleted ${job.name ?? 'job'}`, 'success', {
        durationMs: UNDO_WINDOW_MS,
        action: {
          label: 'Undo',
          onAction: () => {
            buzz('tap');
            undo();
          },
        },
      });
    },
    [del, qc, toast],
  );
  const openRuns = search.get('job');
  const setOpenRuns = useCallback(
    (id: string | null) => {
      setSearch(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set('job', id);
          else next.delete('job');
          return next;
        },
        { replace: true },
      );
    },
    [setSearch],
  );

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(BLANK_FORM);
  const [pickingModel, setPickingModel] = useState(false);

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
        // Only sent when the user actually chose one: omitting the keys
        // leaves the job unpinned, which is the "follow the global default"
        // behaviour and what every job created before this existed does.
        ...(form.model && form.provider
          ? { model: form.model, provider: form.provider }
          : {}),
      });
      toast('Job created', 'success');
      setForm(BLANK_FORM);
      setPickingModel(false);
      setCreating(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Create failed', 'error');
    }
  };

  const runList = Array.isArray(runs.data) ? runs.data : (runs.data?.runs ?? []);
  const openJob = openRuns ? data?.find((j) => j.id === openRuns) : undefined;
  const lastAttempt = epochSeconds(openJob?.last_run_at);

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
          const schedule = scheduleText(j);
          const lastRun = epochSeconds(j.last_run_at);
          const done = j.state === 'completed';
          // A drift-guard refusal leaves a one-shot at `state: completed,
          // enabled: false` — indistinguishable from a clean finish by
          // lifecycle alone, so the job that most needs attention was the one
          // rendering as a calm grey "completed". `last_status` is the only
          // field that knows, so it outranks the lifecycle label.
          const failed = j.last_status === 'error';
          return (
            <div className="card" key={j.id} style={{ marginBottom: 9 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14.5 }}>{jobName(j)}</div>
                  {schedule && (
                    <div style={{ fontSize: 12, color: 'var(--text-faint)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                      {schedule}
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
                    {failed ? (
                      <span style={{ color: 'var(--error)' }}>failed</span>
                    ) : paused ? (
                      <span style={{ color: 'var(--warn)' }}>paused</span>
                    ) : done ? (
                      <span style={{ color: 'var(--text-faint)' }}>completed</span>
                    ) : (
                      <span style={{ color: 'var(--ok)' }}>active</span>
                    )}
                    {lastRun ? <span>last {relTime(lastRun)}</span> : null}
                    {typeof j.model === 'string' && j.model ? (
                      <span style={{ fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {j.model}
                      </span>
                    ) : null}
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
                  onClick={() => removeJob(j)}
                  aria-label={`Delete ${j.name ?? 'job'}`}
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
        {/* An empty history is not always "nothing happened": a job refused
            before it started never gets a run row, and `last_error` is then the
            only record that it was refused at all. Saying "no runs" and
            stopping there hid the reason the job needs attention. */}
        {runList.length === 0 && !runs.isLoading && (
          typeof openJob?.last_error === 'string' && openJob.last_error ? (
            <div>
              <div style={{ fontSize: 13.5, color: 'var(--error)' }}>
                Did not run
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                {lastAttempt ? relTime(lastAttempt) : 'last attempt'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 5, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
                {openJob.last_error}
              </div>
            </div>
          ) : (
            <div style={{ color: 'var(--text-faint)' }}>No runs recorded yet.</div>
          )
        )}
        {runList.map((r, i) => {
          const row = r as Record<string, unknown>;
          return (
            <div key={i} style={{ padding: '9px 0', borderBottom: '1px solid var(--border-soft)' }}>
              <div style={{ fontSize: 13.5 }}>
                {String(row.status ?? row.outcome ?? 'run')}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                {relTime(epochSeconds(row.started_at ?? row.created_at) ?? 0)}
              </div>
              {typeof row.error === 'string' && row.error && (
                <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 3 }}>{row.error}</div>
              )}
            </div>
          );
        })}
      </Sheet>

      <Sheet
        open={creating}
        onClose={() => {
          setCreating(false);
          setPickingModel(false);
        }}
        title="New scheduled job"
      >
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
        {pickingModel ? (
          <div style={{ marginBottom: 12 }}>
            <ModelPicker
              selected={form.model || undefined}
              onPick={(model, provider) => {
                setForm((f) => ({ ...f, model, provider }));
                setPickingModel(false);
              }}
            />
          </div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <button
              className="btn btn--sm"
              style={{ width: '100%', justifyContent: 'space-between' }}
              onClick={() => setPickingModel(true)}
            >
              <span style={{ color: 'var(--text-dim)' }}>Model</span>
              <span
                style={{
                  fontFamily: form.model ? 'var(--mono)' : undefined,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  marginLeft: 8,
                }}
              >
                {form.model || 'Follows global default'}
              </span>
            </button>
            {form.model ? (
              <button
                className="btn btn--sm btn--ghost"
                style={{ marginTop: 6, color: 'var(--text-faint)' }}
                onClick={() => setForm((f) => ({ ...f, model: '', provider: '' }))}
              >
                Unpin
              </button>
            ) : (
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6, lineHeight: 1.45 }}>
                An unpinned job may be skipped after the global model changes.
              </div>
            )}
          </div>
        )}
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
