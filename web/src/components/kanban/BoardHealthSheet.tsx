/**
 * "Is this board actually working?"
 *
 * Four questions the board itself cannot answer, gathered because each one is
 * only meaningful next to the others:
 *
 * - **How long has the queue been waiting.** `oldest_ready_age_seconds` is the
 *   single number that says whether the dispatcher is keeping up. A board with
 *   six cards in Ready looks identical whether they arrived a minute ago or
 *   have been sitting there since Tuesday.
 * - **What Hermes thinks is wrong.** `GET /diagnostics` is the rule engine
 *   behind `hermes kanban doctor` — crash loops, spawn failures, cards blocked
 *   for days, an agent citing card ids that do not exist. The board rows carry
 *   a count of these; this is what the count is *of*, and it existed only on
 *   the machine's own command line until now.
 * - **What is really running.** The Running column is not the same list. The
 *   dispatcher moves a card there *before* a worker picks it up, and a claim
 *   outlives the process that held it — so a card in Running with no worker
 *   here is precisely the stuck state, and this is the only place the two can
 *   be compared.
 * - **What the next tick would do.** `dispatch?dry_run=true` names every card
 *   the dispatcher would skip and why. `skipped_unassigned` is the one that
 *   matters: Hermes buckets an unassigned card there silently, every tick,
 *   forever, and reports it nowhere else.
 *
 * Read-only apart from two recoveries that belong next to the evidence for
 * them: releasing a claim, and killing a worker process.
 */
import { useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { Empty, ErrorNote, Loader, relTime } from '../shared/misc';
import {
  useActiveWorkers,
  useBoardStats,
  useDiagnostics,
  type ActiveWorker,
} from '../../api/kanbanAdmin';
import {
  dispatchRows,
  useDispatch,
  useReclaimTask,
  useTerminateRun,
  type DispatchResult,
} from '../../api/kanban';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

/** How long a claimed run may go quiet before it is called stuck. */
const STUCK_AFTER_S = 150;

export function BoardHealthSheet({
  open,
  board,
  onClose,
  onOpenTask,
}: {
  open: boolean;
  board: string | null;
  onClose: () => void;
  onOpenTask: (id: string) => void;
}) {
  const stats = useBoardStats(board, open);
  const diagnostics = useDiagnostics(board, null, open);
  const workers = useActiveWorkers(board, open);
  const dispatch = useDispatch(board);
  const toast = useUi((s) => s.toast);
  const [plan, setPlan] = useState<DispatchResult | null>(null);

  const dryRun = async () => {
    buzz('tap');
    try {
      setPlan(await dispatch.mutateAsync({ dryRun: true }));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not ask the dispatcher', 'error');
    }
  };

  const runSweep = async () => {
    buzz('tap');
    try {
      const res = await dispatch.mutateAsync({});
      buzz('done');
      const n = res.spawned?.length ?? 0;
      /* "Nothing started" is a real and common answer — every ready card may
         already be claimed — and reporting it as success with no number is how
         a button starts feeling broken. */
      toast(n ? `Started ${n} card${n > 1 ? 's' : ''}` : 'Nothing was ready to start', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Dispatch failed', 'error');
    }
  };

  const oldest = stats.data?.oldest_ready_age_seconds ?? null;
  /**
   * Unpacked once, with a default, rather than reached through at each use.
   *
   * `workers.data?.workers.length` reads correctly and is not: the `?.` guards
   * only `data`, so a payload that arrives *present but without the key* —
   * an older plugin, a route that answered with a different shape — makes this
   * a plain `.length` on `undefined`. There is no error boundary anywhere in
   * `App.tsx` (see the skills-category incident in CLAUDE.md), so that throw
   * does not blank this sheet, it blanks the entire app.
   */
  const workerRows = workers.data?.workers ?? [];
  const diagnosticRows = diagnostics.data?.diagnostics ?? [];

  return (
    <Sheet open={open} onClose={onClose} title="Board health">
      <div className="group-head">QUEUE</div>
      {stats.isLoading ? (
        <Loader size="sm" muted />
      ) : stats.error ? (
        <ErrorNote error={stats.error} />
      ) : (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {Object.entries(stats.data?.by_status ?? {}).map(([status, n]) => (
              <span key={status} className="chip" style={{ pointerEvents: 'none' }}>
                {status} {n}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 'var(--type-body-sm)', color: oldest && oldest > 3600 ? 'var(--warn)' : 'var(--text-dim)' }}>
            {oldest === null
              ? 'Nothing is waiting to be claimed.'
              : `Oldest card in Ready has been waiting ${humanAge(oldest)}.`}
          </div>
        </div>
      )}

      <div className="group-head">WHAT THE DISPATCHER WOULD DO</div>
      <div style={{ display: 'flex', gap: 7, marginBottom: 8 }}>
        <button className="btn" style={{ flex: 1 }} disabled={dispatch.isPending} onClick={() => void dryRun()}>
          {dispatch.isPending ? 'Asking…' : 'Preview next tick'}
        </button>
        <button className="btn btn--primary" style={{ flex: 1 }} disabled={dispatch.isPending} onClick={() => void runSweep()}>
          Run it now
        </button>
      </div>
      {plan && <DispatchPlan plan={plan} />}

      <div className="group-head">LIVE WORKERS</div>
      {workers.isLoading ? (
        <Loader size="sm" muted />
      ) : workers.error ? (
        <ErrorNote error={workers.error} />
      ) : workerRows.length === 0 ? (
        <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', marginBottom: 14 }}>
          No worker processes are running. A card sitting in Running with nothing here is holding a
          claim its process no longer backs.
        </div>
      ) : (
        <div style={{ marginBottom: 14 }}>
          {workerRows.map((w) => (
            <WorkerRow key={w.run_id} worker={w} board={board} onOpenTask={onOpenTask} />
          ))}
        </div>
      )}

      <div className="group-head">
        DIAGNOSTICS{diagnostics.data?.count ? ` · ${diagnostics.data.count}` : ''}
      </div>
      {diagnostics.isLoading ? (
        <Loader size="sm" muted />
      ) : diagnostics.error ? (
        <ErrorNote error={diagnostics.error} />
      ) : diagnosticRows.length === 0 ? (
        <Empty compact icon="✓" title="Hermes has nothing to report" />
      ) : (
        <div style={{ marginBottom: 6 }}>
          {diagnosticRows.map((row) => (
            <button
              key={row.task_id}
              className="btn btn--sm"
              style={{ width: '100%', textAlign: 'left', display: 'block', height: 'auto', padding: '9px 11px', marginBottom: 6 }}
              onClick={() => {
                buzz('tap');
                /* Deliberately without closing this sheet: the task stacks on
                   top and dismissing it lands back on the diagnostics list,
                   which is where you were reading. (A hand-off would work too
                   now — see `useHistoryDismiss` — but returning to the list is
                   the better of the two here.) */
                onOpenTask(row.task_id);
              }}
            >
              <div style={{ fontWeight: 550 }}>{row.task_title}</div>
              {(row.diagnostics ?? []).map((d, i) => (
                <div
                  key={i}
                  style={{
                    marginTop: 3,
                    fontSize: 'var(--type-body-sm)',
                    fontWeight: 400,
                    color: d.severity === 'warning' ? 'var(--warn)' : 'var(--error)',
                  }}
                >
                  {d.message ?? d.detail ?? d.kind}
                </div>
              ))}
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/**
 * The buckets, which are the point of a dry run.
 *
 * `spawned` is what *would* start; every other non-empty key is a reason
 * something would not, and those are the rows nothing else in Hermes surfaces —
 * `skipped_unassigned` above all, which the dispatcher fills silently on every
 * tick and reports to no one.
 *
 * The shape is flat and version-dependent, so the rows are derived rather than
 * enumerated here: see `dispatchRows`.
 */
function DispatchPlan({ plan }: { plan: DispatchResult }) {
  const rows = dispatchRows(plan);
  const spawned = plan.spawned?.length ?? 0;

  return (
    <div
      style={{
        background: 'var(--bg-elev)',
        border: '1px solid var(--border-soft)',
        borderRadius: 'var(--radius-sm)',
        padding: 10,
        marginBottom: 14,
        fontSize: 'var(--type-body-sm)',
        lineHeight: 1.5,
      }}
    >
      <div>
        {spawned === 0 ? 'Nothing would start.' : `${spawned} card${spawned > 1 ? 's' : ''} would start.`}
      </div>
      {rows
        .filter((r) => r.key !== 'spawned')
        .map((r) => (
          <div
            key={r.key}
            style={{ color: r.key === 'skipped_unassigned' ? 'var(--warn)' : 'var(--text-dim)' }}
          >
            {r.label}: {r.detail}
          </div>
        ))}
      {/* A healthy idle tick has nothing in any bucket, and saying so is a
          better answer than an empty box that reads as a failed request. */}
      {rows.length === 0 && <div style={{ color: 'var(--text-faint)' }}>Nothing is queued.</div>}
    </div>
  );
}

function WorkerRow({
  worker,
  board,
  onOpenTask,
}: {
  worker: ActiveWorker;
  board: string | null;
  onOpenTask: (id: string) => void;
}) {
  const reclaim = useReclaimTask(board);
  const terminate = useTerminateRun(board);
  const toast = useUi((s) => s.toast);

  const quiet =
    typeof worker.last_heartbeat_at === 'number' &&
    Date.now() / 1000 - worker.last_heartbeat_at > STUCK_AFTER_S;

  const act = async (what: 'reclaim' | 'terminate') => {
    buzz('warn');
    try {
      if (what === 'reclaim') await reclaim.mutateAsync({ id: worker.task_id });
      else await terminate.mutateAsync({ runId: worker.run_id, taskId: worker.task_id });
      buzz('done');
      toast(what === 'reclaim' ? 'Claim released' : 'Worker terminated', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed', 'error');
    }
  };

  return (
    <div
      style={{
        border: `1px solid ${quiet ? 'var(--error)' : 'var(--border-soft)'}`,
        borderRadius: 'var(--radius-sm)',
        padding: '9px 11px',
        marginBottom: 6,
      }}
    >
      <button
        className="btn btn--sm"
        style={{ width: '100%', textAlign: 'left', display: 'block', height: 'auto', padding: 0, background: 'none', border: 'none' }}
        onClick={() => {
          buzz('tap');
          onOpenTask(worker.task_id);
        }}
      >
        <span style={{ fontWeight: 550 }}>{worker.task_title}</span>
      </button>
      <div style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', marginTop: 3 }}>
        @{worker.profile ?? worker.task_assignee ?? 'unknown'}
        {worker.worker_pid != null && ` · pid ${worker.worker_pid}`}
        {' · started '}
        {relTime(worker.started_at)}
      </div>
      <div style={{ fontSize: 'var(--type-label-sm)', color: quiet ? 'var(--error)' : 'var(--text-faint)', marginTop: 2 }}>
        {worker.last_heartbeat_at
          ? `last heartbeat ${relTime(worker.last_heartbeat_at)}`
          : 'no heartbeat recorded'}
      </div>
      <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
        <button className="btn btn--sm" style={{ flex: 1 }} disabled={reclaim.isPending} onClick={() => void act('reclaim')}>
          Release claim
        </button>
        {/* Distinct from releasing the claim, and worth the separate button:
            reclaim leaves the process alone, which is right for a worker that
            has already died and wrong for one that is alive and wedged. */}
        <button
          className="btn btn--sm btn--danger"
          style={{ flex: 1 }}
          disabled={terminate.isPending}
          onClick={() => void act('terminate')}
        >
          Kill worker
        </button>
      </div>
    </div>
  );
}

function humanAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}
