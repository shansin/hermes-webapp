/**
 * Scheduled jobs: pause/resume/trigger, inspect runs, create new ones.
 *
 * ## Jobs belong to a profile
 *
 * A cron job is not tagged with a profile — it lives in that profile's own
 * `cron/jobs.json` and runs against that profile's home: its config, model,
 * skills and memory. So "make the research profile do the research run" is
 * expressed by creating the job *in* that profile, which the RUNS AS picker
 * below does by sending `?profile=`.
 *
 * Two consequences worth stating, because neither is visible from the screen:
 *
 * - **This list is already every profile's jobs.** Hermes' list endpoint
 *   defaults to `profile=all` and merges the stores, so the moment a second
 *   profile exists its jobs appear here indistinguishable from the first's.
 *   That is what the profile badge on each row is for; it is not decoration.
 * - **Every per-job action carries the profile.** Without it Hermes resolves
 *   the job by scanning stores and matching on id *or name*, so two profiles
 *   holding a `morning-brief` each will act on whichever it finds first.
 *
 * ## Pinning skills and toolsets
 *
 * Narrower than the profile, for a job that should not have the run of it: a
 * nightly summariser has no business holding shell tools. Empty means "inherit
 * the profile's own set", which is what every job made before this does, so
 * the pickers are offered scoped to the *selected* profile rather than the
 * active one — offering the skills sitting in front of you would be offering
 * the wrong list.
 */
import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Sheet } from '../shared/Sheet';
import { ModelPicker } from '../shared/ModelPicker';
import { MultiSelectSheet, PickerRow, type MultiSelectOption } from '../shared/MultiSelectSheet';
import { Empty, ErrorNote, SkeletonList, relTime } from '../shared/misc';
import { IconPlay, IconPause, IconPlus, IconTrash } from '../shared/Icons';
import {
  useCreateCronJob,
  useCronAction,
  useCronJobs,
  useCronRuns,
  useDeleteCronJob,
  useSkills,
  type CronJob,
} from '../../api/hub';
import { useToolsets } from '../../api/tools';
import { useActiveProfile, useProfiles } from '../../api/profiles';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';
import { UNDO_WINDOW_MS, scheduleUndoable } from '../../lib/undo';
import { humanCron } from '../../lib/cronText';

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
function scheduleExpr(j: CronJob): string {
  if (j.schedule_display) return j.schedule_display;
  const s = j.schedule;
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object') return s.display ?? s.kind ?? '';
  return '';
}

/**
 * The schedule as a sentence, falling back to the expression.
 *
 * `schedule_display` sounds pre-rendered and is not — it is the cron
 * expression echoed back, so this row showed `30 20 * * *` where it meant
 * "8:30 PM daily". `humanCron` translates the shapes it recognises and returns
 * null for anything else, which is deliberately shown raw: a schedule rendered
 * wrong is believed, while a cryptic one at least announces that it needs
 * reading.
 */
function scheduleText(j: CronJob): { text: string; raw: string; humanised: boolean } {
  const raw = scheduleExpr(j);
  const human = humanCron(raw);
  return { text: human ?? raw, raw, humanised: human !== null };
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
  /** Empty until the active profile is known — see `formProfile` below. */
  profile: '' as string,
  /** Empty means "whatever the profile has enabled", not "none". */
  skills: [] as string[],
  toolsets: [] as string[],
};

