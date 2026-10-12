/**
 * Reading the Hermes checkout's commit for the "restart needed" check.
 *
 * Whatever it cannot read must come back null, never a guess: the health
 * route claims a restart is needed only when both commits are known and
 * differ, so a wrong answer here is a false alarm on every screen.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({ config: { HERMES_AGENT_DIR: '' } }));
const { checkoutCommit } = await import('../src/hermesCheckout.js');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-checkout-'));
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const git = (path: string, text: string) => writeFileSync(join(dir, '.git', path), text);

describe('checkoutCommit', () => {
  it('follows HEAD to a loose ref', () => {
    git('HEAD', 'ref: refs/heads/main\n');
    git('refs/heads/main', `${A}\n`);
    expect(checkoutCommit(dir)).toBe(A);
  });

  it('finds a ref that only exists packed', () => {
    git('HEAD', 'ref: refs/heads/main\n');
    git('packed-refs', `# pack-refs with: peeled\n${B} refs/heads/main\n`);
    expect(checkoutCommit(dir)).toBe(B);
  });

  it('reads a detached HEAD as the commit itself', () => {
    git('HEAD', `${A}\n`);
    expect(checkoutCommit(dir)).toBe(A);
  });

  it('is null when the ref cannot be found', () => {
    git('HEAD', 'ref: refs/heads/gone\n');
    expect(checkoutCommit(dir)).toBeNull();
  });

  it('is null for a directory that is not a checkout', () => {
    expect(checkoutCommit(join(dir, 'nowhere'))).toBeNull();
  });
});
