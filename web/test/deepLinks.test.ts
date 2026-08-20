/**
 * Deep links, checked against both ends of the contract.
 *
 * A notification URL is written by the proxy and read by the app, in two
 * different languages, with no shared type between them — which is exactly how
 * `/chat?session=…` came to be sent by every push payload and read by nothing.
 * These tests parse the real server source for the URLs it emits and the real
 * screen source for the parameters it consumes, so the two cannot drift apart
 * again without something here failing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const chatScreen = read('src/screens/ChatScreen.tsx');
const cronTab = read('src/components/hub/CronTab.tsx');
const pushEvents = read('../server/src/push/events.ts');
const pushCron = read('../server/src/push/cron.ts');
const manifest = read('vite.config.ts');

/** Every `/path?param=` literal a source file hands to a client. */
function linkParams(source: string, path: string): Set<string> {
  const found = new Set<string>();
  const re = new RegExp(`['\`]${path.replace('/', '\\/')}\\?([a-z_]+)=`, 'g');
  for (const m of source.matchAll(re)) found.add(m[1]!);
  return found;
}

/** Every `params.get('x')` a screen reads. */
function readParams(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/(?:params|search)\.get\(['"]([a-zA-Z_]+)['"]\)/g)].map((m) => m[1]!),
  );
}

describe('what the proxy links to', () => {
  it('sends chat notifications with a session parameter', () => {
    expect(linkParams(pushEvents, '/chat')).toContain('session');
  });

  it('links cron feed entries at a conversation', () => {
    expect(linkParams(pushCron, '/chat')).toContain('session');
  });

  it('links a job that never ran at its own controls', () => {
    expect(linkParams(pushCron, '/cron')).toContain('job');
  });
});

describe('what the app reads', () => {
  const chatParams = readParams(chatScreen);

  /**
   * The regression this file exists for. Every push banner and every feed row
   * carries `session=`; before it was read, tapping one opened the chat screen
   * pointed at nothing in particular.
   */
  it('reads every parameter the proxy sends to /chat', () => {
    for (const param of linkParams(pushEvents, '/chat')) {
      expect(chatParams, `ChatScreen must read ?${param}=`).toContain(param);
    }
    for (const param of linkParams(pushCron, '/chat')) {
      expect(chatParams, `ChatScreen must read ?${param}=`).toContain(param);
    }
  });

  it('reads every parameter the proxy sends to /cron', () => {
    const cronParams = readParams(cronTab);
    for (const param of linkParams(pushCron, '/cron')) {
      expect(cronParams, `CronTab must read ?${param}=`).toContain(param);
    }
  });

  it('still reads the parameters the app itself navigates with', () => {
    expect(chatParams).toContain('resume');
    expect(chatParams).toContain('new');
  });

  /** The Android share sheet targets `/chat` with these three. */
  it('reads the share-target parameters the manifest declares', () => {
    const share = /share_target:[\s\S]*?params:\s*\{([^}]*)\}/.exec(manifest);
    expect(share).not.toBeNull();
    for (const [, name] of share![1]!.matchAll(/(\w+):\s*'(\w+)'/g)) {
      expect(chatParams, `ChatScreen must read ?${name}=`).toContain(name);
    }
  });
});

describe('manifest shortcuts', () => {
  const shortcuts = [...manifest.matchAll(/\{ name: '([^']+)'[^}]*url: '([^']+)'/g)].map(
    ([, name, url]) => ({ name: name!, url: url! }),
  );

  it('declares the shortcuts the app claims to have', () => {
    expect(shortcuts.length).toBeGreaterThan(0);
  });

  it('points every shortcut at a route the app actually has', () => {
    const routes = new Set(
      [...read('src/App.tsx').matchAll(/path="([^"]+)"/g)].map(([, p]) => p!),
    );
    for (const { url } of shortcuts) {
      expect(routes, `${url} must be a route`).toContain(new URL(url, 'http://x').pathname);
    }
  });

  /**
   * A shortcut whose parameters nothing reads is a menu entry that silently
   * does something other than what it says. `Voice` promised a new chat with
   * dictation running; nothing consumed `voice=1`, so it behaved exactly like
   * `New Chat`.
   */
  it('gives every shortcut parameter a reader', () => {
    for (const { name, url } of shortcuts) {
      const target = new URL(url, 'http://x');
      const readers = target.pathname === '/chat' ? readParams(chatScreen) : new Set<string>();
      for (const key of target.searchParams.keys()) {
        expect(readers, `the "${name}" shortcut sends ?${key}= and nothing reads it`).toContain(
          key,
        );
      }
    }
  });
});
