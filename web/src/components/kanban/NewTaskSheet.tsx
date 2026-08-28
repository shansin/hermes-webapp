/**
 * Creating a kanban task.
 *
 * The assignee picker is not a convenience. Hermes' dispatcher claims from
 * `ready` but skips any task whose `assignee` is null — it buckets it as
 * `skipped_unassigned` and moves on, every tick, forever. Nothing fails and
 * nothing is reported, so a task created without one simply sits on the board
 * looking queued while no agent will ever touch it. Hermes' own source calls
 * this "the dashboard footgun", and this sheet was the dashboard doing it.
 *
 * So a profile is always chosen, defaulting to the default one. The server
 * has a `kanban.default_assignee` fallback that covers an omitted assignee,
 * but that is config this app cannot see and must not assume.
 *
 * **A new card goes to Triage.** The endpoint's own default is `ready`, which
 * means a title typed on a phone is claimed by an agent within the minute and
 * run against whatever that one line happened to say. That is the right default
 * for a card an agent wrote — it already knows what it meant — and the wrong one
 * for a card a person wrote, where the line is a reminder and the brief is still
 * in their head. Triage is the lane for exactly that: `specify` turns it into a
 * proper brief, `decompose` fans it out, and both are on the task sheet.
 *
 * The switch stays, inverted, because the other case is real — a card that is
 * already a complete instruction should not need two more taps to start. What
 * is *not* offered is landing in Triage with no way out, so the hint under the
 * switch reads the gateway's `auto_decompose` setting and says which of the two
 * situations this install is actually in: a queue something sweeps, or a
 * parking lot only a person empties.
 *
 * **Everything under "Advanced" is create-only.** `skills`, `goal_mode`,
 * `goal_max_turns`, `max_runtime_seconds`, `workspace_kind` and `project_id`
 * are absent from `UpdateTaskBody` — a card that did not pin them here cannot
 * be given them afterwards through any route. That is the whole reason they are
 * on this sheet rather than the detail one, and why the section is collapsed
 * rather than dropped: rarely wanted, and unavailable later.
 */
