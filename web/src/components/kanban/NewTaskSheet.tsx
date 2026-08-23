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
 */
import { useEffect, useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { Switch } from '../shared/misc';
import { useCreateTask } from '../../api/kanban';
import { useProfiles } from '../../api/profiles';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

export function NewTaskSheet({ open, onClose, onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState(0);
  const [triage, setTriage] = useState(false);
  const [assignee, setAssignee] = useState<string | null>(null);

  const create = useCreateTask();
  const toast = useUi((s) => s.toast);
  const { data: profileData, isLoading: profilesLoading } = useProfiles();
  const profiles = profileData?.profiles ?? [];

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

  const submit = async () => {
    if (!title.trim()) return;
    try {
      await create.mutateAsync({
        title: title.trim(),
        body: body.trim() || undefined,
        priority,
        triage,
        // Omitted only when the profile list never loaded; the server's
        // `kanban.default_assignee` is the backstop for that case.
        assignee: assignee ?? undefined,
      });
      buzz('done');
      toast('Task created', 'success');
      setTitle('');
      setBody('');
      setPriority(0);
      setTriage(false);
      setAssignee(null);
      onCreated?.();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the task', 'error');
    }
  };

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

      <div style={{ fontSize: 12, color: 'var(--text-faint)', fontWeight: 650, marginBottom: 6 }}>
        RUN AS
      </div>
      {profiles.length > 0 ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {profiles.map((p) => (
            <button
              key={p.name}
              className={`chip${assignee === p.name ? ' chip--active' : ''}`}
              onClick={() => {
                buzz('tap');
                setAssignee(p.name);
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      ) : (
        /* No picker to show, and saying so matters: an unassigned task is the
           one that silently never runs. */
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginBottom: 14 }}>
          {profilesLoading
            ? 'Loading profiles…'
            : 'No profiles found — the task will use the server default.'}
        </div>
      )}

      <div style={{ fontSize: 12, color: 'var(--text-faint)', fontWeight: 650, marginBottom: 6 }}>
        PRIORITY
      </div>
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
          marginBottom: 16,
          fontSize: 'var(--type-body-md)',
          color: 'var(--text-dim)',
        }}
      >
        <span style={{ flex: 1 }}>Send to triage instead of the ready queue</span>
        <Switch checked={triage} onChange={setTriage} label="Send to triage" />
      </div>

      <button
        className="btn btn--primary"
        style={{ width: '100%' }}
        onClick={submit}
        disabled={!title.trim() || create.isPending}
      >
        {create.isPending ? 'Creating…' : 'Create task'}
      </button>
    </Sheet>
  );
}
