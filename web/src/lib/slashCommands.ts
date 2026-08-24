/**
 * The slash-command spec table — the one place that decides how this app
 * fulfils a command the user types.
 *
 * Hermes implements slash commands server-side; the gateway exposes them as
 * `commands.catalog` (discovery), `complete.slash` (completion) and
 * `slash.exec` / `command.dispatch` (execution). What a *client* has to decide
 * is which of them it handles itself, which it forwards, and which it refuses.
 *
 * Every command falls into one of four surfaces:
 *
 *  - `local`       — this app already has a better screen for it. `/model`
 *                    opens the model sheet; `/skills` opens the Skills page. Sending
 *                    these to the backend would print a terminal-shaped answer
 *                    on a phone.
 *  - `rpc`         — a dedicated gateway method exists. Prefer it over
 *                    `slash.exec`: the response is structured, and `/compress`
 *                    in particular outruns the slash worker's 45s pipe timeout
 *                    on a long session.
 *  - `exec`        — run on the backend, render the text output inline. This is
 *                    also the default for anything *not* in this table, which is
 *                    how skill commands and user quick commands keep working
 *                    without being enumerated here.
 *  - `unavailable` — a real Hermes command with genuinely no phone surface
 *                    (terminal chrome, messaging-only, desktop overlays). We
 *                    say why instead of executing something that can't work.
 *
 * Modelled on `apps/desktop/src/lib/desktop-slash-commands.ts` in hermes-agent,
 * which solves the same problem for the desktop client.
 */

/** A command this app fulfils itself. One id ↔ one handler in the runner. */
export type LocalActionId =
  | 'new'
  | 'sessions'
  | 'model'
  | 'context'
  | 'kanban'
  | 'notifications'
  | 'help'
  | 'hub-memory'
  | 'hub-skills'
  | 'hub-cron'
  | 'hub-models'
  | 'hub-tools'
  | 'hub-usage'
  | 'hub-settings';

/** Why a known Hermes command has no phone surface. */
export type UnavailableReason = 'terminal' | 'messaging' | 'desktop';

export interface CommandCtx {
  sessionId: string;
  /** Everything after the command token, trimmed. */
  arg: string;
  /** Canonical command, leading slash included. */
  name: string;
}

export type CommandSurface =
  | { kind: 'local'; action: LocalActionId }
  | {
      kind: 'rpc';
      rpc: string;
      buildParams: (ctx: CommandCtx) => Record<string, unknown>;
      /** Turn the RPC result into transcript text. */
      render?: (result: unknown, ctx: CommandCtx) => string;
    }
  | { kind: 'exec' }
  | { kind: 'unavailable'; reason: UnavailableReason };

/** How the composer should treat text following the command token. */
export type ArgumentMode = 'options' | 'text' | 'mixed';

export interface CommandSpec {
  /** Canonical command, leading slash included. */
  name: string;
  /** Overrides the backend catalog description where ours is more accurate. */
  description?: string;
  aliases?: string[];
  surface: CommandSurface;
  argumentMode?: ArgumentMode;
  /** Executes when typed, but stays out of the palette and the popover. */
  hidden?: boolean;
}

const local = (action: LocalActionId): CommandSurface => ({ kind: 'local', action });
const exec = (): CommandSurface => ({ kind: 'exec' });
const unavailable = (reason: UnavailableReason): CommandSurface => ({ kind: 'unavailable', reason });
const rpc = (
  name: string,
  buildParams: (ctx: CommandCtx) => Record<string, unknown>,
  render?: (result: unknown, ctx: CommandCtx) => string,
): CommandSurface => ({ kind: 'rpc', rpc: name, buildParams, render });

/** Pull a number out of a loosely-typed RPC result. */
const num = (result: unknown, key: string): number | undefined => {
  const v = (result as Record<string, unknown> | null)?.[key];
  return typeof v === 'number' ? v : undefined;
};

