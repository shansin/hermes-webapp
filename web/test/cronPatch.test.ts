/**
 * What an edit actually sends.
 *
 * `PUT /api/cron/jobs/<id>` merges `{ updates }` over the stored record, so
 * every key sent is a key overwritten and every key omitted is a key left
 * alone. The edit sheet renders seven fields; a job record holds thirty. The
 * failure this suite exists for is silent in both directions:
 *
 * - a key that should not travel (`script`, `deliver`, `context_from` — none
 *   of which the form knows about) is only erased in storage, and the job
 *   goes on looking correct on screen until the next run does the wrong
 *   thing, or nothing;
 * - a key that should travel and does not is an edit that reports success
 *   and changes nothing.
 *
 * Neither is visible from the screen, which is the bar in TESTING.md.
 */
import { describe, it, expect } from 'vitest';
import { cronFormFromJob, cronPatch, scheduleInput, scheduleIsCron } from '../src/lib/cronForm';
import { outputDir, runTime } from '../src/components/hub/ScriptRuns';
import type { CronJob } from '../src/api/hub';

const JOB: CronJob = {
  id: 'abc123',
  name: 'morning-brief',
  prompt: 'Summarise the news',
  schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
  schedule_display: '0 9 * * *',
  profile: 'research',
  model: null,
  provider: null,
  skills: [],
  enabled_toolsets: null,
};

const form = (over: Partial<ReturnType<typeof cronFormFromJob>> = {}) => ({
  ...cronFormFromJob(JOB),
  ...over,
});

describe('cronPatch', () => {
  it('sends nothing when nothing changed', () => {
    expect(cronPatch(JOB, form())).toEqual({});
  });

  it('sends only the field that changed', () => {
    expect(cronPatch(JOB, form({ prompt: 'Summarise the news, briefly' }))).toEqual({
      prompt: 'Summarise the news, briefly',
    });
  });

  it('never carries a field the form does not render', () => {
    const job: CronJob = { ...JOB, script: 'watch.py', no_agent: true, deliver: 'all', context_from: ['self'] };
    const patch = cronPatch(job, { ...cronFormFromJob(job), name: 'renamed' });
    expect(patch).toEqual({ name: 'renamed' });
    for (const key of ['script', 'no_agent', 'deliver', 'context_from', 'id', 'profile']) {
      expect(patch).not.toHaveProperty(key);
    }
  });

  it('trims, and treats a whitespace-only edit as no edit', () => {
    expect(cronPatch(JOB, form({ name: '  morning-brief  ' }))).toEqual({});
    expect(cronPatch(JOB, form({ name: '  brief  ' }))).toEqual({ name: 'brief' });
  });

  it('refuses to blank a prompt, which the backend rejects as an empty payload', () => {
    expect(cronPatch(JOB, form({ prompt: '   ' }))).toEqual({});
  });

  it('leaves a script job with no prompt alone', () => {
    const job: CronJob = { ...JOB, prompt: undefined, script: 'watch.py' };
    expect(cronPatch(job, cronFormFromJob(job))).toEqual({});
  });

  it('pins model and provider together', () => {
    expect(cronPatch(JOB, form({ model: 'qwen3.8:27b', provider: 'custom' }))).toEqual({
      model: 'qwen3.8:27b',
      provider: 'custom',
    });
  });

  it('unpins with empty strings, which Hermes normalises to null', () => {
    const pinned: CronJob = { ...JOB, model: 'qwen3.8:27b', provider: 'custom' };
    expect(cronPatch(pinned, { ...cronFormFromJob(pinned), model: '', provider: '' })).toEqual({
      model: '',
      provider: '',
    });
  });

  it('does not send a model pin for a job that never had one and still has none', () => {
    expect(cronPatch(JOB, form({ model: '', provider: '' }))).toEqual({});
  });

  it('sends an empty list to clear pinned skills and toolsets', () => {
    const pinned: CronJob = { ...JOB, skills: ['pdf'], enabled_toolsets: ['shell'] };
    expect(cronPatch(pinned, { ...cronFormFromJob(pinned), skills: [], toolsets: [] })).toEqual({
      skills: [],
      enabled_toolsets: [],
    });
  });

  it('compares skill pins as a set, not as an ordered list', () => {
    const pinned: CronJob = { ...JOB, skills: ['pdf', 'web'] };
    expect(cronPatch(pinned, { ...cronFormFromJob(pinned), skills: ['web', 'pdf'] })).toEqual({});
    expect(cronPatch(pinned, { ...cronFormFromJob(pinned), skills: ['web'] })).toEqual({
      skills: ['web'],
    });
  });

  it('sends the schedule as typed, and only when it differs', () => {
    expect(cronPatch(JOB, form({ schedule: '0 9 * * *' }))).toEqual({});
    expect(cronPatch(JOB, form({ schedule: '30 6 * * 1-5' }))).toEqual({
      schedule: '30 6 * * 1-5',
    });
  });
});

