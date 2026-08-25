/**
 * Cron expressions in words.
 *
 * The important half of this contract is the refusals. A schedule rendered
 * wrong gets believed — "daily" on a job that runs weekly is worse than the
 * raw `30 6 * * 1`, because the raw form at least announces that it needs
 * reading. So anything outside the handled shapes must return null and let the
 * caller show the expression, and that is what most of these cases pin.
 */
import { describe, it, expect } from 'vitest';
import { cronError, humanCron } from '../src/lib/cronText';

describe('humanCron — the shapes on this install', () => {
  it('renders the real jobs', () => {
    // Taken from the live backend, which reports each of these as its
    // `schedule_display` — the field whose name claims it is already rendered.
    expect(humanCron('30 20 * * *')).toBe('8:30 PM daily');
    expect(humanCron('30 6 * * *')).toBe('6:30 AM daily');
    expect(humanCron('0 8 * * *')).toBe('8:00 AM daily');
    expect(humanCron('0 9 * * 1-5')).toBe('9:00 AM on weekdays');
    expect(humanCron('10 9 * * 1-5')).toBe('9:10 AM on weekdays');
  });
});

describe('humanCron — times of day', () => {
  it('handles noon and midnight, where 12-hour clocks trip', () => {
    expect(humanCron('0 0 * * *')).toBe('12:00 AM daily');
    expect(humanCron('0 12 * * *')).toBe('12:00 PM daily');
    expect(humanCron('59 23 * * *')).toBe('11:59 PM daily');
  });

  it('pads the minute', () => {
    expect(humanCron('5 7 * * *')).toBe('7:05 AM daily');
  });

  it('lists several times in one day', () => {
    expect(humanCron('0 8,20 * * *')).toBe('8:00 AM and 8:00 PM daily');
    expect(humanCron('0 6,12,18 * * *')).toBe('6:00 AM, 12:00 PM and 6:00 PM daily');
  });
});

describe('humanCron — days', () => {
  it('names a single weekday', () => {
    expect(humanCron('0 9 * * 1')).toBe('9:00 AM on Mondays');
    expect(humanCron('0 9 * * 0')).toBe('9:00 AM on Sundays');
  });

  it('treats 7 as Sunday, as some cron dialects do', () => {
    expect(humanCron('0 9 * * 7')).toBe('9:00 AM on Sundays');
  });

  it('recognises weekday and weekend ranges', () => {
    expect(humanCron('0 9 * * 1-5')).toBe('9:00 AM on weekdays');
    expect(humanCron('0 9 * * 0,6')).toBe('9:00 AM at weekends');
    expect(humanCron('0 9 * * 6,0')).toBe('9:00 AM at weekends');
  });

  it('lists a handful of days', () => {
    expect(humanCron('0 7 * * 1,3,5')).toBe('7:00 AM on Mon, Wed and Fri');
  });
});

describe('humanCron — other cadences', () => {
  it('reads sub-hour steps', () => {
    expect(humanCron('*/5 * * * *')).toBe('every 5 minutes');
    expect(humanCron('*/15 * * * *')).toBe('every 15 minutes');
    expect(humanCron('* * * * *')).toBe('every minute');
  });

  it('reads hourly', () => {
    expect(humanCron('0 * * * *')).toBe('hourly, on the hour');
    expect(humanCron('30 * * * *')).toBe('hourly at :30');
  });

  it('reads multi-hour steps', () => {
    expect(humanCron('0 */6 * * *')).toBe('every 6 hours');
    expect(humanCron('15 */4 * * *')).toBe('every 4 hours at :15');
  });

  it('reads monthly and annual', () => {
    expect(humanCron('0 9 1 * *')).toBe('9:00 AM on the 1st of each month');
    expect(humanCron('0 9 2 * *')).toBe('9:00 AM on the 2nd of each month');
    expect(humanCron('0 9 3 * *')).toBe('9:00 AM on the 3rd of each month');
    expect(humanCron('0 9 11 * *')).toBe('9:00 AM on the 11th of each month');
    expect(humanCron('0 9 21 * *')).toBe('9:00 AM on the 21st of each month');
    expect(humanCron('0 0 25 12 *')).toBe('12:00 AM on December 25');
  });
});