export function CronTab() {
  const { data, isLoading, error } = useCronJobs();
  const profiles = useProfiles().data?.profiles ?? [];
  const activeProfile = useActiveProfile().data?.active ?? '';
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
            void del.mutateAsync({ id: job.id, profile: job.profile }).catch((e: unknown) => {
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
  const [picking, setPicking] = useState<'skills' | 'toolsets' | null>(null);

  /**
   * Which profile the form is filling in for.
   *
   * Falls back to the active one rather than to nothing: creating a job with
   * no profile is not an error, it just silently files it under whatever is
   * active — so the picker shows that answer instead of hiding it. Resolved on
   * read rather than seeded into state, because the active profile arrives
   * from a query that may not have landed when the sheet opens.
   */
  const formProfile = form.profile || activeProfile || '';

  /* Scoped to the profile being configured, not the one running. Both are
     cached for 30s and only fetched while the sheet is open. */
  const scopedSkills = useSkills(formProfile || null, creating);
  const scopedToolsets = useToolsets(formProfile || null, creating);

  const skillOptions: MultiSelectOption[] = (scopedSkills.data ?? [])
    .filter((sk) => sk.enabled)
    .map((sk) => ({ value: sk.name, label: sk.name, hint: sk.description, meta: sk.category }));

  const toolsetOptions: MultiSelectOption[] = (scopedToolsets.data ?? []).map((t) => ({
    value: t.name,
    label: t.label || t.name,
    hint: t.description,
    meta: t.configured ? t.platform_label : 'no key',
    dimmed: !t.configured || !t.available,
  }));

  /* Resolved before the runs query, which needs the profile: the history
     endpoint scopes the same way every other per-job route does. */
  const openJob = openRuns ? data?.find((j) => j.id === openRuns) : undefined;
  const runs = useCronRuns(openRuns, openJob?.profile);

  const run = async (job: CronJob, act: 'pause' | 'resume' | 'trigger') => {
    buzz('tap');
    try {
      await action.mutateAsync({ id: job.id, action: act, profile: job.profile });
      toast(act === 'trigger' ? 'Job triggered' : `Job ${act}d`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : `Could not ${act}`, 'error');
    }
  };

  const submit = async () => {
    if (!form.name.trim() || !form.prompt.trim()) return;
    try {
      await create.mutateAsync({
        // Not a body field — a query parameter that picks which profile's job
        // store this is written into, which is what makes the job run as that
        // agent. Falls back to the active profile, which is what an omitted
        // parameter would have resolved to anyway.
        profile: formProfile || undefined,
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        schedule: form.schedule.trim(),
        // Only sent when the user actually chose one: omitting the keys
        // leaves the job unpinned, which is the "follow the global default"
        // behaviour and what every job created before this existed does.
        ...(form.model && form.provider
          ? { model: form.model, provider: form.provider }
          : {}),
        // Same rule, and the reason both are omitted rather than sent empty:
        // an empty list is a narrowing to nothing on some builds, while an
        // absent key unambiguously means "inherit the profile's own set".
        ...(form.skills.length ? { skills: form.skills } : {}),
        ...(form.toolsets.length ? { enabled_toolsets: form.toolsets } : {}),
      });
      toast(
        formProfile ? `Job created in ${formProfile}` : 'Job created',
        'success',
      );
      setForm(BLANK_FORM);
      setPickingModel(false);
      setPicking(null);
      setCreating(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Create failed', 'error');
    }
  };

  const runList = Array.isArray(runs.data) ? runs.data : (runs.data?.runs ?? []);
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <div style={{ fontWeight: 600, fontSize: 14.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {jobName(j)}
                    </div>
                    {/* Which profile's store this came out of. Shown only once
                        there is more than one, because until then every job in
                        the list is from the same place and saying so on each
                        row is noise — but the moment a second profile exists
                        this list silently merges both, and without this there
                        is nothing on screen that says which is which. */}
                    {profiles.length > 1 && j.profile && (
                      <span
                        className="tool-pill"
                        style={{
                          flexShrink: 0,
                          color: j.profile === activeProfile ? 'var(--accent)' : 'var(--text-faint)',
                        }}
                      >
                        {j.profile}
                      </span>
                    )}
                  </div>
                  {schedule.text && (
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--text-faint)',
                        // Monospace only when it is still an expression. A
                        // sentence set in mono reads as a machine string.
                        fontFamily: schedule.humanised ? undefined : 'var(--mono)',
                        marginTop: 2,
                      }}
                      // The expression stays reachable for anyone who wants to
                      // check it, rather than being replaced outright.
                      title={schedule.humanised ? schedule.raw : undefined}
                    >
                      {schedule.text}
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
                    {/* A pinned job runs with less than its profile has, which
                        is worth seeing from the list — it is the first thing to
                        suspect when a job cannot do something it used to. */}
                    {Array.isArray(j.skills) && j.skills.length > 0 && (
                      <span>{j.skills.length} skills</span>
                    )}
                    {Array.isArray(j.enabled_toolsets) && j.enabled_toolsets.length > 0 && (
                      <span>{j.enabled_toolsets.length} toolsets</span>
                    )}
                  </div>
                </div>

                <button
                  className="icon-btn"
                  onClick={() => void run(j, paused ? 'resume' : 'pause')}
                  aria-label={paused ? 'Resume' : 'Pause'}
                >
                  {paused ? <IconPlay size={17} /> : <IconPause size={17} />}
                </button>
              </div>

              <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
                <button className="btn btn--sm" onClick={() => void run(j, 'trigger')}>
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
        {/* Which profile's store the job goes into — see the note at the top.
            Only shown once there is a choice to make: a single-profile install
            has exactly one answer and a picker offering it is furniture. */}
        {profiles.length > 1 && (
          <>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', fontWeight: 650, marginBottom: 6 }}>
              RUNS AS
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
              {profiles.map((pr) => (
                <button
                  key={pr.name}
                  className={`chip${formProfile === pr.name ? ' chip--active' : ''}`}
                  onClick={() => {
                    buzz('tap');
                    /* Changing the profile drops the pins: they name skills and
                       toolsets belonging to the profile they were chosen from,
                       and carrying them across would send another profile's
                       names to a store that has never heard of them. */
                    setForm((f) => ({ ...f, profile: pr.name, skills: [], toolsets: [] }));
                  }}
                >
                  {pr.name}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 12, lineHeight: 1.45 }}>
              The job is stored in that profile and runs with its config, skills and memory.
            </div>
          </>
        )}

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
        {/* Narrowing, not enabling: these can only take away from what the
            profile already has. Hidden while the model picker is open so the
            sheet is never two long lists deep. */}
        {!pickingModel && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            <PickerRow
              label="Skills"
              value={
                form.skills.length
                  ? `${form.skills.length} pinned`
                  : "The profile's own"
              }
              onOpen={() => setPicking('skills')}
            />
            <PickerRow
              label="Toolsets"
              value={
                form.toolsets.length
                  ? `${form.toolsets.length} pinned`
                  : "The profile's own"
              }
              onOpen={() => setPicking('toolsets')}
            />
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.45 }}>
              Pin these to give one job less than the profile has — a nightly summary
              does not need shell access.
            </div>
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

      {/* Stacked over the create sheet rather than replacing it: the form
          behind is half-filled, and `useHistoryDismiss` nests, so back closes
          the picker and leaves the form exactly as it was. */}
      <MultiSelectSheet
        open={picking === 'skills'}
        title={formProfile ? `Skills in ${formProfile}` : 'Skills'}
        options={skillOptions}
        selected={form.skills}
        onChange={(skills) => setForm((f) => ({ ...f, skills }))}
        onClose={() => setPicking(null)}
        loading={scopedSkills.isLoading}
        emptyMeans="Nothing pinned — the job gets every skill this profile has enabled."
        emptyList="This profile has no enabled skills."
      />

      <MultiSelectSheet
        open={picking === 'toolsets'}
        title={formProfile ? `Toolsets in ${formProfile}` : 'Toolsets'}
        options={toolsetOptions}
        selected={form.toolsets}
        onChange={(toolsets) => setForm((f) => ({ ...f, toolsets }))}
        onClose={() => setPicking(null)}
        loading={scopedToolsets.isLoading}
        emptyMeans="Nothing pinned — the job gets every toolset this profile has enabled."
        emptyList="This profile reports no toolsets."
      />
    </div>
  );
}
