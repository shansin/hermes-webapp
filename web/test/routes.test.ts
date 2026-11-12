/**
 * Every path the app has ever handed out, against the routes it has now.
 *
 * The drawer went from thirteen rows to ten and five screens became tabs of
 * Agent. None of the old paths could simply go: the proxy writes `/cron?job=`
 * into push payloads and feed rows that sit on a phone for weeks, slash
 * commands map `hub-<x>` to `/<x>`, the "Set up a model" notice links
 * `/models?profile=`, and bookmarks hold all of it. A path that stops
 * resolving does not throw — the catch-all route quietly lands you on chat —
 * so these are checked rather than trusted.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AGENT_TABS, isAgentTab, legacyTarget } from '../src/screens/HubPage';
import { menuLabel } from '../src/components/shared/MenuButton';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const app = read('src/App.tsx');
const routes = new Set([...app.matchAll(/path="([^"]+)"/g)].map(([, p]) => p!));

const landing = (url: string) => {
  const u = new URL(url, 'http://x');
  return legacyTarget(u.pathname, u.search);
};

describe('where the old paths land', () => {
  it('sends each former drawer row to its Agent tab', () => {
    expect(landing('/memory')).toBe('/agent?tab=memory');
    expect(landing('/skills')).toBe('/agent?tab=skills');
    expect(landing('/tools')).toBe('/agent?tab=capabilities');
    expect(landing('/profiles')).toBe('/agent?tab=profiles');
    expect(landing('/models')).toBe('/agent?tab=models');
  });

  /* The "Set up a model" notice opens Models on the conversation's profile;
     dropping the parameter on the way would scope it to the active one. */
  it('carries the query along', () => {
    expect(landing('/models?profile=research')).toBe('/agent?tab=models&profile=research');
    expect(landing('/skills?profile=a&q=web')).toBe('/agent?tab=skills&profile=a&q=web');
  });

  /* Capabilities kept its sections in `?tab=`, which the Agent screen owns
     now; the section has to move to `?section=` rather than be read as an
     Agent tab that does not exist. */
  it('renames Capabilities’ own tab parameter', () => {
    expect(landing('/tools?tab=mcp')).toBe('/agent?tab=capabilities&section=mcp');
    expect(landing('/tools?tab=config')).toBe('/agent?tab=capabilities&section=config');
  });

  it('sends the Usage half of the old Models screen to Usage', () => {
    expect(landing('/models?tab=usage')).toBe('/usage');
  });

  it('answers /hub?tab= for every tab it ever had', () => {
    expect(landing('/hub?tab=memory')).toBe('/agent?tab=memory');
    expect(landing('/hub?tab=models')).toBe('/agent?tab=models');
    expect(landing('/hub?tab=tools')).toBe('/agent?tab=capabilities');
    expect(landing('/hub?tab=usage')).toBe('/usage');
    expect(landing('/hub?tab=cron')).toBe('/cron');
    expect(landing('/hub?tab=settings')).toBe('/settings');
    expect(landing('/hub')).toBe('/agent');
    expect(landing('/hub?tab=nonsense')).toBe('/agent');
  });

  it('only ever lands on a route that exists, on a real Agent tab', () => {
    for (const from of ['/memory', '/skills', '/tools?tab=mcp', '/profiles', '/models?tab=usage', '/hub?tab=cron']) {
      const to = new URL(landing(from), 'http://x');
      expect(routes, `${from} → ${to.pathname}`).toContain(to.pathname);
      if (to.pathname === '/agent') expect(isAgentTab(to.searchParams.get('tab'))).toBe(true);
    }
  });

  it('routes every former path, so the redirect gets a chance to run', () => {
    for (const p of ['/memory', '/skills', '/tools', '/profiles', '/models', '/hub', '/cron', '/usage', '/settings']) {
      expect(routes).toContain(p);
    }
  });

  it('keeps the five tabs the drawer row promises', () => {
    expect(AGENT_TABS.map((t) => t.id)).toEqual(['memory', 'skills', 'capabilities', 'profiles', 'models']);
  });
});

/**
 * Every app path the proxy writes into a notification or a feed row — read
 * out of the real server source, so a new writer is covered the day it lands.
 */
describe('what the proxy links to', () => {
  const pushDir = resolve(__dirname, '../../server/src/push');
  const sources = readdirSync(pushDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => readFileSync(resolve(pushDir, f), 'utf8'));
  const paths = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(/(?:url|to|Url)\s*[:=]\s*[`'"](\/[a-z][a-z-]*)/g)) paths.add(m[1]!);
    for (const m of src.matchAll(/[`'"](\/(?:chat|cron|kanban|notifications|settings|activity))[?`'"]/g))
      paths.add(m[1]!);
  }

  it('finds the links, so the check below is not vacuous', () => {
    for (const p of ['/chat', '/cron', '/kanban', '/notifications', '/settings']) expect(paths).toContain(p);
  });

  it('points every one at a route the app still has', () => {
    for (const p of paths) {
      if (p.startsWith('/api') || p.startsWith('/push')) continue;
      expect(routes, `${p} is linked from server/src/push but has no route`).toContain(p);
    }
  });

  /* A needs-you pairing row leads to the screen that owns the controls. */
  it('gives the Machine screen the route Activity links into', () => {
    expect(routes).toContain('/machine');
    expect(app).toContain("import('./screens/MachineScreen')");
  });
});

describe('the hamburger’s accessible name', () => {
  it('names whichever counts are non-zero, asks first', () => {
    expect(menuLabel(0, 0)).toBe('Open menu');
    expect(menuLabel(3, 0)).toBe('Open menu — 3 unread updates');
    expect(menuLabel(0, 1)).toBe('Open menu — 1 needs you');
    expect(menuLabel(1, 2)).toBe('Open menu — 2 need you, 1 unread update');
  });
});
