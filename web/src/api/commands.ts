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
import { z } from 'zod';
import { hermes, RpcError } from '../ws/client';

const PairSchema = z.tuple([z.string(), z.string()]).rest(z.string());

export const CommandCatalogSchema = z
  .object({
    pairs: z.array(PairSchema).default([]),
    categories: z
      .array(z.object({ name: z.string(), pairs: z.array(PairSchema).default([]) }).passthrough())
      .default([]),
    /** Alias → canonical command, lower-cased keys. */
    canon: z.record(z.string()).default({}),
    /** Per-skill provenance and observed usage, keyed by slash command. */
    skills: z
      .record(
        z
          .object({ origin: z.string().optional(), usage: z.number().optional() })
          .passthrough(),
      )
      .default({}),
    skill_count: z.number().optional(),
    warning: z.string().optional(),
  })
  .passthrough();
export type CommandCatalog = z.infer<typeof CommandCatalogSchema>;

export const CompletionItemSchema = z
  .object({
    /** The replacement text. Note: no leading slash. */
    text: z.string(),
    display: z.string().default(''),
    meta: z.string().default(''),
    kind: z.string().default('command'),
  })
  .passthrough();
export type CompletionItem = z.infer<typeof CompletionItemSchema>;

export const SlashCompletionsSchema = z
  .object({
    items: z.array(CompletionItemSchema).default([]),
    /** Index in the typed text where `item.text` is spliced in. */
    replace_from: z.number().default(1),
  })
  .passthrough();
export type SlashCompletions = z.infer<typeof SlashCompletionsSchema>;

export const SlashExecResultSchema = z
  .object({ output: z.string().default(''), warning: z.string().optional() })
  .passthrough();
export type SlashExecResult = z.infer<typeof SlashExecResultSchema>;

/**
 * `command.dispatch` speaks in outcomes, not text:
 *  - `exec` / `plugin` — `output` is text for the transcript
 *  - `send` / `skill`  — `message` is a prompt to submit as a normal turn.
 *                        `display` is what the transcript should show instead;
 *                        `message` is expanded model-facing scaffolding.
 *  - `alias`           — `target` is another command to run
 */
export const DispatchResultSchema = z
  .object({
    type: z.string().default('exec'),
    output: z.string().optional(),
    message: z.string().optional(),
    display: z.string().optional(),
    notice: z.string().optional(),
    target: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();
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
