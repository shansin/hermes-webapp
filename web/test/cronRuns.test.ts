/**
 * What a cron run row says happened.
 *
 * Session rows carry no status field — every one of them used to print as the
 * bare word "run" — and "running" was Hermes' 300-second activity window,
 * which calls a long quiet run dead. File rows put their status in the title.
 */
import { describe, expect, it } from 'vitest';
import { fileRunName, isFileRun, runLabel, splitStatusTitle } from '../src/lib/cronRuns';

describe('runLabel on session rows', () => {
  it('calls a finished run completed', () => {
    expect(runLabel({ id: 'cron_j_1', ended_at: 10, end_reason: 'cron_complete' })).toEqual({ text: 'Completed', tone: 'ok' });
  });

  it('calls a run that ended on an error failed, and says why', () => {
    expect(runLabel({ id: 'cron_j_1', ended_at: 10, end_reason: 'agent_error' })).toMatchObject({
      text: 'Failed',
      tone: 'error',
      detail: 'agent_error',
    });
  });

  /** The case the activity window gets wrong: quiet for ten minutes, still fine. */
  it('calls a quiet run running while the scheduler still holds it', () => {
    expect(runLabel({ ended_at: null, is_active: false, scheduler_owned: true })).toMatchObject({ text: 'Running' });
  });

  it('calls an unfinished run nobody holds stopped', () => {
    expect(runLabel({ ended_at: null, is_active: false, scheduler_owned: false })).toMatchObject({
      text: 'Stopped responding',
      tone: 'warn',
    });
  });

  it('falls back to the activity window on a Hermes without scheduler_owned', () => {
    expect(runLabel({ ended_at: null, is_active: true }).text).toBe('Running');
    expect(runLabel({ ended_at: null, is_active: false }).text).toBe('Stopped responding');
  });
});

describe('runLabel on file rows', () => {
  const file = (title: string) => ({ id: 'cron_output:j:2026-10-09_09-10-44', source: 'cron_output', title });

  it('reads the status from the title', () => {
    expect(runLabel(file('COMPLETED · Synced 3 calendars'))).toEqual({
      text: 'Completed',
      tone: 'ok',
      detail: 'Synced 3 calendars',
    });
  });

  it('marks a failed run as an error', () => {
    expect(runLabel(file('FAILED · exit code 1')).tone).toBe('error');
  });

  it('says when a run completed without output', () => {
    expect(runLabel(file('COMPLETED · # Cron Job: x **Status:** silent (empty output)')).text).toBe('Completed, silent');
  });
});

describe('file rows', () => {
  it('are recognised by source or by id', () => {
    expect(isFileRun({ source: 'cron_output' })).toBe(true);
    expect(isFileRun({ id: 'cron_output:j:latest' })).toBe(true);
    expect(isFileRun({ id: 'cron_j_20261009' })).toBe(false);
  });

  it('name their report file', () => {
    expect(fileRunName({ id: 'cron_output:5ab2:2026-10-09_09-10-44' })).toBe('2026-10-09_09-10-44.md');
  });

  /** These come from the run log, not a file; there is nothing to open. */
  it('have no file for the run-log forms', () => {
    expect(fileRunName({ id: 'cron_output:5ab2:exec:0' })).toBeNull();
    expect(fileRunName({ id: 'cron_output:5ab2:latest' })).toBeNull();
  });

  it('split a title that has no status as all preview', () => {
    expect(splitStatusTitle('just text')).toEqual({ status: '', preview: 'just text' });
  });
});
