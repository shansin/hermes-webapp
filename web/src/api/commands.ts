/**
 * Typed wrappers over the gateway's slash-command RPCs.
 *
 * Four methods matter:
 *  - `commands.catalog`  — the full registry, categorized, plus a per-skill
 *                          usage map used to rank the palette
 *  - `complete.slash`    — fuzzy completion for a partially typed command
 *  - `slash.exec`        — run a command in the session's HermesCLI worker
 *  - `command.dispatch`  — run a skill / quick / pending-input command, which
 *                          returns a *typed* result rather than plain text
 *
 * Shapes are permissive for the same reason as `ws/types.ts`: there's no
 * published schema, and a Hermes upgrade that adds a field must not break us.
 */
import * as z from 'zod/mini';
import { hermes, RpcError } from '../ws/client';

const PairSchema = z.tuple([z.string(), z.string()], z.string());

export const CommandCatalogSchema = z.looseObject({
  pairs: z._default(z.array(PairSchema), []),
  categories: z._default(
    z.array(z.looseObject({ name: z.string(), pairs: z._default(z.array(PairSchema), []) })),
    [],
  ),
  /** Alias → canonical command, lower-cased keys. */
  canon: z._default(z.record(z.string(), z.string()), {}),
  /** Per-skill provenance and observed usage, keyed by slash command. */
  skills: z._default(
    z.record(
      z.string(),
      z.looseObject({ origin: z.optional(z.string()), usage: z.optional(z.number()) }),
    ),
    {},
  ),
  skill_count: z.optional(z.number()),
  warning: z.optional(z.string()),
});
export type CommandCatalog = z.infer<typeof CommandCatalogSchema>;

export const CompletionItemSchema = z.looseObject({
  /** The replacement text. Note: no leading slash. */
  text: z.string(),
  display: z._default(z.string(), ''),
  meta: z._default(z.string(), ''),
  kind: z._default(z.string(), 'command'),
});
export type CompletionItem = z.infer<typeof CompletionItemSchema>;

export const SlashCompletionsSchema = z.looseObject({
  items: z._default(z.array(CompletionItemSchema), []),
  /** Index in the typed text where `item.text` is spliced in. */
  replace_from: z._default(z.number(), 1),
});
export type SlashCompletions = z.infer<typeof SlashCompletionsSchema>;

export const SlashExecResultSchema = z.looseObject({
  output: z._default(z.string(), ''),
  warning: z.optional(z.string()),
});
export type SlashExecResult = z.infer<typeof SlashExecResultSchema>;

/**
 * `command.dispatch` speaks in outcomes, not text:
 *  - `exec` / `plugin` — `output` is text for the transcript
 *  - `send` / `skill`  — `message` is a prompt to submit as a normal turn.
 *                        `display` is what the transcript should show instead;
 *                        `message` is expanded model-facing scaffolding.
 *  - `alias`           — `target` is another command to run
 */
export const DispatchResultSchema = z.looseObject({
  type: z._default(z.string(), 'exec'),
  output: z.optional(z.string()),
  message: z.optional(z.string()),
  display: z.optional(z.string()),
  notice: z.optional(z.string()),
  target: z.optional(z.string()),
  name: z.optional(z.string()),
});
export type DispatchResult = z.infer<typeof DispatchResultSchema>;

export async function fetchCommandCatalog(): Promise<CommandCatalog> {
  return CommandCatalogSchema.parse(await hermes.call('commands.catalog', {}));
}

export async function completeSlash(text: string, sessionId?: string): Promise<SlashCompletions> {
  const raw = await hermes.call('complete.slash', {
    text,
    ...(sessionId ? { session_id: sessionId } : {}),
  });
  return SlashCompletionsSchema.parse(raw);
}

export async function dispatchCommand(
  sessionId: string,
  name: string,
  arg: string,
): Promise<DispatchResult> {
  const raw = await hermes.call('command.dispatch', {
    session_id: sessionId,
    name: name.replace(/^\//, ''),
    arg,
  });
  return DispatchResultSchema.parse(raw);
}

/**
 * Run a command on the backend.
 *
 * `slash.exec` already routes skill, plugin and pending-input commands to
 * `command.dispatch` itself — except for skill commands, which it refuses with
 * code 4018 and a message telling the client to dispatch instead. So a plain
 * exec can come back as either shape, and we normalize both here.
 */
export async function execCommand(
  sessionId: string,
  command: string,
  arg: string,
): Promise<{ output?: string; warning?: string; dispatch?: DispatchResult }> {
  const full = arg ? `${command} ${arg}` : command;
  try {
    const raw = await hermes.call('slash.exec', { session_id: sessionId, command: full });
    /**
     * A typed result first. Newer Hermes answers a command that composes the
     * next turn (`/prompt`, `/blueprint`) with `{type: "send", message}`, and a
     * skill it could not refuse cleanly with the full dispatch result — both
     * successes with no `output`. The output schema defaults `output` to ''
     * and tolerates extra keys, so it accepted these as an empty reply and the
     * command silently did nothing.
     */
    if (typeof (raw as { type?: unknown } | null)?.type === 'string') {
      const typed = DispatchResultSchema.safeParse(raw);
      if (typed.success) return { dispatch: typed.data };
    }
    const parsed = SlashExecResultSchema.safeParse(raw);
    if (parsed.success) return { output: parsed.data.output, warning: parsed.data.warning };
    // Some commands are internally forwarded to command.dispatch, whose typed
    // payload comes back through this same call.
    return { dispatch: DispatchResultSchema.parse(raw) };
  } catch (err) {
    if (err instanceof RpcError && err.code === 4018) {
      return { dispatch: await dispatchCommand(sessionId, command, arg) };
    }
    throw err;
  }
}
