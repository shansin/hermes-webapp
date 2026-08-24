/**
 * What the agent can do: toolsets, MCP servers, and Hermes' own config.
 *
 * Its own module rather than more of `hub.ts`, which is already five domains
 * long. The three here belong together — each one answers "what is this agent
 * able to reach?" — and they are the settings that, until now, needed a
 * terminal.
 *
 * Every one of these endpoints takes an optional `profile`, and the calls below
 * leave it off **when they are serving the Capabilities screen**. That is
 * deliberate and it matches the rest of the app: skills, cron, memory and
 * models all address the active profile implicitly, and `useSwitchProfile`
 * invalidates the whole query cache precisely so that they can. A profile
 * argument there would make this the one screen whose idea of "current"
 * differed from every other.
 *
 * `useToolsets` takes one anyway, for the other case: *configuring* a profile
 * you are not running as. Pinning toolsets onto a cron job that belongs to
 * `research` has to offer research's sets — which differ from the active
 * profile's not only in what is switched on but in what is available at all,
 * since a set can hold credentials in one profile and none in another.
 *
 * Shapes were captured from the live backend (Hermes 0.20.4) rather than from
 * its OpenAPI document, which types these as untyped dicts. Interfaces are
 * permissive in the usual way — unknown fields pass through, because the next
 * Hermes will add some.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export const toolKeys = {
  toolsets: ['tools', 'toolsets'] as const,
  mcpServers: ['tools', 'mcp', 'servers'] as const,
  mcpCatalog: ['tools', 'mcp', 'catalog'] as const,
  config: ['tools', 'config'] as const,
};

// --- toolsets ----------------------------------------------------------------

export interface Toolset {
  name: string;
  label: string;
  /** The tool names this set provides, as one comma-joined line. */
  description: string;
  /** `cli`, `discord`, … — what the set belongs to. Used to group the list. */
  platform: string;
  platform_label: string;
  enabled: boolean;
  /**
   * Whether Hermes can run it at all, as opposed to whether it is switched on.
   * The two happen to agree on a stock install, and they are still not the same
   * question — a set can be unavailable for a reason the toggle cannot fix.
   */
  available: boolean;
  /** False when it needs credentials it does not have. */
  configured: boolean;
  tools: string[];
  [k: string]: unknown;
}

/**
 * @param profile read another profile's toolsets instead of the active one.
 *   Same argument as `useSkills`: a cron job pinned to the `research` profile
 *   has to be configured against research's sets, and which sets are even
 *   *available* differs per profile — a set can be unconfigured in one and
 *   ready in another.
 *
 * @param enabled hold the request back until it is actually needed.
 *
 * Unscoped callers keep the original key, and prefix invalidation from the
 * toggle mutations still reaches the scoped copies.
 */
export function useToolsets(profile?: string | null, enabled = true) {
  return useQuery({
    queryKey: profile ? [...toolKeys.toolsets, profile] : toolKeys.toolsets,
    queryFn: () =>
      api.get<Toolset[]>(
        profile ? `/api/tools/toolsets?profile=${encodeURIComponent(profile)}` : '/api/tools/toolsets',
      ),
    staleTime: 30_000,
    enabled,
  });
}

export function useToggleToolset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      api.put(`/api/tools/toolsets/${encodeURIComponent(name)}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.toolsets }),
  });
}

// --- MCP servers -------------------------------------------------------------

export interface McpServer {
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  auth: string | null;
  enabled: boolean;
  /** Null until something has connected and enumerated them. */
  tools: string[] | null;
  [k: string]: unknown;
}

export function useMcpServers() {
  return useQuery({
    queryKey: toolKeys.mcpServers,
    queryFn: async () => (await api.get<{ servers: McpServer[] }>('/api/mcp/servers')).servers,
    staleTime: 30_000,
  });
}

export function useToggleMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      api.put(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.mcpServers }),
  });
}

export function useDeleteMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.del(`/api/mcp/servers/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.mcpServers }),
  });
}

/** Reachability, reported back to the caller rather than cached. */
export function useTestMcpServer() {
  return useMutation({
    mutationFn: (name: string) =>
      api.post<{ ok?: boolean; error?: string; tools?: string[]; [k: string]: unknown }>(
        `/api/mcp/servers/${encodeURIComponent(name)}/test`,
        {},
      ),
  });
}

export interface McpCatalogEntry {
  name: string;
  description: string;
  source: string | null;
  transport: string;
  /** `oauth` for most of the catalog — see `post_install`. */
  auth_type: string;
  required_env: string[];
  url: string | null;
  command: string | null;
  args: string[];
  /**
   * What still has to happen after installing — for an `oauth` entry that is a
   * browser login this app cannot perform, so it is shown rather than hidden
   * behind a button that would dead-end.
   */
  post_install: string | null;
  needs_install: boolean;
  installed: boolean;
  enabled: boolean;
  [k: string]: unknown;
}

export function useMcpCatalog(enabled: boolean) {
  return useQuery({
    queryKey: toolKeys.mcpCatalog,
    enabled,
    // The catalog is a shipped list, not live state.
    staleTime: 10 * 60_000,
    queryFn: async () =>
      (await api.get<{ entries: McpCatalogEntry[] }>('/api/mcp/catalog')).entries,
  });
}

export function useInstallMcpCatalogEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post('/api/mcp/catalog/install', { name, enable: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: toolKeys.mcpServers });
      void qc.invalidateQueries({ queryKey: toolKeys.mcpCatalog });
    },
  });
}

// --- Hermes config -----------------------------------------------------------

/**
 * The whole of `~/.hermes/config.yaml`, read-only here.
 *
 * Ninety top-level keys, several of which nest sixty deep in their own right,
 * and seven of the leaves are live credentials. That combination is why this
 * screen shows the config rather than editing it: a mistyped value on a phone
 * can stop the agent starting, with no undo and nothing validating it until it
 * fails. Reading it answers the question anyone actually has away from their
 * desk — *what is this set to?* — at none of that risk.
 */
export function useHermesConfig(enabled: boolean) {
  return useQuery({
    queryKey: toolKeys.config,
    enabled,
    queryFn: () => api.get<Record<string, unknown>>('/api/config'),
    staleTime: 60_000,
  });
}
