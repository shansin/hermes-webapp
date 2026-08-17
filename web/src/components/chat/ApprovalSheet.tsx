/**
 * Tool-approval prompt.
 *
 * Not dismissible: the agent's turn is blocked until a choice is sent, so
 * closing the sheet without answering would silently hang the conversation.
 * The choice list comes from the gateway (`once` / `session` / `always` /
 * `deny`), so a policy change upstream is reflected without a client edit.
 */
import { Sheet } from '../shared/Sheet';
import { useSession } from '../../store/session';
import { IconWarn } from '../shared/Icons';

const LABELS: Record<string, { label: string; className: string }> = {
  once: { label: 'Allow once', className: 'btn btn--primary' },
  session: { label: 'Allow for this session', className: 'btn' },
  always: { label: 'Always allow', className: 'btn' },
  deny: { label: 'Deny', className: 'btn btn--danger' },
};

export function ApprovalSheet() {
  const approval = useSession((s) => s.approval);
  const respond = useSession((s) => s.respondApproval);

  if (!approval) return null;

  const what = approval.command || approval.description || approval.tool || approval.name || '';
  const title = approval.tool || approval.name || 'Approval needed';

  return (
    <Sheet
      open
      dismissible={false}
      onClose={() => void respond('deny')}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <IconWarn size={17} style={{ color: 'var(--warn)' }} />
          {title}
        </span>
      }
    >
      {approval.reason && (
        <p style={{ marginTop: 0, color: 'var(--text-dim)', fontSize: 14 }}>{approval.reason}</p>
      )}

      {what && <div className="approval__what">{what}</div>}

      {approval.smart_denied && (
        <p style={{ color: 'var(--warn)', fontSize: 13, marginTop: 0 }}>
          Hermes flagged this as risky. Approve only if you expected it.
        </p>
      )}

      <div className="approval__actions">
        {approval.choices.map((choice) => {
          const meta = LABELS[choice] ?? { label: choice, className: 'btn' };
          return (
            <button
              key={choice}
              className={meta.className}
              onClick={() => void respond(choice)}
            >
              {meta.label}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
