/**
 * Which profile a cron call addresses.
 *
 * This is the invisible-failure class the rest of the suite exists for. A job
 * created into the wrong profile looks completely normal on the screen that
 * created it — right name, right schedule, sitting in the list — and is wrong
 * only in that it runs as the wrong agent, or never runs at all because the
 * profile it landed in has none of the skills its prompt assumes. Nothing
 * reports that. The first sign is a scheduled run that quietly stopped being
 * useful.
 *
 * The per-job actions matter for a sharper reason. When the parameter is
 * missing Hermes resolves the job itself, by walking every profile's store and
 * matching on **id or name** (`_find_cron_job_profile` in `web_server.py`). Two
 * profiles each holding a `morning-brief` therefore resolve to whichever is
 * scanned first — so an unscoped delete can destroy the other profile's job.
 */
import { describe, it, expect } from 'vitest';
import { cronUrl } from '../src/api/hub';

describe('cronUrl', () => {
  it('leaves the path alone when no profile is named', () => {
    // Not the same as "no profile": the server's default differs per endpoint
    // — the list defaults to every profile, create to the active one — which
    // is exactly why callers must be explicit rather than relying on this.
    expect(cronUrl('/api/cron/jobs')).toBe('/api/cron/jobs');
    expect(cronUrl('/api/cron/jobs', undefined)).toBe('/api/cron/jobs');
    expect(cronUrl('/api/cron/jobs', null)).toBe('/api/cron/jobs');
    expect(cronUrl('/api/cron/jobs', '')).toBe('/api/cron/jobs');
  });

  it('appends the profile as a query parameter', () => {
    expect(cronUrl('/api/cron/jobs', 'research')).toBe('/api/cron/jobs?profile=research');
  });

  it('joins with & when the path already carries a query', () => {
    expect(cronUrl('/api/cron/jobs/x/runs?limit=20', 'research')).toBe(
      '/api/cron/jobs/x/runs?limit=20&profile=research',
    );
  });

  it('encodes a name that would otherwise break the query', () => {
    // Profile names are directory names, so this is defensive rather than
    // expected — but an unencoded `&` would silently address a different
    // profile, which is the failure this whole file is about.
    expect(cronUrl('/api/cron/jobs', 'a&b=c')).toBe('/api/cron/jobs?profile=a%26b%3Dc');
    expect(cronUrl('/api/cron/jobs', 'my profile')).toBe('/api/cron/jobs?profile=my%20profile');
  });

  it('does not mistake a profile named like a falsy value for none', () => {
    expect(cronUrl('/api/cron/jobs', '0')).toBe('/api/cron/jobs?profile=0');
  });

  it('scopes the per-job action routes, where the fallback is dangerous', () => {
    for (const action of ['pause', 'resume', 'trigger']) {
      expect(cronUrl(`/api/cron/jobs/morning-brief/${action}`, 'research')).toBe(
        `/api/cron/jobs/morning-brief/${action}?profile=research`,
      );
    }
  });
});