describe('humanCron — refuses rather than guesses', () => {
  it('rejects anything that is not five fields', () => {
    // Six fields is a seconds-first dialect; reading it as five would shift
    // every unit by one and produce a confident, wrong time.
    expect(humanCron('0 30 6 * * *')).toBeNull();
    expect(humanCron('30 6 * *')).toBeNull();
    expect(humanCron('')).toBeNull();
  });

  it('rejects macros it does not implement', () => {
    expect(humanCron('@daily')).toBeNull();
    expect(humanCron('@every 5m')).toBeNull();
  });

  it('rejects ranges and steps outside the handled cases', () => {
    expect(humanCron('0 9-17 * * *')).toBeNull();
    expect(humanCron('0 9 * * 1-3')).toBeNull();
    expect(humanCron('*/5 9 * * *')).toBeNull();
  });

  it('rejects day-of-month combined with day-of-week', () => {
    // Cron ORs these two fields, so "the 1st AND Mondays" is neither, and any
    // single phrase for it would mislead.
    expect(humanCron('0 9 1 * 1')).toBeNull();
  });

  it('rejects out-of-range values rather than wrapping them', () => {
    expect(humanCron('0 24 * * *')).toBeNull();
    expect(humanCron('60 9 * * *')).toBeNull();
    expect(humanCron('0 9 32 * *')).toBeNull();
    expect(humanCron('0 9 1 13 *')).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(humanCron(null)).toBeNull();
    expect(humanCron(undefined)).toBeNull();
  });
});

/**
 * The validator behind the create form's inline error.
 *
 * Its contract runs the opposite way to `humanCron`'s and matters just as
 * much: a false complaint blocks a schedule Hermes would have accepted, so
 * every exotic-but-real dialect form below must come back clean. The cases
 * that must be *caught* are the ones that used to save happily and then never
 * run.
 */
describe('cronError', () => {
  it('says nothing about an empty field', () => {
    // Not filled in yet is not the same as wrong; the submit button already
    // handles "nothing typed".
    expect(cronError('')).toBeNull();
    expect(cronError('   ')).toBeNull();
  });

  it('accepts the ordinary shapes', () => {
    for (const expr of [
      '0 9 * * *',
      '*/15 * * * *',
      '30 6 * * 1',
      '0 0 1 1 *',
      '0 9,17 * * 1-5',
      '0 */2 * * *',
      '15 14 1 * *',
      '0 22 * * 1-5',
      '5 0 * 8 *',
    ]) {
      expect(cronError(expr), expr).toBeNull();
    }
  });

  it('accepts both spellings of Sunday', () => {
    expect(cronError('0 9 * * 0')).toBeNull();
    expect(cronError('0 9 * * 7')).toBeNull();
  });

  it('accepts month and weekday names', () => {
    expect(cronError('0 9 * JAN *')).toBeNull();
    expect(cronError('0 9 * * mon-fri')).toBeNull();
  });

  it('accepts the known macros, and only those', () => {
    expect(cronError('@daily')).toBeNull();
    expect(cronError('@REBOOT')).toBeNull();
    expect(cronError('@fortnightly')).toMatch(/shorthand/);
  });

  it('accepts a six-field form rather than ruling on it', () => {
    // Seconds-first is a real dialect and the backend is the authority on
    // whether this scheduler takes it. Refusing here would block a job that
    // would have run.
    expect(cronError('0 0 9 * * *')).toBeNull();
  });

  it('waves through the dialect-specific characters', () => {
    // L, W, # and ? mean different things in different schedulers; checking
    // them here would be inventing a dialect.
    expect(cronError('0 9 L * *')).toBeNull();
    expect(cronError('0 9 ? * 6#3')).toBeNull();
    expect(cronError('0 9 15W * *')).toBeNull();
  });

  it('catches the wrong number of fields', () => {
    expect(cronError('0 9 * *')).toMatch(/5 fields/);
    expect(cronError('0 9 * * * * *')).toMatch(/5 fields/);
  });

  it('catches out-of-range values, naming the field', () => {
    expect(cronError('60 9 * * *')).toMatch(/minute/);
    expect(cronError('0 24 * * *')).toMatch(/hour/);
    expect(cronError('0 9 32 * *')).toMatch(/day of month/);
    expect(cronError('0 9 * 13 *')).toMatch(/month/);
    // The one that motivated this: a plausible typo for Sunday that no
    // scheduler will ever fire.
    expect(cronError('0 9 * * 8')).toMatch(/weekday/);
  });

  it('catches things that are not cron fields at all', () => {
    expect(cronError('every day at 9')).not.toBeNull();
    expect(cronError('0 9 * * abc')).not.toBeNull();
  });

  it('catches malformed steps and stray commas', () => {
    expect(cronError('*/0 * * * *')).toMatch(/step/);
    expect(cronError('*/a * * * *')).toMatch(/step/);
    expect(cronError('0 9,, * * *')).toMatch(/comma/);
  });
});
