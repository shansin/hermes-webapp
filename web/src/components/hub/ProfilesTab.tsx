/**
 * Profiles — switch, create, delete.
 *
 * Switching is the primary action, so a card *is* the switch button; create and
 * delete are secondary. Deleting is guarded because it removes a whole
 * configuration directory: that profile's skills, memory and cron jobs go with
 * it, which a phone tap should never do silently.
 */
import { useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { Empty, ErrorNote, Loader, SkeletonList } from '../shared/misc';
import { IconCheck, IconPlus, IconTrash } from '../shared/Icons';
import {
  useActiveProfile,
  useCreateProfile,
  useDeleteProfile,
  useProfiles,
  useSwitchProfile,
  type Profile,
} from '../../api/profiles';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

export function ProfilesTab() {
  const list = useProfiles();
  const active = useActiveProfile();
  const switchTo = useSwitchProfile();
  const create = useCreateProfile();
  const del = useDeleteProfile();
  const toast = useUi((s) => s.toast);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [cloneFrom, setCloneFrom] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<Profile | null>(null);

  const activeName = active.data?.active ?? active.data?.current ?? '';
  const profiles = list.data?.profiles ?? [];

  const doSwitch = async (p: Profile) => {
    if (p.name === activeName) return;
    buzz('tap');
    try {
      await switchTo.mutateAsync(p.name);
      buzz('done');
      toast(`Switched to ${p.name}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not switch profile', 'error');
    }
  };

  const doCreate = async () => {
    const clean = name.trim();
    if (!clean) return;
    try {
      await create.mutateAsync({
        name: clean,
        description: description.trim() || undefined,
        clone_from: cloneFrom || undefined,
      });
      buzz('done');
      toast(`Created ${clean}`, 'success');
      setCreating(false);
      setName('');
      setDescription('');
      setCloneFrom('');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create profile', 'error');
    }
  };

  const doDelete = async (p: Profile) => {
    setConfirmDelete(null);
    try {
      await del.mutateAsync(p.name);
      buzz('done');
      toast(`Deleted ${p.name}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete profile', 'error');
    }
  };

  if (list.isLoading) return <SkeletonList n={3} h={72} />;
  if (list.error) return <ErrorNote error={list.error} />;

  return (
    <div style={{ padding: '12px 12px 20px' }}>
      {switchTo.isPending && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Loader size="sm" muted />
          <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>
            Reloading config, skills, memory and cron…
          </span>
        </div>
      )}

      {profiles.length === 0 ? (
        <Empty icon="👤" title="No profiles" hint="Hermes reported no configured profiles." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {profiles.map((p) => {
            const isActive = p.name === activeName;
            return (
              <div
                key={p.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: isActive ? 'var(--accent-soft)' : 'var(--bg-elev)',
                  border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border-soft)'}`,
                  borderRadius: 'var(--radius-sm)',
                  padding: '11px 12px',
                }}
              >
                <button
                  onClick={() => void doSwitch(p)}
                  disabled={switchTo.isPending}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: 'none',
                    border: 'none',
                    textAlign: 'left',
                    font: 'inherit',
                    color: 'inherit',
                    cursor: isActive ? 'default' : 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ fontWeight: 600, fontSize: 'var(--type-title-sm)' }}>
                      {p.name}
                    </span>
                    {p.is_default && (
                      <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>default</span>
                    )}
                    {/* Green dot = this profile's gateway process is up. */}
                    <span
                      title={p.gateway_running ? 'Gateway running' : 'Gateway stopped'}
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: p.gateway_running ? 'var(--ok)' : 'var(--border)',
                      }}
                    />
                    {isActive && <IconCheck size={15} style={{ color: 'var(--accent)' }} />}
                  </div>

                  {p.description && (
                    <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 3 }}>
                      {p.description}
                    </div>
                  )}

                  <div
                    style={{
                      fontSize: 'var(--type-label-sm)',
                      color: 'var(--text-faint)',
                      marginTop: 3,
                      display: 'flex',
                      gap: 9,
                      flexWrap: 'wrap',
                    }}
                  >
                    {p.model && <span>{p.model}</span>}
                    <span>{p.skill_count} skills</span>
                  </div>
                </button>

                {!p.is_default && (
                  <button
                    className="icon-btn icon-btn--danger"
                    aria-label={`Delete ${p.name}`}
                    onClick={() => {
                      buzz('warn');
                      setConfirmDelete(p);
                    }}
                  >
                    <IconTrash size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <button
        className="btn"
        style={{ marginTop: 14, width: '100%' }}
        onClick={() => {
          buzz('tap');
          setCreating(true);
        }}
      >
        <IconPlus size={16} /> New profile
      </button>

      <Sheet
        open={creating}
        title="New profile"
        onClose={() => setCreating(false)}
        actions={
          <>
            <button className="btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              disabled={!name.trim() || create.isPending}
              onClick={() => void doCreate()}
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </button>
          </>
        }
      >
        <label className="field-label">Name</label>
        <input
          autoFocus
          className="field"
          placeholder="research"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: '100%', marginBottom: 12 }}
        />

        <label className="field-label">Description</label>
        <input
          className="field"
          placeholder="Optional"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ width: '100%', marginBottom: 12 }}
        />

        <label className="field-label">Clone config from</label>
        <select
          className="field"
          value={cloneFrom}
          onChange={(e) => setCloneFrom(e.target.value)}
          style={{ width: '100%' }}
        >
          <option value="">Start empty</option>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '10px 2px 0' }}>
          Cloning copies the source profile's configuration and skills as a starting point.
        </p>
      </Sheet>

      <Sheet
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.name ?? ''}?`}
        onClose={() => setConfirmDelete(null)}
        actions={
          <>
            <button className="btn" onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
            <button
              className="btn btn--danger"
              onClick={() => confirmDelete && void doDelete(confirmDelete)}
            >
              Delete
            </button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, color: 'var(--text-dim)', margin: 0 }}>
          This removes the profile's whole configuration directory — its skills, memory and
          cron jobs go with it. Sessions created under it are not deleted. This cannot be
          undone.
        </p>
      </Sheet>
    </div>
  );
}
