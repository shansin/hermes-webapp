/**
 * Hermes's tool-approval modes, and how to read the current one.
 *
 * Two sheets used to carry their own chip rows, with two different invented
 * vocabularies (`smart/always/never/yolo`, `suggest/auto/never`). Hermes
 * accepts exactly `manual | smart | off` for `approvals.mode` and answers 4002
 * to anything else, so every chip but "smart" failed. This is the one list.
 *
 * The mode is **global**: `config.set approvals.mode` writes `config.yaml` and
 * re-emits `session.info` to every live session. The only per-chat override is
 * the session `yolo` flag (`config.set key=yolo`, scope `session`), which
 * bypasses approvals for that chat alone — see `setSessionYolo`.
 */

export type ApprovalMode = 'manual' | 'smart' | 'off';

export const APPROVAL_MODES: readonly { mode: ApprovalMode; label: string; hint: string }[] = [
  { mode: 'manual', label: 'Ask', hint: 'Ask before every risky command.' },
  {
    mode: 'smart',
    label: 'Smart',
    hint: 'A reviewer model clears safe commands and asks you about the rest.',
  },
  { mode: 'off', label: 'Off', hint: 'Never ask — every command runs.' },
];

/**
 * What `session.info.approval_mode` says, as one of the three.
 *
 * Mirrors Hermes's own `_normalize_approval_mode`: YAML 1.1 reads a bare `off`
 * as `false`, and an unknown word falls back to `manual` — which is what the
 * backend then actually enforces, so it is what the chips should show. Absent
 * (an older gateway, or no session yet) is `null`: no chip lit beats a guess.
 */
export function normalizeApprovalMode(raw: unknown): ApprovalMode | null {
  if (raw === false) return 'off';
  if (raw === true) return 'manual';
  if (typeof raw !== 'string') return null;
  const word = raw.trim().toLowerCase();
  if (!word) return null;
  return APPROVAL_MODES.some((m) => m.mode === word) ? (word as ApprovalMode) : 'manual';
}

export function approvalLabel(mode: ApprovalMode): string {
  return APPROVAL_MODES.find((m) => m.mode === mode)?.label ?? mode;
}