describe('scheduleInput', () => {
  /* `schedule_display` is only *usually* the expression — for a one-shot it is
     a rendered time. Seeding the field from it would make an untouched field
     look changed, and send a rendered string back as a schedule. */
  it('prefers the stored expression over the display string', () => {
    expect(
      scheduleInput({
        ...JOB,
        schedule: { kind: 'cron', expr: '0 9 * * *', display: '9:00 AM daily' },
        schedule_display: '9:00 AM daily',
      }),
    ).toBe('0 9 * * *');
  });

  it('uses run_at for a one-shot', () => {
    expect(
      scheduleInput({ ...JOB, schedule: { kind: 'once', run_at: '2026-09-01T09:00:00-07:00' } }),
    ).toBe('2026-09-01T09:00:00-07:00');
  });

  it('still reads the bare string older gateways sent', () => {
    expect(scheduleInput({ ...JOB, schedule: '0 9 * * *' })).toBe('0 9 * * *');
  });
});

describe('scheduleIsCron', () => {
  /* The cron validator understands five fields and nothing else, so letting it
     judge an interval or a one-shot puts an error under a field nobody touched
     and disables Save on a job that is perfectly valid. */
  it('is false for the kinds cronError cannot read', () => {
    expect(scheduleIsCron({ ...JOB, schedule: { kind: 'once', run_at: 'x' } })).toBe(false);
    expect(scheduleIsCron({ ...JOB, schedule: { kind: 'interval', display: 'every 10m' } })).toBe(false);
  });

  it('is true for cron, and for a shape it cannot identify', () => {
    expect(scheduleIsCron(JOB)).toBe(true);
    expect(scheduleIsCron({ ...JOB, schedule: '0 9 * * *' })).toBe(true);
    expect(scheduleIsCron({ ...JOB, schedule: undefined })).toBe(true);
  });
});

describe('script-job run history', () => {
  /* `/api/cron/jobs/<id>/runs` lists sessions named `cron_<id>_<ts>`, and a
     no_agent job never opens a session — so the endpoint returns zero runs for
     a job that has fired every weekday for a month. The files it writes are
     the only history there is. */
  it('addresses the profile home the job came out of, not the active one', () => {
    expect(
      outputDir({ ...JOB, id: '5ab2b5fa6d15', hermes_home: '/home/u/.hermes/profiles/fitness' }),
    ).toBe('/home/u/.hermes/profiles/fitness/cron/output/5ab2b5fa6d15');
  });

  it('tolerates a trailing slash on the home', () => {
    expect(outputDir({ ...JOB, id: 'abc', hermes_home: '/home/u/.hermes/' })).toBe(
      '/home/u/.hermes/cron/output/abc',
    );
  });

  it('has nowhere to look when the job carries no home', () => {
    expect(outputDir({ ...JOB, hermes_home: undefined })).toBeNull();
  });

  /* Written by the scheduler in local time with no zone. Reading it as UTC
     shifts every row by the offset, which shows a 9am job as having run at 2am. */
  it('reads the run time out of the filename as local time', () => {
    const at = runTime('2026-08-25_09-11-02.md');
    expect(at).not.toBeNull();
    const d = new Date(at! * 1000);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]).toEqual([
      2026, 8, 25, 9, 11,
    ]);
  });

  it('returns null for anything not named like a run', () => {
    expect(runTime('notes.md')).toBeNull();
    expect(runTime('2026-08-25.md')).toBeNull();
  });
});
