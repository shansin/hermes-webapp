/**
 * Filesystem checkpoints: `rollback.list`, `rollback.diff`, `rollback.restore`.
 *
 * Shapes from `tui_gateway/contracts/tools_commands.py` and the handlers in
 * `tui_gateway/methods_tools.py` (~1208–1260). What the wire does not say:
 *
 *  - A checkpoint is a snapshot of the session's cwd taken *before* the first
 *    file-mutating tool call of a turn (`agent/tool_executor.py`, at most one
 *    per directory per turn), so restoring one puts files back as they were
 *    just before the agent touched them in that turn. The list is newest
 *    first; `timestamp` is git's ISO-8601 author date; `message` is the
 *    manager's `reason` ("before write_file", "before terminal: …").
 *  - The list RPC drops the per-checkpoint file counts the manager computes,
 *    so "what changed" comes from `rollback.diff`, which compares the
 *    checkpoint with the working tree *now* (i.e. what a restore would undo)
 *    and truncates the patch to 4000 characters.
 *  - **A whole restore also rewinds the conversation**: on success the
 *    handler drops the latest user turn from the session's history
 *    (`history_removed`), and it is refused mid-turn (4009). A single-file
 *    restore (`file_path`, relative to the cwd) touches disk only and is
 *    allowed while a turn runs.
 *  - Failure is mostly *in* the result (`success: false` + `error`/`reason`),
 *    not an RPC error.
 */
import * as z from 'zod/mini';
import { hermes, CONTROL_TIMEOUT_MS } from '../ws/client';

const CheckpointSchema = z.looseObject({
  hash: z._default(z.string(), ''),
  timestamp: z._default(z.string(), ''),
  message: z._default(z.string(), ''),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

const ListSchema = z.looseObject({
  enabled: z._default(z.boolean(), false),
  checkpoints: z._default(z.array(CheckpointSchema), []),
});

const DiffSchema = z.looseObject({
  stat: z._default(z.string(), ''),
  diff: z._default(z.string(), ''),
});
export type CheckpointDiff = z.infer<typeof DiffSchema>;

const RestoreSchema = z.looseObject({
  success: z._default(z.boolean(), false),
  error: z.optional(z.nullable(z.string())),
  reason: z.optional(z.nullable(z.string())),
  restored_files: z.optional(z.nullable(z.array(z.string()))),
  skipped_user_edits: z.optional(z.nullable(z.array(z.string()))),
  history_removed: z.optional(z.nullable(z.number())),
});
export type RestoreResult = z.infer<typeof RestoreSchema>;

export async function listCheckpoints(sessionId: string) {
  const raw = await hermes.call('rollback.list', { session_id: sessionId }, { timeoutMs: CONTROL_TIMEOUT_MS });
  return ListSchema.parse(raw);
}

export async function checkpointDiff(sessionId: string, hash: string): Promise<CheckpointDiff> {
  const raw = await hermes.call('rollback.diff', { session_id: sessionId, hash }, { timeoutMs: CONTROL_TIMEOUT_MS });
  return DiffSchema.parse(raw);
}

/** `filePath` restores one file and leaves the conversation alone. */
export async function restoreCheckpoint(
  sessionId: string,
  hash: string,
  filePath?: string,
): Promise<RestoreResult> {
  const raw = await hermes.call(
    'rollback.restore',
    { session_id: sessionId, hash, ...(filePath ? { file_path: filePath } : {}) },
    // A whole-tree checkout of a large repo is not a metadata call.
    { timeoutMs: 60_000 },
  );
  return RestoreSchema.parse(raw);
}
