/**
 * Tool-approval prompt.
 *
 * Not dismissible: the agent's turn is blocked until a choice is sent, so
 * closing the sheet without answering would silently hang the conversation.
 * The choice list comes from the gateway (`once` / `session` / `always` /
 * `deny`), so a policy change upstream is reflected without a client edit.
 */
import { useEffect, useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { useSession } from '../../store/session';
import { IconWarn } from '../shared/Icons';
import { buzz } from '../../lib/haptics';

const LABELS: Record<string, { label: string; className: string }> = {
  once: { label: 'Allow once', className: 'btn btn--primary' },
  session: { label: 'Allow for this session', className: 'btn' },
  always: { label: 'Always allow', className: 'btn' },
  deny: { label: 'Deny', className: 'btn btn--danger' },
};

/**
 * The one choice here that outlives the conversation.
 *
 * `once` and `session` expire on their own; `always` writes a standing grant
 * into the config, and there is no screen in this app that lists what has been
 * granted or takes one back. It sat in the same row as the other three, the
 * same size, one tap away — on a sheet that appears without warning under a
 * thumb already moving toward where the previous button was.
 *
 * So it asks twice. Not a dialog on top of a dialog, which would be a second
 * modal over a modal that cannot be dismissed: the button relabels itself and
 * the second tap is the one that counts. It disarms on its own after a few
 * seconds, and on any other interaction with the sheet, so an armed button is
 * never waiting for a tap aimed at something else.
 */
const CONFIRM_MS = 4000;

export function ApprovalSheet() {
  const approval = useSession((s) => s.approval);
  const respond = useSession((s) => s.respondApproval);
  const [arming, setArming] = useState<string | null>(null);

  // A new request is a new question; nothing carries over from the last one.
  // The store's own counter, not `request_id` — it is present on every
  // request and typed, and two requests never share one.
  const requestKey = approval?.id ?? null;
  useEffect(() => setArming(null), [requestKey]);

  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(null), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [arming]);

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
        <p style={{ marginTop: 0, color: 'var(--text-dim)', fontSize: 'var(--type-body-md)' }}>{approval.reason}</p>
      )}

      {what && <div className="approval__what">{what}</div>}

      {approval.smart_denied && (
        <p style={{ color: 'var(--warn)', fontSize: 'var(--type-detail)', marginTop: 0 }}>
          Hermes flagged this as risky. Approve only if you expected it.
        </p>
      )}

      <div className="approval__actions">
        {approval.choices.map((choice) => {
          const meta = LABELS[choice] ?? { label: choice, className: 'btn' };
          const guarded = choice === 'always';
          const armed = arming === choice;
          return (
            <button
              key={choice}
              className={`${meta.className}${armed ? ' btn--armed' : ''}`}
              onClick={() => {
                if (guarded && !armed) {
                  buzz('warn');
                  setArming(choice);
                  return;
                }
                // Any other button ends the arming, so a stray second tap
                // cannot land on a grant the first tap only offered.
                setArming(null);
                void respond(choice);
              }}
            >
              {armed ? 'Tap again to always allow' : meta.label}
            </button>
          );
        })}
      </div>
      {arming === 'always' && (
        <p
          style={{
            color: 'var(--warn)',
            fontSize: 'var(--type-body-sm)',
            margin: '8px 2px 0',
            lineHeight: 1.45,
          }}
        >
          This grant is permanent and applies to every future session. There is
          no list of standing grants in the app to take it back from.
        </p>
      )}
    </Sheet>
  );
}
