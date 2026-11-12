/**
 * Cron templates — what the form sends, and what it says the job will do.
 *
 * The instantiate route is strict in ways that fail far from the form: an
 * unknown slot name is a 422, an *omitted* slot silently takes its default
 * (so a field the user cleared comes back), and the schedule is assembled
 * server-side from the slots. A sentence read back from the wrong expression
 * is the quiet failure here — the job is created, and runs at the wrong time.
 * Fixtures are the shapes `blueprint_form_schema` emits.
 */
import { describe, expect, it } from 'vitest';
import {
  blueprintPayload,
  blueprintProblems,
  blueprintSchedule,
  deliveryOptions,
  initialValues,
  normalizeBlueprints,
  normalizeTargets,
  type Blueprint,
} from '../src/lib/cronBlueprint';

const field = (over: Record<string, unknown>) => ({
  type: 'text',
  label: over.name,
  default: null,
  options: [],
  optional: false,
  strict: true,
  help: '',
  ...over,
});

const deliver = field({
  name: 'deliver',
  type: 'enum',
  default: 'origin',
  options: ['origin', 'local', 'telegram', 'bot_chat:research'],
  strict: false,
});

const [reminder, inbox, weekly] = normalizeBlueprints({
  blueprints: [
    {
      key: 'reminder',
      title: 'Reminder',
      category: 'daily',
      schedule: '{minute} {hour} * * {dow}',
      fields: [
        field({ name: 'what', default: 'take a break' }),
        field({ name: 'time', type: 'time', default: '14:00' }),
        field({ name: 'recurrence', type: 'weekdays', default: 'everyday', options: ['everyday', 'weekdays', 'weekends'] }),
        deliver,
      ],
    },
    {
      key: 'important-mail',
      title: 'Important mail',
      category: 'email',
      schedule: '*/{interval_min} * * * *',
      fields: [
        field({ name: 'interval_min', type: 'enum', default: '30', options: ['15', '30', '60'] }),
        field({ name: 'criteria', optional: true, default: 'from my boss' }),
        deliver,
      ],
    },
    {
      key: 'weekly',
      title: 'Weekly review',
      category: 'weekly',
      schedule: '{minute} {hour} * * {dow}',
      fields: [
        field({ name: 'day', type: 'enum', default: 'friday', options: ['monday', 'friday'] }),
        field({ name: 'time', type: 'time', default: '16:30' }),
      ],
    },
  ],
}) as [Blueprint, Blueprint, Blueprint];

describe('normalizing the catalogue', () => {
  it('survives a payload missing keys rather than throwing in render', () => {
    expect(normalizeBlueprints(null)).toEqual([]);
    expect(normalizeBlueprints({ blueprints: [{ title: 'no key' }, { key: 'k' }] })).toEqual([
      expect.objectContaining({ key: 'k', title: 'k', fields: [], category: 'other' }),
    ]);
  });

  it('keeps a non-strict slot non-strict', () => {
    expect(reminder.fields.find((f) => f.name === 'deliver')?.strict).toBe(false);
  });
});

describe('the payload', () => {
  it('starts from each slot’s default', () => {
    expect(initialValues(reminder)).toEqual({ what: 'take a break', time: '14:00', recurrence: 'everyday', deliver: 'origin' });
  });

  /* The backend 422s on any name it does not know. */
  it('sends only the blueprint’s own slot names', () => {
    const body = blueprintPayload(reminder, { ...initialValues(reminder), tiem: '07:15' });
    expect(Object.keys(body.values).sort()).toEqual(['deliver', 'recurrence', 'time', 'what']);
    expect(body.blueprint).toBe('reminder');
  });

  /* Omitted means "use the default"; only an empty value says "none". */
  it('sends a cleared optional field as empty rather than omitting it', () => {
    const body = blueprintPayload(inbox, { ...initialValues(inbox), criteria: '  ' });
    expect(body.values).toHaveProperty('criteria', '');
  });
});

describe('problems', () => {
  it('passes a filled form', () => {
    expect(blueprintProblems(reminder, initialValues(reminder))).toEqual({});
  });

  it('flags a required field left empty, and leaves an optional one alone', () => {
    expect(blueprintProblems(reminder, { ...initialValues(reminder), what: '' })).toEqual({ what: 'Required' });
    expect(blueprintProblems(inbox, { ...initialValues(inbox), criteria: '' })).toEqual({});
  });

  it('wants a 24-hour HH:MM', () => {
    expect(blueprintProblems(reminder, { ...initialValues(reminder), time: '8pm' })).toHaveProperty('time');
    expect(blueprintProblems(reminder, { ...initialValues(reminder), time: '24:00' })).toHaveProperty('time');
    expect(blueprintProblems(reminder, { ...initialValues(reminder), time: '7:05' })).toEqual({});
  });

  it('holds a strict enum to its options, and a non-strict one to nothing', () => {
    expect(blueprintProblems(inbox, { ...initialValues(inbox), interval_min: '45' })).toHaveProperty('interval_min');
    expect(blueprintProblems(inbox, { ...initialValues(inbox), deliver: 'slack:#ops' })).toEqual({});
  });
});

describe('the schedule it will build', () => {
  it('fills hour and minute from the time, and the weekday preset', () => {
    expect(blueprintSchedule(reminder, initialValues(reminder))).toBe('0 14 * * *');
    expect(blueprintSchedule(reminder, { ...initialValues(reminder), time: '07:05', recurrence: 'weekdays' })).toBe('5 7 * * 1-5');
    expect(blueprintSchedule(reminder, { ...initialValues(reminder), recurrence: 'weekends' })).toBe('0 14 * * 0,6');
  });

  it('maps a named day', () => {
    expect(blueprintSchedule(weekly, initialValues(weekly))).toBe('30 16 * * 5');
  });

  it('fills an interval', () => {
    expect(blueprintSchedule(inbox, initialValues(inbox))).toBe('*/30 * * * *');
  });

  it('says nothing rather than guessing from an invalid slot', () => {
    expect(blueprintSchedule(reminder, { ...initialValues(reminder), time: 'soon' })).toBeNull();
    expect(blueprintSchedule(inbox, { ...initialValues(inbox), interval_min: '0' })).toBeNull();
  });

  it('passes a free-text schedule slot through verbatim', () => {
    expect(blueprintSchedule(reminder, { ...initialValues(reminder), schedule: '0 6 1 * *' })).toBe('0 6 1 * *');
  });
});

describe('delivery choices', () => {
  const targets = normalizeTargets({
    targets: [
      { id: 'local', name: 'Local (save only)', home_target_set: true },
      { id: 'telegram', name: 'Telegram', home_target_set: false },
      { id: 'discord', name: 'Discord', home_target_set: true },
      { id: 'bot_chat:research', name: 'Bot Chat (research)', home_target_set: true },
    ],
  });
  const opts = deliveryOptions(reminder.fields.find((f) => f.name === 'deliver')!, targets);

  it('names every choice, including targets the slot did not list', () => {
    expect(opts.map((o) => o.value)).toEqual(['origin', 'local', 'telegram', 'bot_chat:research', 'discord']);
    expect(opts.find((o) => o.value === 'bot_chat:research')?.label).toBe('Bot Chat (research)');
    expect(opts.find((o) => o.value === 'origin')?.label).toBe('Home channel');
  });

  it('warns about a platform with nowhere to deliver', () => {
    expect(opts.find((o) => o.value === 'telegram')?.hint).toMatch(/No home channel/);
    expect(opts.find((o) => o.value === 'discord')?.hint).toBeUndefined();
  });
});
