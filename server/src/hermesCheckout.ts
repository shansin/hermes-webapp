/**
 * Which Hermes commit is on disk, so `/healthz` can say the backend needs a
 * restart.
 *
 * `hermes update` rewrites the checkout under a running backend. Until that
 * backend restarts it keeps serving the code it booted from, while new
 * subprocesses, cron runs and the messaging gateway pick up the new one — and
 * newer Hermes refuses some writes outright with `503 Restart required` when
 * it notices the skew. `/api/health` reports the booted commit; the checkout's
 * HEAD is the other half, and the proxy is the one piece of this app that can
 * read it, because it runs on the same machine.
 *
 * Read from `.git` directly rather than by spawning `git`: this runs on a
 * health poll, and the three file reads a loose or packed ref needs are
 * cheaper than a process. Anything unexpected — a worktree's `.git` file, a
 * missing ref, a non-git install — answers null, which the health route reads
 * as "cannot tell" and never as a mismatch.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { config } from './config.js';

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

export function checkoutCommit(dir = config.HERMES_AGENT_DIR || join(homedir(), '.hermes', 'hermes-agent')): string | null {
  const gitDir = join(dir, '.git');
  const head = read(join(gitDir, 'HEAD'));
  if (!head) return null;
  if (/^[0-9a-f]{40}$/.test(head)) return head;

  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!ref) return null;
  const loose = read(join(gitDir, ref));
  if (loose && /^[0-9a-f]{40}$/.test(loose)) return loose;

  for (const line of (read(join(gitDir, 'packed-refs')) ?? '').split('\n')) {
    const [sha, name] = line.split(' ');
    if (name === ref && sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
}