import { useEffect, useMemo, useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { Switch } from '../shared/misc';
import { useCreateTask, useEstimate, WORKSPACE_KINDS, type WorkspaceKind } from '../../api/kanban';
import { useKanbanProjects, useOrchestration } from '../../api/kanbanAdmin';
import { useProfiles } from '../../api/profiles';
import { useSkills } from '../../api/hub';
import { ProfileField } from '../shared/ProfileSelect';
import { SelectChip, SelectSheet } from '../shared/SelectSheet';
import { MultiSelectSheet } from '../shared/MultiSelectSheet';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

interface Props {
  open: boolean;
  board?: string | null;
  onClose: () => void;
  onCreated?: () => void;
}

/** Runtime caps offered as minutes, because seconds is not how anyone thinks. */
const RUNTIME_CHOICES = [
  { value: '', label: 'No limit' },
  { value: '600', label: '10 minutes' },
  { value: '1800', label: '30 minutes' },
  { value: '3600', label: '1 hour' },
  { value: '10800', label: '3 hours' },
];

const WORKSPACE_HINT: Record<WorkspaceKind, string> = {
  scratch: 'A throwaway directory. Right for research and anything that writes no code.',
  worktree: 'A real git branch under the board’s project, so the work can be reviewed and merged.',
  dir: 'Run in a directory you name. The agent works in place — nothing is isolated.',
};

export function NewTaskSheet({ open, board, onClose, onCreated }: Props) {
  const slug = board ?? null;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState(0);
  const [triage, setTriage] = useState(true);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [skills, setSkills] = useState<string[]>([]);
  const [pickingSkills, setPickingSkills] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  const [runtime, setRuntime] = useState('');
  const [pickingRuntime, setPickingRuntime] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceKind>('scratch');
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const [workspacePath, setWorkspacePath] = useState('');
  const [projectId, setProjectId] = useState('');
  const [pickingProject, setPickingProject] = useState(false);

  const create = useCreateTask(slug);
  const estimate = useEstimate();
  const toast = useUi((s) => s.toast);
  const { data: profileData, isLoading: profilesLoading } = useProfiles();
  const profiles = profileData?.profiles ?? [];
  const orchestration = useOrchestration(open);
  const projects = useKanbanProjects(open && advanced);
  /* Skills are per-profile, so the list follows whoever will run the card —
     and it is fetched only once the picker is opened. Passing the profile as
     the *enabled* flag by mistake fetches the active profile's skills on every
     open of this sheet, which is both a wasted request and the wrong list. */
  const skillData = useSkills(assignee, pickingSkills);

  /**
   * Preselect the default profile once the list arrives.
   *
   * Only when nothing is chosen yet, so a refetch cannot overwrite a
   * deliberate pick while the sheet is open.
   */
  useEffect(() => {
    if (assignee) return;
    const preferred = profiles.find((p) => p.is_default) ?? profiles[0];
    if (preferred) setAssignee(preferred.name);
  }, [profiles, assignee]);

  /**
   * A fresh key per sheet-opening, so a double-tapped Create makes one card.
   *
   * Hermes returns the *existing* task for a key it has already seen rather
   * than creating a second one, which turns a retry the browser fired on a
   * flaky connection — the exact situation a phone is in — from a duplicate
   * card into a no-op. Regenerated on close so the next card is a new card.
   */
  const [idemKey, setIdemKey] = useState(() => newKey());
  useEffect(() => {
    if (open) setIdemKey(newKey());
  }, [open]);

  const reset = () => {
    setTitle('');
    setBody('');
    setPriority(0);
    setTriage(true);
    setAssignee(null);
    setAdvanced(false);
    setSkills([]);
    setGoalMode(false);
    setRuntime('');
    setWorkspace('scratch');
    setWorkspacePath('');
    setProjectId('');
  };

  const submit = async () => {
    if (!title.trim()) return;
    try {
      const res = await create.mutateAsync({
        title: title.trim(),
        body: body.trim() || undefined,
        priority,
        triage,
        idempotency_key: idemKey,
        // Omitted only when the profile list never loaded; the server's
        // `kanban.default_assignee` is the backstop for that case.
        assignee: assignee ?? undefined,
        ...(skills.length ? { skills } : {}),
        ...(goalMode ? { goal_mode: true } : {}),
        ...(runtime ? { max_runtime_seconds: Number(runtime) } : {}),
        ...(workspace !== 'scratch' ? { workspace_kind: workspace } : {}),
        ...(workspace === 'dir' && workspacePath.trim()
          ? { workspace_path: workspacePath.trim() }
          : {}),
        ...(projectId ? { project_id: projectId } : {}),
      });
      buzz('done');
      /* Not an error, and the one message that must not be swallowed: the card
         was created into Ready with an assignee and *no dispatcher is running*,
         so nothing will ever claim it. Hermes only says so here. */
      if (res.warning) toast(res.warning, 'error');
      else toast('Task created', 'success');
      reset();
      onCreated?.();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the task', 'error');
    }
  };

  const askEstimate = async () => {
    if (!title.trim()) return;
    buzz('tap');
    try {
      const res = await estimate.mutateAsync({ title: title.trim(), body: body.trim() || undefined });
      if (!res.ok) toast(res.reason ?? 'Could not estimate', 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not estimate', 'error');
    }
  };

  const skillOptions = useMemo(
    () =>
      (skillData.data ?? []).map((s) => ({
        value: s.name,
        label: s.name,
        hint: s.description ?? undefined,
      })),
    [skillData.data],
  );

  const autoSweeps = orchestration.data?.auto_decompose === true;
  /* Unpacked with a default rather than reached through: `data?.projects.length`
     guards only `data`, so a payload present but missing the key throws on a
     plain `.length` — and with no error boundary that blanks the app, not the
     sheet. Same shape as the one in `BoardHealthSheet`. */
  const projectList = projects.data?.projects ?? [];

  return (
    <Sheet open={open} onClose={onClose} title="New task">
      <input
        className="field"
        autoFocus
        placeholder="What needs doing?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        style={{ marginBottom: 9 }}
      />
      <textarea
        className="field"
        placeholder="Details for the agent (optional)…"
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        style={{ resize: 'vertical', marginBottom: 12 }}
      />

      <div className="group-head">RUN AS</div>
      {profiles.length > 0 ? (
        <div style={{ marginBottom: 14 }}>
          <ProfileField label="Assignee" title="Run as" value={assignee ?? ''} onChange={setAssignee} />
        </div>
      ) : (
        /* No picker to show, and saying so matters: an unassigned task is the
           one that silently never runs. */
        <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)', marginBottom: 14 }}>
          {profilesLoading
            ? 'Loading profiles…'
            : 'No profiles found — the task will use the server default.'}
        </div>
      )}

      <div className="group-head">PRIORITY</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[0, 1, 2, 3].map((p) => (
          <button
            key={p}
            className={`chip${priority === p ? ' chip--active' : ''}`}
            onClick={() => setPriority(p)}
          >
            {['none', 'low', 'high', 'urgent'][p]}
          </button>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 6,
          fontSize: 'var(--type-body-md)',
          color: 'var(--text-dim)',
        }}
      >
        <span style={{ flex: 1 }}>Start in Triage</span>
        <Switch checked={triage} onChange={setTriage} label="Start in Triage" />
      </div>
      <div
        style={{
          fontSize: 'var(--type-label-sm)',
          color: 'var(--text-faint)',
          marginBottom: 14,
          lineHeight: 1.45,
        }}
      >
        {triage
          ? autoSweeps
            ? 'The gateway picks Triage cards up on its own and splits them into subtasks.'
            : 'It waits there until you Specify or Split it — nothing sweeps Triage on this install.'
          : 'It goes straight to Ready — an agent claims it within the minute and runs it as written.'}
      </div>

      {/* An estimate before the card exists, which is the only moment it can
          change what you create. Behind a button because it runs a model. */}
      <div style={{ marginBottom: 14 }}>
        <button
          className="btn btn--sm"
          style={{ width: '100%' }}
          disabled={!title.trim() || estimate.isPending}
          onClick={() => void askEstimate()}
        >
          {estimate.isPending ? 'Asking the model…' : 'Estimate the effort first'}
        </button>
        {estimate.data?.ok && (
          <div
            style={{
              marginTop: 7,
              fontSize: 'var(--type-body-sm)',
              color: 'var(--text-dim)',
              lineHeight: 1.5,
            }}
          >
            <strong>{estimate.data.complexity ?? '?'}</strong>
            {typeof estimate.data.est_tokens === 'number' && estimate.data.est_tokens > 0 && (
              <> · ~{estimate.data.est_tokens.toLocaleString()} tokens</>
            )}
            {estimate.data.rationale && <div style={{ marginTop: 3 }}>{estimate.data.rationale}</div>}
          </div>
        )}
      </div>

      <button
        className="btn btn--sm"
        style={{ width: '100%', justifyContent: 'space-between', marginBottom: advanced ? 10 : 14 }}
        onClick={() => {
          buzz('tap');
          setAdvanced((v) => !v);
        }}
      >
        <span style={{ color: 'var(--text-dim)' }}>Advanced</span>
        <span style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)' }}>
          {advanced ? '▾' : '▸'}
        </span>
      </button>

      {advanced && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <SelectChip
              label="Skills"
              value={skills.length ? `${skills.length} pinned` : 'Agent default'}
              active={skills.length > 0}
              onOpen={() => setPickingSkills(true)}
            />
            <SelectChip
              label="Stops after"
              value={RUNTIME_CHOICES.find((r) => r.value === runtime)?.label ?? 'No limit'}
              active={Boolean(runtime)}
              onOpen={() => setPickingRuntime(true)}
            />
            <SelectChip
              label="Workspace"
              value={workspace}
              active={workspace !== 'scratch'}
              onOpen={() => setPickingWorkspace(true)}
            />
            {projectList.length > 0 && (
              <SelectChip
                label="Project"
                value={projectList.find((p) => p.id === projectId)?.name ?? 'None'}
                active={Boolean(projectId)}
                onOpen={() => setPickingProject(true)}
              />
            )}
          </div>

          {workspace === 'dir' && (
            <input
              className="field"
              placeholder="/absolute/path/the/agent/works/in"
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              style={{ marginBottom: 8 }}
            />
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontSize: 'var(--type-body-md)',
              color: 'var(--text-dim)',
              marginBottom: 5,
            }}
          >
            <span style={{ flex: 1 }}>Keep going until it is done</span>
            <Switch checked={goalMode} onChange={setGoalMode} label="Goal loop" />
          </div>
          <div style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', lineHeight: 1.45 }}>
            {goalMode
              ? 'A judge re-reads the work against this card after every turn and sends the agent back in until it agrees it is finished. Slower, and more expensive.'
              : 'One shot: the agent answers once and the card moves on.'}
          </div>

          <div
            style={{
              fontSize: 'var(--type-label-sm)',
              color: 'var(--text-faint)',
              marginTop: 10,
              lineHeight: 1.45,
            }}
          >
            None of these can be changed after the card exists — Hermes fixes them at creation.
          </div>
        </div>
      )}

      <button
        className="btn btn--primary"
        style={{ width: '100%' }}
        onClick={submit}
        disabled={!title.trim() || create.isPending}
      >
        {create.isPending ? 'Creating…' : 'Create task'}
      </button>

      <MultiSelectSheet
        open={pickingSkills}
        title="Force-load skills"
        options={skillOptions}
        selected={skills}
        onChange={setSkills}
        onClose={() => setPickingSkills(false)}
        loading={skillData.isLoading}
        emptyMeans="Nothing pinned means the agent loads its own skills as usual."
        emptyList="This profile has no skills installed."
      />
      <SelectSheet
        open={pickingRuntime}
        title="Stop the worker after"
        options={RUNTIME_CHOICES}
        value={runtime}
        onChange={setRuntime}
        onClose={() => setPickingRuntime(false)}
      />
      <SelectSheet
        open={pickingWorkspace}
        title="Where the agent works"
        options={WORKSPACE_KINDS.map((k) => ({ value: k, label: k, hint: WORKSPACE_HINT[k] }))}
        value={workspace}
        onChange={(v) => setWorkspace(v as WorkspaceKind)}
        onClose={() => setPickingWorkspace(false)}
      />
      <SelectSheet
        open={pickingProject}
        title="Project"
        options={[
          { value: '', label: 'None', hint: 'A scratch path rather than a repo' },
          ...projectList.map((p) => ({
            value: p.id,
            label: p.name,
            hint: p.primary_path,
          })),
        ]}
        value={projectId}
        onChange={setProjectId}
        onClose={() => setPickingProject(false)}
      />
    </Sheet>
  );
}

/**
 * A key unique to this attempt.
 *
 * `crypto.randomUUID` needs a secure context and the app runs happily over
 * plain HTTP on a LAN, where it is undefined — so the fallback is not
 * theoretical. It only has to be unique among this browser's own recent
 * creates, which a timestamp plus randomness comfortably is.
 */
function newKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `hem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
