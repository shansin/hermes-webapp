/**
 * The messaging gateway and each chat platform it serves, with the restart
 * underneath.
 *
 * The restart was a blind button: a bot that stopped answering on Discord
 * might be a dead gateway, one platform stuck retrying, or an expired token
 * that a restart will not fix — and the only way to tell them apart was a
 * terminal. `/api/status` already carries the answer (`gateway_platforms`,
 * persisted by the gateway itself into `gateway_state.json`), so the state of
 * each platform sits directly above the remedy, and the confirmation repeats
 * the count.
 */
import { useGatewayStatus } from '../../api/machine';
import { gatewaySummary, platformRows } from '../../lib/machine';
import { GatewayRestart } from '../hub/BackendControls';
import { Skeleton } from '../shared/misc';
import { Dot, Hint, toneColor } from './parts';

export function PlatformsSection() {
  const status = useGatewayStatus();
  const rows = platformRows(status.data);
  const gateway = gatewaySummary(status.data);
  const active = rows.filter((r) => r.tone !== 'off');
  const healthy = active.filter((r) => r.tone === 'ok').length;
  const health = status.data
    ? active.length
      ? `${healthy} of ${active.length} platform${active.length === 1 ? '' : 's'} connected; gateway ${gateway.state}.`
      : `Gateway ${gateway.state}; no platforms configured.`
    : null;

  return (
    <>
      <div className="group-head">MESSAGING</div>
      <div className="card" style={{ marginBottom: 16 }}>
        {status.isLoading ? (
          <Skeleton h={60} mb={0} />
        ) : status.isError ? (
          <Hint tone="error">
            {status.error instanceof Error ? status.error.message : 'Could not read the gateway status.'}
          </Hint>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '4px 0 8px' }}>
              <Dot tone={gateway.tone} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 550, fontSize: 'var(--type-body-md)' }}>Messaging gateway</div>
                {gateway.detail && <Hint tone={gateway.tone}>{gateway.detail}</Hint>}
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--type-body-sm)', color: toneColor[gateway.tone] }}>
                {gateway.state}
              </span>
            </div>

            {rows.map((r) => (
              <div
                key={r.key}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 9,
                  padding: '8px 0',
                  borderTop: '1px solid var(--border-soft)',
                }}
              >
                <span style={{ paddingTop: 6 }}>
                  <Dot tone={r.tone} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--type-detail)' }}>
                    {r.label}
                    {r.profile && (
                      <span className="tool-pill" style={{ marginLeft: 6, color: 'var(--text-faint)' }}>
                        {r.profile}
                      </span>
                    )}
                  </div>
                  {r.detail && <Hint tone={r.tone}>{r.detail}</Hint>}
                </div>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--type-body-sm)', color: toneColor[r.tone] }}>
                  {r.state}
                </span>
              </div>
            ))}
            {rows.length === 0 && (
              <Hint>No chat platforms are configured on this gateway.</Hint>
            )}
          </>
        )}
        <div style={{ marginTop: 10 }}>
          <GatewayRestart health={health} />
        </div>
      </div>
    </>
  );
}
