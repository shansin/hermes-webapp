/**
 * The cron form, in both directions: a job read into fields, and fields read
 * back out as an update.
 *
 * ## Why an update is a patch and not the form
 *
 * `PUT /api/cron/jobs/<id>` takes `{ updates: { … } }` and merges it over the
 * stored record — so every key sent is a key overwritten, and every key
 * omitted is a key left alone. That distinction is the whole reason this file
 * exists: the sheet renders seven fields and a job record holds thirty. A job
 * with a `script`, a `deliver` target, `context_from` continuity or
 * `no_agent` set was made by the CLI or a blueprint, and the form has no
 * opinion about any of it. Sending back a full record built from the form
 * would quietly erase all of it, and nothing on screen would say so — the job
 * would simply stop doing what it did.
 *
 * So `cronPatch` sends only what actually changed. An untouched field is
 * absent, which is not the same statement as an empty one.
 *
 * ## Clearing, as distinct from not touching
 *
 * Where the form *can* say "no longer pinned", the empty value is the way to
 * say it and it has to be sent: Hermes normalizes `model: ""` to null
 * (`_cron_optional_text`) and `enabled_toolsets: []` to null
 * (`_cron_string_list`), both meaning "inherit the profile's own". This is
 * the one place the create form's rule — omit an empty list, because an
 * absent key unambiguously means inherit — is reversed: on create, absent
 * means inherit; on update, absent means *unchanged*, and only the empty
 * value clears an existing pin.
 */
import type { CronJob } from '../api/hub';

export interface CronFormValues {
  name: string;
  prompt: string;
  schedule: string;
  model: string;
  provider: string;
  /** Which profile's store the job goes into. Create only — see `cronPatch`. */
  profile: string;
  skills: string[];
  toolsets: string[];
}

export const BLANK_CRON_FORM: CronFormValues = {
  name: '',
  prompt: '',
  schedule: '0 9 * * *',
  model: '',
  provider: '',
  profile: '',
  skills: [],
  toolsets: [],
};

/**
 * The schedule as something that can be typed back in.
 *
 * Not `schedule_display`, which is only ever *usually* the expression: for a
 * one-shot it is a rendered time and for an interval it can be a phrase. The
 * stored `expr` is what `parse_schedule` produced the record from, so it is
 * the value that survives a round trip unchanged. `run_at` is the same thing
 * for a one-shot — an ISO timestamp Hermes parses back.
 */
export function scheduleInput(job: CronJob): string {
  const s = job.schedule;
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object') {
    const expr = s.expr ?? s.run_at ?? s.display;
    if (typeof expr === 'string' && expr) return expr;
  }
  return job.schedule_display ?? '';
}

/**
 * Whether the schedule is a cron expression, and so whether `cronError` may
 * judge it.
 *
 * A `once` or `every 10m` job is a perfectly valid schedule that is not five
 * fields, and running it past the cron validator would put a red error under
 * a field the user has not touched and disable the save button on a job that
 * is fine. Unknown kinds are treated as cron because that is what every job
 * this app creates is, and because a validator that only ever *warns* is the
 * safer default of the two.
 */
export function scheduleIsCron(job: CronJob): boolean {
  const s = job.schedule;
  if (s && typeof s === 'object' && typeof s.kind === 'string') return s.kind === 'cron';
  return true;
}

/** `null`, `undefined` and a non-array all mean "nothing pinned". */
function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Order is not meaning here — two pickers producing the same set are equal. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((v, i) => v === sorted[i]);
}

/** A stored job as the form's starting values. */
export function cronFormFromJob(job: CronJob): CronFormValues {
  return {
    name: job.name ?? '',
    prompt: job.prompt ?? '',
    schedule: scheduleInput(job),
    model: typeof job.model === 'string' ? job.model : '',
    provider: typeof job.provider === 'string' ? job.provider : '',
    /* Read-only in the edit sheet: a job's profile is the store it lives in,
       not a field on it, so "move it" is delete-and-recreate under a new id
       and a lost run history. The sheet says so rather than offering it. */
    profile: job.profile ?? '',
    skills: list(job.skills),
    toolsets: list(job.enabled_toolsets),
  };
}

/**
 * What changed, as the body of an update. Empty when nothing did — which the
 * caller should treat as "no request to make" rather than sending a no-op.
 */
export function cronPatch(job: CronJob, form: CronFormValues): Record<string, unknown> {
  const before = cronFormFromJob(job);
  const updates: Record<string, unknown> = {};

  const name = form.name.trim();
  if (name && name !== before.name) updates.name = name;

  /* A blank prompt is never *sent*: on a prompt-driven job it is the empty
     payload Hermes rejects outright, and on a script or no_agent job the
     field was empty to begin with and equals `before` anyway. */
  const prompt = form.prompt.trim();
  if (prompt && prompt !== before.prompt) updates.prompt = prompt;

  const schedule = form.schedule.trim();
  if (schedule && schedule !== before.schedule) updates.schedule = schedule;

  /* Model and provider move together or not at all: a model pinned to the
     wrong provider is a job that fails at fire time, hours later, with no
     record here of the edit that caused it. Clearing sends both empty, which
     is what puts the job back on the global default. */
  if (form.model !== before.model || form.provider !== before.provider) {
    if (form.model) {
      updates.model = form.model;
      updates.provider = form.provider;
    } else if (before.model || before.provider) {
      updates.model = '';
      updates.provider = '';
    }
  }

  if (!sameSet(form.skills, before.skills)) updates.skills = form.skills;
  if (!sameSet(form.toolsets, before.toolsets)) updates.enabled_toolsets = form.toolsets;

  return updates;
}
