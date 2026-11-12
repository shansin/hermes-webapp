/**
 * Reading checkpoints (`lib/checkpoints`).
 *
 * Two mappings that are wrong quietly: which file paths a single-file restore
 * can be handed (the `--stat` block abbreviates long ones with `...`, which
 * the backend would reject), and which checkpoint holds the files as they
 * were when a message was sent — the first one taken *after* it, since a
 * checkpoint is a snapshot from just before an agent edit.
 */
import { describe, expect, it } from 'vitest';
import { checkpointAtTime, checkpointLabel, diffFiles, diffSummary } from '../src/lib/checkpoints';

// Newest first, as `rollback.list` returns them.
const list = [
  { hash: 'c', timestamp: '2026-11-12T10:30:00+00:00', message: 'before patch' },
  { hash: 'b', timestamp: '2026-11-12T10:10:00+00:00', message: 'before terminal: npm i' },
  { hash: 'a', timestamp: '2026-11-12T09:00:00+00:00', message: 'before write_file' },
];
const at = (iso: string) => Date.parse(iso);

describe('checkpointAtTime', () => {
  it('picks the first checkpoint taken at or after the moment', () => {
    expect(checkpointAtTime(list, at('2026-11-12T10:00:00Z'))?.hash).toBe('b');
    expect(checkpointAtTime(list, at('2026-11-12T08:00:00Z'))?.hash).toBe('a');
    expect(checkpointAtTime(list, at('2026-11-12T10:10:00Z'))?.hash).toBe('b');
  });

  it('is null when nothing was checkpointed since', () => {
    expect(checkpointAtTime(list, at('2026-11-12T11:00:00Z'))).toBeNull();
  });

  it('skips a timestamp that does not parse', () => {
    expect(checkpointAtTime([{ timestamp: 'garbage' }], 0)).toBeNull();
  });
});

describe('diffFiles', () => {
  it('takes paths from the patch headers, including ones with spaces', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1..2 100644',
      'diff --git a/docs/my notes b/x.md b/docs/my notes b/x.md',
    ].join('\n');
    expect(diffFiles({ stat: '', diff })).toEqual(['src/app.ts', 'docs/my notes b/x.md']);
  });

  it('adds whole stat paths past the truncated patch, but not abbreviated ones', () => {
    const stat = [
      ' src/app.ts                   | 4 ++--',
      ' later.py                     | 12 ++++++++++++',
      ' .../very/long/path/file.ts   | 2 +-',
      ' image.png                    | Bin 0 -> 12 bytes',
      ' 4 files changed, 15 insertions(+), 3 deletions(-)',
    ].join('\n');
    expect(diffFiles({ stat, diff: 'diff --git a/src/app.ts b/src/app.ts' })).toEqual([
      'src/app.ts',
      'later.py',
      'image.png',
    ]);
    expect(diffSummary(stat)).toBe('4 files changed, 15 insertions(+), 3 deletions(-)');
  });
});

describe('checkpointLabel', () => {
  it('capitalises the reason and names an empty one', () => {
    expect(checkpointLabel('before write_file')).toBe('Before write_file');
    expect(checkpointLabel('  ')).toBe('Checkpoint');
  });
});
