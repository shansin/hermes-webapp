/**
 * Who may DM the bots: senders waiting to pair, and the ones already paired.
 *
 * A platform under pairing answers a stranger with a one-time code and files
 * a pending request; until an operator approves it the bot ignores them, and
 * after an hour the request lapses without a word to either side. The proxy's
 * pairing sweep (`server/src/push/pairing.ts`) pushes when one arrives and
 * links here — `#pairing` is the anchor it lands on.
 *
 * Approve uses the request's server-side id (`approve_request`), the admin
 * path that never needs the code the sender was DM'd. A legacy entry from
 * before the store hashed its codes has no id and can only be approved with
 * the code, on the machine.
 *
 * Declining is coarser than approving, because Hermes is: the only decline is
 * `clear-pending`, which empties one profile's whole queue. So a lone request
 * gets a Deny button (clearing the queue *is* declining it), and two or more
 * get one "Deny all" that says how many it will drop. Leaving a request alone
 * also declines it, an hour later.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useProfiles } from '../../api/profiles';
import { useApprovePairing, useClearPendingPairing, usePairing, useRevokePairing } from '../../api/machine';
import { pairingMinutesLeft, titleCase, type PairedUser, type PairingRequest } from '../../lib/machine';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';
import { Skeleton } from '../shared/misc';
import { ConfirmSheet, Hint, smallBtn } from './parts';

const who = (r: { userName: string; userId: string }) => r.userName || r.userId || 'Unknown sender';

export function PairingSection() {
  const toast = useUi((s) => s.toast);
  const profileList = useProfiles();
  const names = (profileList.data?.profiles ?? []).map((p) => p.name);
  /* Until the profile list lands, or on a Hermes that lists none, read the
     backend's own store — never nothing. */
  const profiles: (string | null)[] = names.length ? names : [null];
  const multi = names.length > 1;

  const pairing = usePairing(profileList.isLoading ? [] : profiles);
  const approve = useApprovePairing();
  const clear = useClearPendingPairing();
  const revoke = useRevokePairing();

  const [denying, setDenying] = useState<{ profile: string | null; count: number; label: string } | null>(null);
  const [revoking, setRevoking] = useState<PairedUser | null>(null);

  /* Landing from a pairing push: the screen scrolls to `#pairing` on
     arrival, but the sections above are still filling in then and push this
     one down. Once its own rows are in, scroll to it again — once. */
  const { hash } = useLocation();
  const head = useRef<HTMLDivElement>(null);
  const settled = !pairing.isLoading && !profileList.isLoading;
  useEffect(() => {
    if (settled && hash === '#pairing') head.current?.scrollIntoView({ block: 'start' });
  }, [settled, hash]);

  const perProfile = new Map<string | null, number>();
  for (const r of pairing.pending) perProfile.set(r.profile, (perProfile.get(r.profile) ?? 0) + 1);

  const doApprove = async (r: PairingRequest) => {
    buzz('tap');
    try {
      await approve.mutateAsync(r);
      toast(`${who(r)} can now message the ${titleCase(r.platform)} bot`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Approve failed', 'error');
    }
  };

  const doClear = async (profile: string | null) => {
    try {
      const res = await clear.mutateAsync(profile);
      toast(`Declined ${res.cleared ?? 0} pairing request${res.cleared === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not decline', 'error');
    }
  };

  const doRevoke = async (u: PairedUser) => {
    try {
      await revoke.mutateAsync(u);
      toast(`${who(u)} can no longer message the bot`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Revoke failed', 'error');
    }
  };

  return (
    <>
      <div ref={head} className="group-head" id="pairing" style={{ scrollMarginTop: 12 }}>
        PAIRING
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        {pairing.isLoading || profileList.isLoading ? (
          <Skeleton h={44} mb={0} />
        ) : pairing.error && !pairing.pending.length ? (
          <Hint tone="error">
            {pairing.error instanceof Error ? pairing.error.message : 'Could not read the pairing store.'}
          </Hint>
        ) : pairing.pending.length === 0 ? (
          <Hint>
            Nobody is waiting. When someone DMs a bot that does not know them, their request
            appears here and on your lock screen.
          </Hint>
        ) : (
          pairing.pending.map((r, i) => {
            const alone = perProfile.get(r.profile) === 1;
            const left = pairingMinutesLeft(r.ageMinutes);
            return (
              <div
                key={`${r.profile}:${r.platform}:${r.requestId || r.userId}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '8px 0',
                  borderTop: i ? '1px solid var(--border-soft)' : undefined,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--type-detail)', overflowWrap: 'anywhere' }}>
                    {who(r)}
                    <span style={{ color: 'var(--text-faint)' }}> on {titleCase(r.platform)}</span>
                    {multi && r.profile && (
                      <span className="tool-pill" style={{ marginLeft: 6, color: 'var(--text-faint)' }}>
                        {r.profile}
                      </span>
                    )}
                  </div>
                  <Hint tone={left <= 10 ? 'warn' : undefined}>
                    {r.userName && r.userId ? `${r.userId} · ` : ''}
                    {left ? `expires in ${left}m` : 'expiring'}
                    {!r.requestId && ' · approve with its code on the machine'}
                  </Hint>
                </div>
                <button
                  className="btn btn--primary"
                  style={smallBtn}
                  disabled={!r.requestId || approve.isPending}
                  onClick={() => void doApprove(r)}
                >
                  Approve
                </button>
                {alone && (
                  <button
                    className="btn"
                    style={smallBtn}
                    disabled={clear.isPending}
                    onClick={() => setDenying({ profile: r.profile, count: 1, label: who(r) })}
                  >
                    Deny
                  </button>
                )}
              </div>
            );
          })
        )}

        {[...perProfile.entries()]
          .filter(([, n]) => n > 1)
          .map(([profile, n]) => (
            <button
              key={profile ?? ''}
              className="btn"
              style={{ ...smallBtn, marginTop: 8 }}
              disabled={clear.isPending}
              onClick={() => setDenying({ profile, count: n, label: `${n} requests` })}
            >
              Deny all {n}
              {multi && profile ? ` in ${profile}` : ''}
            </button>
          ))}

        {pairing.approved.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary
              style={{
                fontSize: 'var(--type-body-sm)',
                color: 'var(--text-dim)',
                cursor: 'pointer',
                minHeight: 'var(--tap-min)',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              Paired senders ({pairing.approved.length})
            </summary>
            {pairing.approved.map((u) => (
              <div
                key={`${u.profile}:${u.platform}:${u.userId}`}
                style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 0', borderTop: '1px solid var(--border-soft)' }}
              >
                <div style={{ flex: 1, minWidth: 0, fontSize: 'var(--type-detail)', overflowWrap: 'anywhere' }}>
                  {who(u)}
                  <span style={{ color: 'var(--text-faint)' }}> on {titleCase(u.platform)}</span>
                  {multi && u.profile && (
                    <span className="tool-pill" style={{ marginLeft: 6, color: 'var(--text-faint)' }}>
                      {u.profile}
                    </span>
                  )}
                </div>
                <button className="btn" style={smallBtn} disabled={revoke.isPending} onClick={() => setRevoking(u)}>
                  Revoke
                </button>
              </div>
            ))}
          </details>
        )}
      </div>

      <ConfirmSheet
        open={Boolean(denying)}
        title={denying?.count === 1 ? `Decline ${denying.label}?` : `Decline ${denying?.label ?? ''}?`}
        confirmLabel={denying?.count === 1 ? 'Decline' : `Decline ${denying?.count ?? ''}`}
        onConfirm={() => denying && void doClear(denying.profile)}
        onClose={() => setDenying(null)}
      >
        {denying?.count === 1
          ? 'They stay unable to message the bot. Their code stops working, and they would have to DM it again to ask once more.'
          : `Hermes can only decline a profile's pending requests all at once, so this drops all ${denying?.count ?? ''}${
              multi && denying?.profile ? ` in ${denying.profile}` : ''
            }. Approve anyone you want to keep first.`}
      </ConfirmSheet>

      <ConfirmSheet
        open={Boolean(revoking)}
        title={revoking ? `Revoke ${who(revoking)}?` : 'Revoke?'}
        confirmLabel="Revoke"
        onConfirm={() => revoking && void doRevoke(revoking)}
        onClose={() => setRevoking(null)}
      >
        {revoking
          ? `${who(revoking)} will no longer be able to message the ${titleCase(revoking.platform)} bot until they pair again.`
          : null}
      </ConfirmSheet>
    </>
  );
}