const str = (result: unknown, key: string): string => {
  const v = (result as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v : '';
};

const SPECS: readonly CommandSpec[] = [
  // --- handled in-app ---------------------------------------------------
  {
    name: '/new',
    description: 'Start a fresh chat',
    aliases: ['/clear', '/reset'],
    surface: local('new'),
  },
  {
    name: '/resume',
    description: 'Browse and reopen a saved session',
    aliases: ['/sessions', '/switch'],
    surface: local('sessions'),
  },
  { name: '/model', description: 'Switch the model for this chat', surface: local('model') },
  { name: '/context', description: 'Show what is filling the context window', surface: local('context') },
  { name: '/kanban', description: 'Open the task board', surface: local('kanban') },
  { name: '/memory', description: 'Edit agent memory', surface: local('hub-memory') },
  { name: '/skills', description: 'Browse and toggle skills', surface: local('hub-skills') },
  { name: '/cron', description: 'Manage scheduled jobs', surface: local('hub-cron') },
  {
    name: '/notifications',
    description: 'What scheduled jobs did while you were away',
    surface: local('notifications'),
  },
  { name: '/models', description: 'Default model, and where the tokens went', surface: local('hub-models') },
  {
    // Was `exec`, which printed a terminal-shaped table into a phone
    // transcript — the exact thing the `local` surface exists to prevent.
    name: '/tools',
    description: 'Toolsets, MCP servers and config',
    aliases: ['/mcp'],
    surface: local('hub-tools'),
  },
  {
    name: '/usage',
    description: 'Tokens, models and machinery over time',
    aliases: ['/analytics', '/cost'],
    surface: local('hub-usage'),
  },
  { name: '/settings', description: 'App settings', surface: local('hub-settings') },
  { name: '/help', description: 'Show every command', aliases: ['/commands'], surface: local('help') },

  // --- dedicated gateway RPCs -------------------------------------------
  {
    name: '/compress',
    // Not `exec`: on a long session the summarising LLM call outlives the
    // slash worker's pipe timeout, and the failure surfaces as a bogus
    // "not a quick/plugin/skill command: compress".
    description: 'Compress this conversation to free context',
    aliases: ['/compact'],
    argumentMode: 'text',
    surface: rpc(
      'session.compress',
      ({ sessionId, arg }) => ({ session_id: sessionId, ...(arg ? { focus_topic: arg } : {}) }),
      (result) => {
        // The gateway composes its own user-facing wording (including the
        // aborted and fallback cases); use it rather than re-deriving one.
        const summary = (result as { summary?: Record<string, unknown> } | null)?.summary;
        const lines = ['headline', 'token_line', 'note']
          .map((key) => summary?.[key])
          .filter((line): line is string => typeof line === 'string' && line.length > 0);
        if (lines.length > 0) return lines.join('\n');

        const before = num(result, 'before_tokens');
        const after = num(result, 'after_tokens');
        return before != null && after != null
          ? `Compressed — ~${before.toLocaleString()} → ~${after.toLocaleString()} tokens.`
          : 'Context compressed.';
      },
    ),
  },
  {
    name: '/title',
    description: 'Rename this session',
    argumentMode: 'text',
    surface: rpc(
      'session.title',
      ({ sessionId, arg }) => ({ session_id: sessionId, ...(arg ? { title: arg } : {}) }),
      (result, { arg }) => `Session titled “${str(result, 'title') || arg}”.`,
    ),
  },
  {
    name: '/undo',
    description: 'Drop the last exchange',
    surface: rpc(
      'session.undo',
      ({ sessionId }) => ({ session_id: sessionId }),
      (result) => {
        const removed = num(result, 'removed') ?? 0;
        return removed ? `Removed the last ${removed} message(s).` : 'Nothing to undo.';
      },
    ),
  },
  {
    name: '/save',
    description: 'Save this transcript to a file',
    surface: rpc(
      'session.save',
      ({ sessionId }) => ({ session_id: sessionId }),
      (result) => {
        const path = str(result, 'path') || str(result, 'file');
        return path ? `Saved to ${path}` : 'Session saved.';
      },
    ),
  },

  // --- backend-executed, with a description worth overriding -------------
  { name: '/status', description: 'Session status', surface: exec() },
  { name: '/usage', description: 'Token usage for this session', surface: exec() },
  { name: '/agents', description: 'Active sessions and running tasks', aliases: ['/tasks'], surface: exec() },
  { name: '/approvals', description: 'Show or set approval mode', argumentMode: 'options', surface: exec() },
  { name: '/goal', description: 'Manage the standing goal for this session', argumentMode: 'mixed', surface: exec() },
  { name: '/queue', description: 'Queue a prompt for the next turn', aliases: ['/q'], argumentMode: 'text', surface: exec() },
  { name: '/background', description: 'Run a prompt in the background', aliases: ['/bg'], argumentMode: 'text', surface: exec() },
  { name: '/steer', description: 'Steer the run after the next tool call', argumentMode: 'text', surface: exec() },
  { name: '/rollback', description: 'List or restore filesystem checkpoints', argumentMode: 'mixed', surface: exec() },
  { name: '/personality', description: 'Switch personality for this session', argumentMode: 'options', surface: exec() },
  { name: '/retry', description: 'Retry the last message', surface: exec() },
  { name: '/version', description: 'Hermes Agent version', surface: exec() },

  // Known commands with an underscore spelling variant but no phone surface.
  { name: '/reload-mcp', aliases: ['/reload_mcp'], surface: unavailable('terminal') },
  { name: '/reload-skills', aliases: ['/reload_skills'], surface: unavailable('terminal') },
];

/**
 * Commands with no phone surface and no alias — a flat list per reason beats
 * forty identical object literals.
 */
const NO_PHONE_SURFACE: Record<UnavailableReason, readonly string[]> = {
  // Terminal chrome: repaints, panes, the pager, the config editor.
  terminal: [
    '/busy',
    '/copy',
    '/density',
    '/details',
    '/exit',
    '/footer',
    '/gateway',
    '/history',
    '/image',
    '/indicator',
    '/logs',
    '/mouse',
    '/paste',
    '/platforms',
    '/plugins',
    '/quit',
    '/redraw',
    '/reload',
    '/restart',
    '/sb',
    '/set-home',
    '/sethome',
    '/snap',
    '/snapshot',
    '/statusbar',
    '/toolsets',
    '/update',
    '/verbose',
    '/config',
  ],
  // Only meaningful when a chat platform is driving the session.
  messaging: ['/approve', '/deny'],
  // Fulfilled by a desktop overlay we have no equivalent of.
  desktop: ['/pet', '/pets', '/hatch', '/generate-pet', '/skin', '/journey', '/learning', '/memory-graph'],
};

const ALL_SPECS: readonly CommandSpec[] = [
  ...SPECS,
  ...(Object.entries(NO_PHONE_SURFACE) as [UnavailableReason, readonly string[]][]).flatMap(
    ([reason, names]) => names.map((name) => ({ name, surface: unavailable(reason) })),
  ),
];

const BY_NAME = new Map(ALL_SPECS.map((spec) => [spec.name, spec]));

const ALIAS_TO_CANONICAL = new Map(
  ALL_SPECS.flatMap((spec) => (spec.aliases ?? []).map((alias) => [alias, spec.name] as const)),
);

const UNAVAILABLE_MESSAGE: Record<UnavailableReason, (name: string) => string> = {
  terminal: (name) => `${name} only works in the terminal interface.`,
  messaging: (name) => `${name} is only used from a messaging platform.`,
  desktop: (name) => `${name} needs the Hermes desktop app.`,
};

/** Split typed text into its command token and the rest. */
export function splitCommand(text: string): { name: string; arg: string } {
  const trimmed = text.trim();
  const space = trimmed.search(/\s/);
  const head = space === -1 ? trimmed : trimmed.slice(0, space);
  const name = (head.startsWith('/') ? head : `/${head}`).toLowerCase();
  return { name, arg: space === -1 ? '' : trimmed.slice(space + 1).trim() };
}

export function isSlashInput(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('/') && trimmed.length > 1;
}

/** Resolve an alias to the canonical spelling; unknown names pass through. */
export function canonicalCommand(command: string): string {
  const { name } = splitCommand(command);
  return ALIAS_TO_CANONICAL.get(name) ?? name;
}

/** The spec for a command, or null for skill / quick / unknown commands. */
export function resolveCommand(command: string): CommandSpec | null {
  return BY_NAME.get(canonicalCommand(command)) ?? null;
}

/**
 * True for anything the backend surfaces that isn't one of Hermes' built-ins —
 * skill commands and user-defined quick commands. They execute like any exec
 * command, which is what keeps this table from needing to list them.
 */
export function isExtensionCommand(command: string): boolean {
  const { name } = splitCommand(command);
  return name.length > 1 && !BY_NAME.has(name) && !ALIAS_TO_CANONICAL.has(name);
}

/** Gates execution: false only for a known command with no phone surface. */
export function isRunnable(command: string): boolean {
  const spec = resolveCommand(command);
  return spec ? spec.surface.kind !== 'unavailable' : isExtensionCommand(command);
}

/** Gates discovery in the popover and the palette. */
export function isSuggestion(command: string): boolean {
  const { name } = splitCommand(command);
  // Aliases stay hidden so the list isn't two rows of the same thing.
  if (ALIAS_TO_CANONICAL.has(name)) return false;
  const spec = BY_NAME.get(name);
  if (spec) return spec.surface.kind !== 'unavailable' && !spec.hidden;
  return isExtensionCommand(name);
}

export function unavailableMessage(command: string): string | null {
  const canonical = canonicalCommand(command);
  const surface = BY_NAME.get(canonical)?.surface;
  return surface?.kind === 'unavailable' ? UNAVAILABLE_MESSAGE[surface.reason](canonical) : null;
}

export function describeCommand(command: string, fallback = ''): string {
  return resolveCommand(command)?.description || fallback;
}

export function argumentMode(command: string): ArgumentMode | null {
  return resolveCommand(command)?.argumentMode ?? null;
}
