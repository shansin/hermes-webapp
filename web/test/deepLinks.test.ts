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
const app = read('src/App.tsx');
const navDrawer = read('src/components/shared/NavDrawer.tsx');
const slashCommands = read('src/lib/slashCommands.ts');
const hubPage = read('src/screens/HubPage.tsx');
const cronTab = read('src/components/hub/CronTab.tsx');
const pushEvents = read('../server/src/push/events.ts');
const pushCron = read('../server/src/push/cron.ts');
const manifest = read('vite.config.ts');
const shareWorker = read('public/share-sw.js');
const shareRouter = read('../server/src/routers/share.ts');

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

});

/**
 * The share target, which is the same kind of contract spread even thinner:
 * the manifest declares field names, the service worker reads them out of a
 * multipart body, the server writes a different set into a query string, and
 * the chat screen reads that. Four files, three languages, no shared type —
 * and the whole path only runs on a phone, from a share sheet, in an installed
 * PWA, which is the worst possible place to discover a typo.
 */
describe('the share target', () => {
  const chatParams = readParams(chatScreen);
  const block = /share_target:\s*\{([\s\S]*?)\n        \},/.exec(manifest);

  it('declares one at all', () => {
    expect(block).not.toBeNull();
  });

  it('parses, so the assertions below are not vacuous', () => {
    expect(action).toBeTruthy();
    expect(textFields.length).toBeGreaterThan(0);
  });

  const declared = block?.[1] ?? '';
  const action = /action:\s*'([^']+)'/.exec(declared)?.[1] ?? '';
  const fileField = /files:\s*\[\s*\{\s*name:\s*'(\w+)'/.exec(declared)?.[1] ?? '';
  const textFields = [...declared.matchAll(/^\s+(title|text|url):\s*'(\w+)'/gm)].map((m) => m[2]!);

  /**
   * A GET share target cannot carry a file — the whole reason this stopped
   * pointing at `/chat` and grew a service worker.
   */
  it('posts, so a photo can come with it', () => {
    expect(/method:\s*'POST'/.test(declared)).toBe(true);
    expect(/enctype:\s*'multipart\/form-data'/.test(declared)).toBe(true);
    expect(fileField, 'share_target must declare a files field').toBeTruthy();
  });

  it('is intercepted by the worker at the path it declares', () => {
    expect(shareWorker).toContain(`pathname !== '${action}'`);
    expect(shareWorker).toContain("method !== 'POST'");
  });

  it('reads the file field out of the form under the name it declared', () => {
    expect(shareWorker, `share-sw.js must read form.getAll('${fileField}')`).toContain(
      `getAll('${fileField}')`,
    );
  });

  /**
   * The worker's own redirect. This is the link nothing else validates: it is
   * written in a file that gets no type checking and read by a screen that
   * would simply show an empty new chat if the name drifted.
   */
  it('redirects to a parameter the chat screen reads', () => {
    const target = /const target = new URL\(`([^`]+)`/.exec(shareWorker)?.[1] ?? '';
    expect(target).toContain('/chat');
    for (const [, name] of target.matchAll(/[?&](\w+)=/g)) {
      expect(chatParams, `ChatScreen must read ?${name}=`).toContain(name);
    }
  });

  /**
   * The no-worker fallback. It cannot carry the files, but dropping the text
   * as well would turn a shared link into a blank chat with no explanation.
   */
  it('has a server fallback that forwards every text field to a route', () => {
    expect(shareRouter, 'the server must answer the POST').toContain(
      `shareRouter.post('${action}'`,
    );
    for (const name of textFields) {
      expect(shareRouter, `the /share fallback must forward ${name}`).toContain(`'${name}'`);
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

/**
 * Screens that moved, and the links that did not.
 *
 * Usage became a section of Models and Capabilities arrived as a new route.
 * Both are the shape that breaks silently: a slash command, a `/hub?tab=` URL
 * or a bookmark keeps pointing at the old path, nothing throws, and you land
 * somewhere plausible instead of somewhere right — which is exactly how
 * `/chat?session=` came to be emitted by every push payload and read by
 * nothing (see above).
 */
describe('screens that moved', () => {
  it('keeps /usage as a route, pointing into the merged screen', () => {
    expect(app).toContain('path="/usage"');
    expect(app).toContain('/models?tab=usage');
  });

  it('no longer offers Usage as its own drawer destination', () => {
    expect(navDrawer).not.toContain("to: '/usage'");
    expect(navDrawer).toContain("to: '/models'");
  });

  /**
   * `useSlashRunner` maps every `hub-*` action to `/<rest>`, so a command whose
   * derived path has no route is a command that navigates nowhere.
   */
  it('gives every hub-* slash action a route to land on', () => {
    const actions = [...slashCommands.matchAll(/local\('hub-([a-z]+)'\)/g)].map((m) => m[1]);
    expect(actions.length).toBeGreaterThan(4);
    for (const action of actions) {
      expect(app).toContain(`path="/${action}"`);
    }
  });

  it('routes the Capabilities screen the drawer and /tools both point at', () => {
    expect(app).toContain('path="/tools"');
    expect(navDrawer).toContain("to: '/tools'");
    expect(slashCommands).toContain("local('hub-tools')");
  });

  it('still answers the old /hub?tab= links', () => {
    expect(hubPage).toContain("'usage'");
    expect(hubPage).toContain("'models'");
  });
});
