/**
 * Reading checkpoints: which files a diff touches, and which checkpoint
 * belongs to a turn. Pure, for `CheckpointsSheet` and its tests; the wire
 * facts behind both are on `api/checkpoints.ts`.
 */

/** Epoch ms of a checkpoint's ISO timestamp, or null when it does not parse. */
export function checkpointTime(timestamp: string): number | null {
  const t = Date.parse(timestamp);
  return Number.isFinite(t) ? t : null;
}

/**
 * The checkpoint that holds the files as they were at time `t`.
 *
 * A checkpoint is taken just *before* an agent edit, so the state at `t` is
 * whatever the first checkpoint taken at or after `t` captured — the agent had
 * changed nothing in between. Null when nothing was checkpointed since `t`
 * (the agent has not edited anything since, or retention pruned it). The list
 * is newest first, as `rollback.list` returns it.
 */
export function checkpointAtTime<C extends { timestamp: string }>(
  checkpoints: readonly C[],
  t: number,
): C | null {
  let found: C | null = null;
  for (const c of checkpoints) {
    const at = checkpointTime(c.timestamp);
    if (at != null && at >= t) found = c;
  }
  return found;
}

/**
 * The files a `rollback.diff` covers, as paths relative to the cwd — what
 * `rollback.restore {file_path}` takes.
 *
 * Read from the `diff --git a/X b/X` headers first: the `--stat` block
 * abbreviates long paths with `...`, which is no use as a restore target. The
 * patch is truncated at 4000 characters, though, so a file whose header fell
 * past the cut is taken from the stat when its path there is whole.
 */
export function diffFiles(diff: { stat: string; diff: string }): string[] {
  const files: string[] = [];
  const add = (p: string) => {
    if (p && !files.includes(p)) files.push(p);
  };

  for (const line of diff.diff.split('\n')) {
    if (!line.startsWith('diff --git a/')) continue;
    const rest = line.slice('diff --git a/'.length);
    // `<p> b/<p>`: for an unrenamed file both halves are the same path, so
    // its length pins the split even when the path contains " b/".
    const len = (rest.length - 3) / 2;
    if (Number.isInteger(len) && rest.slice(len, len + 3) === ' b/' && rest.slice(0, len) === rest.slice(len + 3)) {
      add(rest.slice(0, len));
    } else {
      const m = / b\/(.+)$/.exec(rest);
      if (m) add(m[1]!);
    }
  }

  for (const line of diff.stat.split('\n')) {
    const m = /^\s*(.+?)\s+\|\s+(?:\d+|Bin)/.exec(line);
    if (m && !m[1]!.includes('...')) add(m[1]!.trim());
  }
  return files;
}

/** The stat's closing summary ("3 files changed, 10 insertions(+)"), if any. */
export function diffSummary(stat: string): string {
  const last = stat.trim().split('\n').at(-1)?.trim() ?? '';
  return /\bfiles? changed\b/.test(last) ? last : '';
}

/** A row's label: the manager's reason ("before write_file"), capitalised. */
export function checkpointLabel(message: string): string {
  const m = message.trim();
  return m ? m[0]!.toUpperCase() + m.slice(1) : 'Checkpoint';
}
