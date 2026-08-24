/**
 * Profiles — switch, create, delete.
 *
 * Switching is the primary action, so a card *is* the switch button; create and
 * delete are secondary. Deleting is guarded because it removes a whole
 * configuration directory: that profile's skills, memory and cron jobs go with
 * it, which a phone tap should never do silently.
 *
 * ## What creation asks for
 *
 * A profile is an entire Hermes configuration, and this sheet used to collect
 * a name, a sentence, and optionally something to copy — so every profile
 * arrived identical to the default one and had to be configured afterwards,
 * from other screens, after switching to it. The create endpoint has always
 * taken more than that; the four fields below are the whole of what it
 * accepts, which is the point. There is nothing left that has to be fixed up
 * later.
 *
 * The one that is not obvious is `no_skills`. A fresh profile is seeded with
 * the stock skill set, which is right for a general assistant and wrong for a
 * narrow one — and once seeded, paring it back is a trip through the Skills
 * screen toggling things off one at a time.
 */
import { useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { Empty, ErrorNote, Loader, SkeletonList, Switch } from '../shared/misc';
import { IconCheck, IconChevron, IconPlus, IconTrash } from '../shared/Icons';
import { ModelPicker } from '../shared/ModelPicker';
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

/**
 * What Hermes will accept as a profile name.
 *
 * It becomes a directory under `~/.hermes/profiles`, so the backend rejects
 * anything else — with a 400 that arrives after the sheet has closed over the
 * form, losing whatever else had been filled in. Checking here costs one
 * regex and keeps the rejection next to the field that caused it.
 */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

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
  const [model, setModel] = useState<{ model: string; provider: string } | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [withSkills, setWithSkills] = useState(true);
  const [switchAfter, setSwitchAfter] = useState(false);
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

  const nameTaken = profiles.some((p) => p.name === name.trim());
  const nameError =
    !name.trim() || NAME_RE.test(name.trim())
      ? nameTaken
        ? 'A profile with that name already exists.'
        : null
      : 'Lowercase letters, digits, dot, dash and underscore only.';

  const resetForm = () => {
    setName('');
    setDescription('');
    setCloneFrom('');
    setModel(null);
    setWithSkills(true);
    setSwitchAfter(false);
  };

  const doCreate = async () => {
    const clean = name.trim();
    if (!clean || nameError) return;
    try {
      await create.mutateAsync({
        name: clean,
        description: description.trim() || undefined,
        clone_from: cloneFrom || undefined,
        // Both or neither: a model without its provider is ambiguous wherever
        // two providers serve the same id, which for the open-weight models is
        // most of them.
        provider: model?.provider,
        model: model?.model,
        // Sent only when it is the non-default answer, so a backend that does
        // not know the flag behaves exactly as it did before.
        no_skills: withSkills ? undefined : true,
      });
      buzz('done');
      toast(`Created ${clean}`, 'success');
      /* Switching is a second request on purpose. Create does not activate,
         and doing both in one silent step would make a profile you meant to
         set up for later take over the session you were in the middle of. */
      if (switchAfter) {
        await switchTo.mutateAsync(clean);
        toast(`Switched to ${clean}`, 'success');
      }
      setCreating(false);
      resetForm();
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
              disabled={!name.trim() || Boolean(nameError) || create.isPending || switchTo.isPending}
              onClick={() => void doCreate()}
            >
              {create.isPending ? 'Creating…' : switchTo.isPending ? 'Switching…' : 'Create'}
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
          aria-invalid={Boolean(nameError)}
          style={{ width: '100%', marginBottom: nameError ? 4 : 12 }}
        />
        {nameError && (
          <p style={{ fontSize: 12, color: 'var(--error)', margin: '0 2px 12px' }}>{nameError}</p>
        )}

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
        <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '10px 2px 14px' }}>
          Cloning copies the source profile's configuration and skills as a starting point.
        </p>

        <label className="field-label">Model</label>
        {/* A row that opens the picker, rather than the picker inline: a stock
            install exposes hundreds of models, and burying the rest of this
            form under all of them would make the two fields below it
            unreachable on a phone. */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
          <button
            className="field"
            onClick={() => {
              buzz('tap');
              setModelOpen(true);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              textAlign: 'left',
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: model ? 'var(--mono)' : undefined,
                color: model ? 'var(--text)' : 'var(--text-faint)',
              }}
            >
              {model ? model.model : 'Inherit the default'}
            </span>
            <IconChevron size={16} />
          </button>
          {/* A sibling, not a control inside the row: nesting a button in a
              button is invalid, and the browsers that tolerate it disagree
              about which one a tap belongs to. */}
          {model && (
            <button className="btn btn--sm" onClick={() => setModel(null)}>
              Clear
            </button>
          )}
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '0 2px 14px' }}>
          Pinned to this profile, so switching to it switches model too.
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 12,
            fontSize: 'var(--type-body-md)',
            color: 'var(--text-dim)',
          }}
        >
          <span style={{ flex: 1 }}>
            Install the default skills
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-faint)' }}>
              Off gives an empty profile to build up deliberately.
            </span>
          </span>
          <Switch checked={withSkills} onChange={setWithSkills} label="Install the default skills" />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 'var(--type-body-md)',
            color: 'var(--text-dim)',
          }}
        >
          <span style={{ flex: 1 }}>
            Switch to it now
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-faint)' }}>
              Reloads config, skills, memory and cron.
            </span>
          </span>
          <Switch checked={switchAfter} onChange={setSwitchAfter} label="Switch to it now" />
        </div>
      </Sheet>

      {/* Stacked over the create sheet rather than replacing it: the form
          behind is half-filled, and `useHistoryDismiss` nests, so back closes
          this one and leaves that one exactly as it was. */}
      <Sheet open={modelOpen} title="Model for this profile" onClose={() => setModelOpen(false)}>
        <ModelPicker
          selected={model?.model}
          onPick={(m, provider) => {
            buzz('tap');
            setModel({ model: m, provider });
            setModelOpen(false);
          }}
        />
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
