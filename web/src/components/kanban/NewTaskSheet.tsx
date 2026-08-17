import { useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { useCreateTask } from '../../api/kanban';
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

  const create = useCreateTask();
  const toast = useUi((s) => s.toast);

  const submit = async () => {
    if (!title.trim()) return;
    try {
      await create.mutateAsync({
        title: title.trim(),
        body: body.trim() || undefined,
        priority,
        triage,
      });
      buzz('done');
      toast('Task created', 'success');
      setTitle('');
      setBody('');
      setPriority(0);
      setTriage(false);
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

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          marginBottom: 16,
          fontSize: 14,
          color: 'var(--text-dim)',
        }}
      >
        <input type="checkbox" checked={triage} onChange={(e) => setTriage(e.target.checked)} />
        Send to triage instead of the ready queue
      </label>

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
