/**
 * Run history for a script job, which the runs endpoint cannot supply.
 *
 * `/api/cron/jobs/<id>/runs` does not read a run log. It lists **sessions**
 * whose id is `cron_<job_id>_<timestamp>` — a job's history is the set of
 * conversations it opened. A `no_agent` job never opens one: the script *is*
 * the job, there is no model turn, so there is no session, so the endpoint
 * correctly returns zero runs for a job that has in fact run every weekday for
 * a month. Nothing about that is visible from the sheet, which said "No runs
 * recorded yet" — indistinguishable from a job that has never fired, and the
 * exact wrong conclusion.
 *
 * What those runs actually leave behind is a file per run under
 * `<hermes_home>/cron/output/<job_id>/`, written whether the script printed
 * anything or not (a silent run records `Status: silent (empty output)`, which
 * is itself the answer to "why have I not heard from this job"). So this reads
 * that directory through the same authenticated `/api/fs` routes the file
 * viewer uses.
 *
 * Rendered as preformatted text rather than markdown on purpose: these reports
 * are a handful of bold key-value lines, and reaching for `Markdown` here
 * would pull that chunk into the cron route's bundle to render a header.
 */
import { useState } from 'react';
import { useDirectory, useFileText } from '../../api/files';
import { SkeletonList, relTime } from '../shared/misc';
import type { CronJob } from '../../api/hub';

/**
 * Where a job's output lands. `hermes_home` is stamped on every job by the
 * merged list endpoint and is the profile's own home, so this addresses the
 * right store without the caller having to resolve the profile again.
 */
export function outputDir(job: CronJob): string | null {
  const home = typeof job.hermes_home === 'string' ? job.hermes_home : '';
  if (!home || !job.id) return null;
  return `${home.replace(/\/$/, '')}/cron/output/${job.id}`;
}

/**
 * `2026-08-25_09-11-02.md` → epoch seconds.
 *
 * The name is the only timestamp there is — the file's own mtime is not
 * exposed by `/api/fs/list`. Written by the scheduler in local time with no
 * zone, so it is parsed as local; getting this wrong shifts every row by the
 * UTC offset, which reads as "ran at 2am" for a job that runs at 9.
 */
export function runTime(name: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(at.getTime()) ? null : at.getTime() / 1000;
}

function RunBody({ path }: { path: string }) {
  const { data, isLoading, error } = useFileText(path);
  if (isLoading) return <SkeletonList n={1} h={40} />;
  if (error) {
    return (
      <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--error)' }}>
        Could not read this run.
      </div>
    );
  }
  return (
    <pre
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 'var(--type-body-sm)',
        color: 'var(--text-dim)',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        margin: '6px 0 0',
      }}
    >
      {data?.text?.trim()}
    </pre>
  );
}

export function ScriptRuns({ job }: { job: CronJob }) {
  const dir = outputDir(job);
  const { data, isLoading, error } = useDirectory(dir);
  const [open, setOpen] = useState<string | null>(null);

  if (isLoading) return <SkeletonList n={3} h={46} />;

  /* A directory that does not exist yet is a 404 here, and it means the job has
     genuinely not run — the scheduler creates it on the first run. Saying that
     plainly beats surfacing a filesystem error for an ordinary state. */
  if (error || !dir) {
    return (
      <div style={{ color: 'var(--text-faint)' }}>
        No output recorded yet — this job writes a file per run once it has fired.
      </div>
    );
  }

  const runs = (data?.entries ?? [])
    .filter((e) => !e.isDirectory && e.name.endsWith('.md'))
    .map((e) => ({ ...e, at: runTime(e.name) }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  if (runs.length === 0) {
    return <div style={{ color: 'var(--text-faint)' }}>No output recorded yet.</div>;
  }

  return (
    <div>
      <div style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', marginBottom: 8, lineHeight: 1.45 }}>
        This job runs a script, so it has no conversation to show — these are the
        run reports it writes to disk.
      </div>
      {runs.map((r) => (
        <div key={r.path} style={{ padding: '9px 0', borderBottom: '1px solid var(--border-soft)' }}>
          <button
            className="btn btn--ghost"
            style={{ width: '100%', justifyContent: 'space-between', padding: 0 }}
            onClick={() => setOpen(open === r.path ? null : r.path)}
          >
            <span style={{ fontSize: 'var(--type-detail)' }}>
              {r.at ? relTime(r.at) : r.name.replace(/\.md$/, '')}
            </span>
            <span style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)' }}>
              {open === r.path ? 'hide' : 'view'}
            </span>
          </button>
          {open === r.path && <RunBody path={r.path} />}
        </div>
      ))}
    </div>
  );
}
