/**
 * Cron expressions, in words.
 *
 * Hermes sends a `schedule_display` field, and the name is a promise it does
 * not keep: the value is the expression echoed back — `30 6 * * *`, not
 * "6:30 AM daily". Both the Activity pane and the Cron screen trusted it as
 * pre-rendered text, so the line meant to explain a row was five numbers and
 * three asterisks.
 *
 * This translates the shapes people actually write. Anything it does not
 * recognise returns null and the caller shows the raw expression, which is the
 * important half of the contract: a schedule guessed wrong is worse than one
 * left cryptic, because a wrong one gets believed. There is no partial
 * rendering and no "approximately" — either the expression is understood
 * completely or it is passed through untouched.
 *
 * Standard five-field cron only (minute hour day-of-month month day-of-week).
 * Six-field forms carrying seconds, `@daily` macros and anything with step or
 * range syntax outside the handled cases all fall through to null rather than
 * being half-read.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `14` → `2:00 PM`. Hour and minute must already be plain integers. */
function clock(hour: number, minute: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** An integer in range, or null. Rejects `*`, steps, ranges and lists. */
function int(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
}

/** `1,3,5` → [1,3,5]. Null if any element is not a plain integer in range. */
function intList(field: string, min: number, max: number): number[] | null {
  const parts = field.split(',');
  const out: number[] = [];
  for (const p of parts) {
    const n = int(p, min, max);
    if (n === null) return null;
    out.push(n);
  }
  return out.length ? out : null;
}

// A step over the whole range: the slash form, e.g. slash-15 -> 15. Written
// as a line comment because the step syntax itself would close a block one.
function step(field: string): number | null {
  const m = /^\*\/(\d{1,2})$/.exec(field);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 1 ? n : null;
}

/** The day-of-week field in words, or null when it is not a plain set. */
function weekdayPhrase(dow: string): string | null {
  if (dow === '*') return null; // "every day" — the caller says `daily`

  // Ranges people actually write. 7 is Sunday in some cron dialects.
  if (dow === '1-5') return 'on weekdays';
  if (dow === '0,6' || dow === '6,0' || dow === '0,7' || dow === '6-7') return 'at weekends';

  const days = intList(dow, 0, 7);
  if (!days) return null;
  const names = days.map((d) => DAYS_SHORT[d === 7 ? 0 : d]!);
  const unique = [...new Set(names)];
  if (unique.length === 1) {
    const full = DAYS[days[0] === 7 ? 0 : days[0]!]!;
    return `on ${full}s`;
  }
  const last = unique.pop()!;
  return `on ${unique.join(', ')} and ${last}`;
}

/**
 * @returns a human phrase, or null when the expression is not one of the
 *   handled shapes — in which case show the raw expression rather than a guess.
 */
export function humanCron(expr: string | null | undefined): string | null {
  if (typeof expr !== 'string') return null;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];

  // Sub-hour cadences. Only when nothing else is constrained: `*/5 9 * * *`
  // means "every five minutes during the 9am hour", which is a different
  // sentence and not worth a special case.
  if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const everyMin = step(minute);
    if (everyMin) return `every ${everyMin} minutes`;
    if (minute === '*') return 'every minute';
    const at = int(minute, 0, 59);
    if (at !== null) return at === 0 ? 'hourly, on the hour' : `hourly at :${String(at).padStart(2, '0')}`;
    return null;
  }

  // Every N hours, at a fixed minute.
  if (dom === '*' && month === '*' && dow === '*') {
    const everyHour = step(hour);
    const at = int(minute, 0, 59);
    if (everyHour && at !== null) {
      return at === 0
        ? `every ${everyHour} hours`
        : `every ${everyHour} hours at :${String(at).padStart(2, '0')}`;
    }
  }

  const at = int(minute, 0, 59);
  if (at === null) return null;

  // One or more fixed times of day.
  const hours = intList(hour, 0, 23);
  if (!hours) return null;
  const times = hours.map((h) => clock(h, at));
  const timePhrase =
    times.length === 1
      ? times[0]!
      : `${times.slice(0, -1).join(', ')} and ${times[times.length - 1]!}`;

  // A specific month makes it annual; a day-of-month makes it monthly. Both
  // only read correctly when the day-of-week is unconstrained.
  if (month !== '*' && dow === '*') {
    const m = int(month, 1, 12);
    const d = int(dom, 1, 31);
    if (m !== null && d !== null) return `${timePhrase} on ${MONTHS[m - 1]} ${d}`;
    return null;
  }

  if (dom !== '*' && month === '*' && dow === '*') {
    const d = int(dom, 1, 31);
    if (d === null) return null;
    return `${timePhrase} on the ${ordinal(d)} of each month`;
  }

  if (dom !== '*') return null; // day-of-month AND day-of-week: cron ORs these

  if (month !== '*') return null;

  const days = weekdayPhrase(dow);
  if (dow === '*') return `${timePhrase} daily`;
  return days ? `${timePhrase} ${days}` : null;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
