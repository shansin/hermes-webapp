/**
 * Reading a cron job's run history rows.
 *
 * `/api/cron/jobs/<id>/runs` answers with two kinds of row since Hermes
 * 0.21.6, and they say different things in different fields:
 *
 *  - **Session rows** — the conversation a run opened (`cron_<job>_<ts>`). No
 *    status field at all: whether it finished is `ended_at`, how is
 *    `end_reason`, and whether an unfinished one is still alive is the new
 *    `scheduler_owned`. The sheet used to print `row.status ?? 'run'`, which
 *    for every one of these was the bare word "run".
 *  - **File rows** (`source: "cron_output"`) — built from the report a run
 *    writes under `cron/output/<job>/`, which is the only record a script
 *    job's run leaves. Their status is the first word of the title
 *    (`COMPLETED · <preview>`), and their id names the file.
 *
 * `scheduler_owned` is what makes "running" honest. Hermes' own `is_active`
 * is a 300-second activity window, so a long run that goes quiet — a slow
 * model, a long tool call — reads as dead while it is fine. The scheduler
 * holding the run is the real answer, and it is the field that tells the two
 * apart.
 */

export type RunTone = 'ok' | 'running' | 'warn' | 'error';

export interface RunLabel {
  text: string;
  tone: RunTone;
  /** The rest of a file row's title, or a session row's failure reason. */
  detail?: string;
}

type Row = Record<string, unknown>;

/** Same markers `server/src/push/cron.ts` treats as a run that did not deliver. */
const FAILURE_MARKERS = ['error', 'fail', 'timeout', 'cancel', 'interrupt', 'abort'];

export function isFileRun(row: Row): boolean {
  return row.source === 'cron_output' || (typeof row.id === 'string' && row.id.startsWith('cron_output:'));
}

/** `COMPLETED · Synced 3 calendars` → status word and the preview after it. */
export function splitStatusTitle(title: string): { status: string; preview: string } {
  const at = title.indexOf(' · ');
  if (at < 0) return { status: '', preview: title };
  return { status: title.slice(0, at).trim(), preview: title.slice(at + 3).trim() };
}

function sentenceCase(word: string): string {
  const lower = word.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function runLabel(row: Row): RunLabel {
  if (isFileRun(row)) {
    const { status, preview } = splitStatusTitle(typeof row.title === 'string' ? row.title : '');
    // A script that printed nothing is a run that worked and had nothing to
    // say — the answer to "why have I not heard from this job".
    const silent = /status:\*{0,2}\s*silent/i.test(preview);
    const failed = /fail|error/i.test(status);
    return {
      text: silent ? 'Completed, silent' : status ? sentenceCase(status) : 'Run',
      tone: failed ? 'error' : 'ok',
      detail: preview || undefined,
    };
  }

  if (row.ended_at == null) {
    if (row.scheduler_owned === true || (row.scheduler_owned == null && row.is_active === true)) {
      return { text: 'Running', tone: 'running' };
    }
    // Not finished, not held by the scheduler, not active: the process that
    // ran it is gone. Older Hermes has no `scheduler_owned`, and there the
    // activity window is the only signal available.
    return { text: 'Stopped responding', tone: 'warn' };
  }

  const reason = typeof row.end_reason === 'string' ? row.end_reason : '';
  if (reason && FAILURE_MARKERS.some((m) => reason.toLowerCase().includes(m))) {
    return { text: 'Failed', tone: 'error', detail: reason };
  }
  const status = typeof row.status === 'string' ? row.status : typeof row.outcome === 'string' ? row.outcome : '';
  return { text: status ? sentenceCase(status) : 'Completed', tone: 'ok' };
}

/**
 * The report file a file row was read from, relative to the job's output
 * directory. `cron_output:<job>:<stem>` names one; the `exec:<n>` and `latest`
 * forms come from the run log and have no file of their own.
 */
export function fileRunName(row: Row): string | null {
  if (typeof row.id !== 'string') return null;
  const m = /^cron_output:[^:]+:(.+)$/.exec(row.id);
  if (!m) return null;
  const stem = m[1]!;
  if (stem === 'latest' || stem.startsWith('exec:')) return null;
  return `${stem}.md`;
}

/** Epoch seconds a row ran at, whichever field it carries. */
export function runStartedAt(row: Row): number | null {
  for (const key of ['started_at', 'created_at', 'ended_at']) {
    const v = row[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}
