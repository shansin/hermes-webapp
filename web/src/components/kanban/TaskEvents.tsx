/**
 * A card's own history.
 *
 * `GET /tasks/<id>` has always returned this array and the sheet has always
 * thrown it away, which meant the questions a stalled card actually raises —
 * *when* did it stop, was it ever claimed, did a worker spawn, how many times
 * has this happened — had no answer anywhere in the app. The runs list is the
 * closest thing and it only shows attempts that got as far as starting; a card
 * that was claimed and never spawned has no run at all.
 *
 * Two of the kinds are worth knowing about before reading the code. `heartbeat`
 * is emitted every thirty seconds by a live worker and would otherwise be the
 * only thing in the list — a hundred of them per run, drowning the nine events
 * that mean something — so it is folded into a single line. And
 * `protocol_violation` / `suspected_hallucinated_references` /
 * `completion_blocked_hallucination` are Hermes catching the agent misbehaving:
 * they are rare, they explain otherwise inexplicable card states, and they are
 * the reason this list is worth rendering at all rather than just the runs.
 *
 * Collapsed by default. It is a forensic view, and a card that is working
 * needs nothing from it.
 */
import { useMemo, useState } from 'react';
import { relTime } from '../shared/misc';
import { buzz } from '../../lib/haptics';
import type { TaskEvent } from '../../api/kanban';

/** What each event kind means, in words a person did not have to learn. */
const KIND_LABEL: Record<string, string> = {
  created: 'Created',
  assigned: 'Assigned',
  reprioritized: 'Priority changed',
  edited: 'Edited',
  commented: 'Comment added',
  linked: 'Linked to another card',
  unlinked: 'Unlinked',
  decomposed: 'Split into subtasks',
  promoted: 'Promoted to Ready',
  promoted_manual: 'Promoted by hand',
  claimed: 'Claimed by the dispatcher',
  spawned: 'Worker started',
  heartbeat: 'Worker alive',
  run_started: 'Run started',
  run_ended: 'Run ended',
  completed: 'Completed',
  blocked: 'Blocked',
  unblocked: 'Unblocked',
  dependency_wait: 'Waiting on a parent',
  block_loop_detected: 'Blocked repeatedly — sent to Triage',
  review_requested: 'Review requested',
  review_reopened: 'Review reopened',
  changes_requested: 'Changes requested',
  reclaimed: 'Claim released',
  spawn_failed: 'Worker failed to start',
  gave_up: 'Gave up after repeated failures',
  archived: 'Archived',
  attached: 'File attached',
  protocol_violation: 'Agent broke protocol',
  suspected_hallucinated_references: 'Agent cited cards that do not exist',
  completion_blocked_hallucination: 'Completion refused — invented references',
  tip_scratch_workspace: 'Ran in a scratch workspace',
};

/** Kinds that mean something went wrong, and should read that way. */
const BAD = new Set([
  'blocked',
  'block_loop_detected',
  'spawn_failed',
  'gave_up',
  'protocol_violation',
  'suspected_hallucinated_references',
  'completion_blocked_hallucination',
]);

/**
 * The one useful sentence out of a payload, or nothing.
 *
 * Payloads are per-kind and untyped; rendering JSON at someone is worse than
 * rendering nothing. Only the fields that carry information a person would act
 * on are pulled out, and anything unrecognised falls through silently.
 */
function detail(event: TaskEvent): string | null {
  const p = event.payload as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== 'object') return null;
  for (const key of ['reason', 'error', 'summary', 'note', 'lock', 'by'] as const) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  if (Array.isArray(p.child_ids)) return `${p.child_ids.length} subtasks`;
  if (typeof p.parent === 'string' && typeof p.child === 'string') return `${p.parent} → ${p.child}`;
  if (typeof p.pid === 'number') return `pid ${p.pid}`;
  return null;
}

export function TaskEvents({ events }: { events: TaskEvent[] }) {
  const [open, setOpen] = useState(false);

  /**
   * Heartbeats collapsed to one line, everything else kept.
   *
   * A run of a few minutes emits a hundred of them. Dropping them entirely
   * would lose the one thing they say that matters — that the worker was
   * alive, and until when — so the last one survives, carrying the count.
   */
  const { rows, beats, lastBeat } = useMemo(() => {
    const kept: TaskEvent[] = [];
    let count = 0;
    let last: number | null = null;
    for (const e of events) {
      if (e.kind === 'heartbeat') {
        count += 1;
        last = last === null || e.created_at > last ? e.created_at : last;
        continue;
      }
      kept.push(e);
    }
    kept.sort((a, b) => b.created_at - a.created_at || b.id - a.id);
    return { rows: kept, beats: count, lastBeat: last };
  }, [events]);

  if (events.length === 0) return null;

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        className="btn btn--sm"
        style={{ width: '100%', justifyContent: 'space-between' }}
        onClick={() => {
          buzz('tap');
          setOpen((v) => !v);
        }}
      >
        <span style={{ color: 'var(--text-dim)' }}>{open ? 'Hide history' : 'History'}</span>
        <span style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)' }}>
          {rows.length} {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: 8 }}>
          {rows.map((e) => {
            const extra = detail(e);
            return (
              <div
                key={e.id}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'baseline',
                  padding: '6px 0',
                  borderBottom: '1px solid var(--border-soft)',
                  fontSize: 'var(--type-detail)',
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    color: BAD.has(e.kind) ? 'var(--error)' : undefined,
                    fontWeight: BAD.has(e.kind) ? 600 : 400,
                  }}
                >
                  {/* An unknown kind prints its raw name rather than being
                      hidden: a new Hermes event this app has not learned yet
                      is still evidence, and silently dropping it is how a
                      timeline starts lying by omission. */}
                  {KIND_LABEL[e.kind] ?? e.kind}
                  {extra && (
                    <span
                      style={{
                        color: 'var(--text-faint)',
                        fontWeight: 400,
                        marginTop: 2,
                        overflow: 'hidden',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                      }}
                    >
                      {extra}
                    </span>
                  )}
                </span>
                <span
                  style={{
                    color: 'var(--text-faint)',
                    fontSize: 'var(--type-label-sm)',
                    flexShrink: 0,
                  }}
                >
                  {relTime(e.created_at)}
                </span>
              </div>
            );
          })}

          {beats > 0 && (
            <div
              style={{
                padding: '6px 0',
                fontSize: 'var(--type-label-sm)',
                color: 'var(--text-faint)',
              }}
            >
              {beats} heartbeat{beats > 1 ? 's' : ''}, last {relTime(lastBeat)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
