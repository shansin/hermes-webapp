/**
 * Cron templates ("blueprints"): Hermes' catalogue of ready-made scheduled
 * jobs, as a form.
 *
 * `GET /api/cron/blueprints` answers each blueprint as a form schema
 * (`blueprint_form_schema` in `cron/blueprint_catalog.py`): a key, a title, and
 * `fields`, each a slot of one of four types — `time` (HH:MM, 24h), `enum`,
 * `weekdays` (a preset: everyday / weekdays / weekends) and `text`. `POST
 * /api/cron/blueprints/instantiate {blueprint, values}` fills the slots and
 * creates the job. What the backend does with `values` decides everything
 * below:
 *
 * - **Unknown slot names are a 422**, deliberately ("a typo'd `tiem=07:15`
 *   must not silently create a job with the default time"), so only the
 *   blueprint's own field names are ever sent.
 * - **A missing value falls back to the slot's default; an empty one does
 *   not.** `values.get(name, default)` then `raw in (None, "")` → skipped if
 *   optional, refused if not. So every field is sent as the form holds it:
 *   omitting a field the user deliberately cleared would quietly put its
 *   default back.
 * - **A strict enum is checked against its options**, a non-strict one (the
 *   `deliver` slot) is not — its options are suggestions the backend has
 *   already rewritten to this profile's configured platforms.
 * - **The schedule is built from the slots** (`_resolve_schedule`): `time`
 *   fills `{hour}`/`{minute}`, a `recurrence` or `day` fills `{dow}`,
 *   `interval_min` fills `{interval_min}`, anything else is substituted
 *   verbatim. `blueprintSchedule` mirrors it so the sheet can read the
 *   resulting schedule back as a sentence before anything is created — the
 *   same check the hand-written form gives a typed expression.
 *
 * Every job made this way lands in a profile's store: instantiate takes
 * `?profile=` and, unlike every other cron route, defaults to `default`
 * rather than the active profile. The sheet always sends one.
 */

export type BlueprintFieldType = 'time' | 'enum' | 'weekdays' | 'text';

export interface BlueprintField {
  name: string;
  type: BlueprintFieldType | string;
  label: string;
  default: unknown;
  options: string[];
  optional: boolean;
  strict: boolean;
  help: string;
}

export interface Blueprint {
  key: string;
  title: string;
  description: string;
  category: string;
  /** The schedule template, e.g. `{minute} {hour} * * {dow}`. */
  schedule: string;
  scheduleHuman: string;
  fields: BlueprintField[];
}

/** One `GET /api/cron/delivery-targets` row. */
export interface DeliveryTarget {
  id: string;
  name: string;
  /** False for a configured platform with no home channel to deliver to. */
  homeTargetSet: boolean;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** The catalogue, unpacked so a field missing a key cannot throw in render. */
export function normalizeBlueprints(body: unknown): Blueprint[] {
  const list = (body as { blueprints?: unknown } | null)?.blueprints;
  if (!Array.isArray(list)) return [];
  return list
    .map((raw) => (raw ?? {}) as Record<string, unknown>)
    .filter((b) => typeof b.key === 'string' && b.key)
    .map((b) => ({
      key: b.key as string,
      title: str(b.title) || (b.key as string),
      description: str(b.description),
      category: str(b.category) || 'other',
      schedule: str(b.schedule),
      scheduleHuman: str(b.scheduleHuman),
      fields: (Array.isArray(b.fields) ? b.fields : [])
        .map((f) => (f ?? {}) as Record<string, unknown>)
        .filter((f) => typeof f.name === 'string' && f.name)
        .map((f) => ({
          name: f.name as string,
          type: str(f.type) || 'text',
          label: str(f.label) || (f.name as string),
          default: f.default ?? null,
          options: Array.isArray(f.options) ? f.options.map(str) : [],
          optional: f.optional === true,
          strict: f.strict !== false,
          help: str(f.help),
        })),
    }));
}

export function normalizeTargets(body: unknown): DeliveryTarget[] {
  const list = (body as { targets?: unknown } | null)?.targets;
  if (!Array.isArray(list)) return [];
  return list
    .map((raw) => (raw ?? {}) as Record<string, unknown>)
    .filter((t) => typeof t.id === 'string' && t.id)
    .map((t) => ({ id: t.id as string, name: str(t.name) || (t.id as string), homeTargetSet: t.home_target_set !== false }));
}

/** The form's starting values: each slot's default, as text. */
export function initialValues(bp: Blueprint): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of bp.fields) out[f.name] = f.default == null ? '' : str(f.default);
  return out;
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
/** `WEEKDAY_PRESETS` in `cron/blueprint_catalog.py`. */
const WEEKDAY_PRESETS: Record<string, string> = { everyday: '*', weekdays: '1-5', weekends: '0,6' };
const DAY_TO_DOW: Record<string, string> = {
  sunday: '0',
  monday: '1',
  tuesday: '2',
  wednesday: '3',
  thursday: '4',
  friday: '5',
  saturday: '6',
};

