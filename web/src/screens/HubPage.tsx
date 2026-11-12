/**
 * Chrome for the screens that are one hub component each — Cron, Usage,
 * Settings — and the redirects for every path that moved.
 *
 * The former Hub tabs were a segmented control inside one screen, then each its
 * own drawer row. Five of them (Memory, Skills, Capabilities, Profiles,
 * Models) are tabs of the Agent screen now; the old paths redirect there via
 * `legacyTarget` below. The tab components are mounted as they were, with
 * two parameter changes forced by sharing the Agent screen's `?tab=`:
 * Capabilities' sections moved to `?section=`, and Models' Usage half became
 * the `/usage` route again.
 */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { MenuButton } from '../components/shared/MenuButton';
import { BackButton } from '../components/shared/BackButton';

export function HubPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="screen">
      <div className="header">
        <MenuButton />
        {/* Installed as a PWA the app runs in `display: standalone`, where iOS
            shows no browser chrome and offers no back gesture at all. The
            drawer still reaches everything, so these screens were never
            stranded — but without this there was no way to simply go back to
            wherever you came from. */}
        <BackButton />
        <div className="header__title">{title}</div>
      </div>
      <div className="scroll">{children}</div>
    </div>
  );
}

/**
 * The Agent screen's tabs, in order. Lives here rather than in
 * `AgentScreen.tsx` because the redirects below need it and this module is in
 * the boot graph — importing the screen for a list of five strings would pull
 * its chunk into every first paint.
 */
export const AGENT_TABS = [
  { id: 'memory', label: 'Memory' },
  { id: 'skills', label: 'Skills' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'models', label: 'Models' },
] as const;

export type AgentTab = (typeof AGENT_TABS)[number]['id'];

export function isAgentTab(value: string | null | undefined): value is AgentTab {
  return AGENT_TABS.some((t) => t.id === value);
}

/** Old top-level paths that are Agent tabs now. */
const AGENT_PATHS: Record<string, AgentTab> = {
  '/memory': 'memory',
  '/skills': 'skills',
  '/tools': 'capabilities',
  '/profiles': 'profiles',
  '/models': 'models',
};

/** `/hub?tab=` values, which predate both moves. */
const HUB_TABS: Record<string, string> = {
  memory: '/memory',
  skills: '/skills',
  tools: '/tools',
  capabilities: '/tools',
  profiles: '/profiles',
  models: '/models',
  usage: '/usage',
  cron: '/cron',
  settings: '/settings',
};

function agentUrl(tab: AgentTab, rest: URLSearchParams): string {
  const out = new URLSearchParams({ tab });
  for (const [k, v] of rest) if (k !== 'tab') out.append(k, v);
  return `/agent?${out.toString()}`;
}

/**
 * Where a path from before the Agent screen lands now.
 *
 * Pure, and the whole contract: these paths are in the slash-command table
 * (`useSlashRunner` maps `hub-<x>` to `/<x>`), in the "Set up a model" notice
 * (`/models?profile=`), in bookmarks and in `/hub?tab=` links older still.
 * Every query parameter rides along — `?profile=` is what makes the model
 * notice open on the right agent — except two that changed meaning:
 *
 * - `/tools?tab=mcp` — Capabilities kept its sections in `?tab=`, which is now
 *   the Agent screen's own; the section moved to `?section=`.
 * - `/models?tab=usage` — Usage was a section of Models and is its own
 *   destination again, so that link goes to `/usage`.
 */
export function legacyTarget(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');

  if (pathname === '/hub') {
    const to = (tab && HUB_TABS[tab]) || '/agent';
    params.delete('tab');
    return to === '/agent' ? '/agent' : legacyTarget(to, params.toString());
  }

  if (pathname === '/models' && tab === 'usage') return '/usage';

  const agentTab = AGENT_PATHS[pathname];
  if (!agentTab) return pathname;

  if (pathname === '/tools') {
    params.delete('tab');
    if (tab && !params.has('section')) params.set('section', tab);
  }
  return agentUrl(agentTab, params);
}

/**
 * Every retired path, and `/hub?tab=`. One component for all of them so the
 * mapping lives in `legacyTarget` and nowhere else.
 */
export function LegacyRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={legacyTarget(pathname, search)} replace />;
}

/** Kept under its old name for anything importing it. */
export const HubRedirect = LegacyRedirect;
