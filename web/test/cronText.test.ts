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
import { humanCron } from '../src/lib/cronText';

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