/**
 * What is wrong with the form, per field — the checks `fill_blueprint` and
 * `_resolve_schedule` would make, said beside the field instead of after a
 * round trip. Empty when it can be sent.
 */
export function blueprintProblems(bp: Blueprint, values: Record<string, string>): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const f of bp.fields) {
    const v = (values[f.name] ?? '').trim();
    if (!v) {
      if (!f.optional) problems[f.name] = 'Required';
      continue;
    }
    if (f.type === 'time' && !TIME.test(v)) problems[f.name] = 'Use HH:MM, 24-hour';
    else if (f.type === 'weekdays' && !(v.toLowerCase() in WEEKDAY_PRESETS)) problems[f.name] = 'Pick one';
    else if (f.type === 'enum' && f.strict && f.options.length && !f.options.includes(v)) problems[f.name] = 'Pick one';
    else if (f.name === 'interval_min' && !(/^\d+$/.test(v) && Number(v) > 0)) problems[f.name] = 'Minutes, above zero';
  }
  return problems;
}

/** The instantiate body: every one of the blueprint's own fields, trimmed — see the header. */
export function blueprintPayload(
  bp: Blueprint,
  values: Record<string, string>,
): { blueprint: string; values: Record<string, string> } {
  const out: Record<string, string> = {};
  for (const f of bp.fields) out[f.name] = (values[f.name] ?? '').trim();
  return { blueprint: bp.key, values: out };
}

/**
 * The cron expression the backend will build, or null when it cannot be told
 * yet (a slot still invalid, or a template this does not understand).
 */
export function blueprintSchedule(bp: Blueprint, values: Record<string, string>): string | null {
  const v = (name: string) => (values[name] ?? '').trim();
  // A free-text `schedule` slot passes through verbatim.
  if (v('schedule')) return v('schedule');

  let sched = bp.schedule;
  if (!sched) return null;
  const repl: Record<string, string> = {};

  if (sched.includes('{minute}') || sched.includes('{hour}')) {
    const m = TIME.exec(v('time'));
    if (!m) return null;
    repl.hour = String(Number(m[1]));
    repl.minute = String(Number(m[2]));
  }
  if (sched.includes('{dow}')) {
    if ('recurrence' in values) {
      const preset = (v('recurrence') || 'everyday').toLowerCase();
      if (!(preset in WEEKDAY_PRESETS)) return null;
      repl.dow = WEEKDAY_PRESETS[preset]!;
    } else if ('day' in values) {
      const dow = DAY_TO_DOW[v('day').toLowerCase()];
      if (!dow) return null;
      repl.dow = dow;
    } else {
      repl.dow = '*';
    }
  }
  if (sched.includes('{interval_min}')) {
    const iv = v('interval_min');
    if (!/^\d+$/.test(iv) || Number(iv) <= 0) return null;
    repl.interval_min = iv;
  }
  for (const [, name] of sched.matchAll(/\{(\w+)\}/g)) {
    if (name && !(name in repl) && name in values) repl[name] = v(name);
  }
  let missing = false;
  sched = sched.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (name in repl) return repl[name]!;
    missing = true;
    return '';
  });
  return missing ? null : sched;
}

/**
 * The choices for a `deliver` slot, labelled.
 *
 * The slot's own options are already this profile's (the backend rewrites them
 * to `origin`, `local` and every configured platform); the delivery targets
 * route adds a readable name and whether each platform has a home channel —
 * a platform without one accepts the job and then has nowhere to send it.
 * `origin` from a form has no originating chat, so the scheduler falls back
 * to the first home channel it finds (`scheduler_delivery.py`).
 */
export function deliveryOptions(
  field: BlueprintField,
  targets: DeliveryTarget[],
): { value: string; label: string; hint?: string }[] {
  const byId = new Map(targets.map((t) => [t.id, t]));
  const ids = [...field.options];
  for (const t of targets) if (!ids.includes(t.id)) ids.push(t.id);
  return ids.map((id) => {
    if (id === 'origin') return { value: id, label: 'Home channel', hint: 'The first platform with a home channel set' };
    if (id === 'local') return { value: id, label: 'Save only', hint: 'Keep the output; send nothing' };
    const t = byId.get(id);
    const label = t?.name ?? id.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    return t && !t.homeTargetSet
      ? { value: id, label, hint: 'No home channel set — nothing would be delivered' }
      : { value: id, label };
  });
}
