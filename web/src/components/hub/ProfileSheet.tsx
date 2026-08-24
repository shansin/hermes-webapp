/**
 * Editing a profile — everything about it except creating and switching.
 *
 * The profiles screen could create a profile and delete a profile, and nothing
 * in between. That made the create sheet a one-way door: whatever you chose
 * there was the profile forever, and correcting any of it meant SSH. Worse,
 * the one field that most defines a profile — its `SOUL.md`, the standing
 * instructions that say what the agent is *for* — was not visible from the app
 * at all. Every endpoint used here already existed on the backend.
 *
 * ## Why the skills number is here and not on the list
 *
 * `skill_count` on the profile list counts `SKILL.md` files on disk. Disabling
 * a skill writes it into the profile's `skills.disabled` and leaves the file
 * alone — so a profile deliberately narrowed to sixteen skills still reports
 * eighty-nine, and rendering that as "89 skills" makes a narrowed profile look
 * untouched. That is what the list row now calls "installed".
 *
 * The number that describes what the agent can actually do is the enabled one,
 * and it costs a request per profile, so it is paid here — once, for the
 * profile being edited — rather than on every row of a list nobody asked to
 * audit.
 *
 * ## Saving
 *
 * Each field saves on its own, against its own endpoint, because that is how
 * the backend is shaped — there is no "update profile" call to batch them
 * into. The sheet therefore never claims to have saved more than it did: a
 * failed model write does not roll back a description that already landed, and
 * each control reports its own outcome.
 */
import { useEffect, useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { Loader } from '../shared/misc';
import { ModelPicker } from '../shared/ModelPicker';
import { MultiSelectSheet, PickerRow, type MultiSelectOption } from '../shared/MultiSelectSheet';
import { IconTrash } from '../shared/Icons';
import { useSkills, useToggleSkill } from '../../api/hub';
import {
  useDescribeProfileAuto,
  useProfileSoul,
  useRenameProfile,
  useSetProfileDescription,
  useSetProfileModel,
  useSetProfileSoul,
  type Profile,
} from '../../api/profiles';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

/** Same rule the create sheet enforces — the name becomes a directory. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function ProfileSheet({
  profile,
  onClose,
  onDelete,
}: {
  profile: Profile | null;
  onClose: () => void;
  /** Delete stays with the list, which owns the confirmation. */
  onDelete: (p: Profile) => void;
}) {
  const name = profile?.name ?? null;
  const toast = useUi((s) => s.toast);

  const skills = useSkills(name, Boolean(name));
  const soul = useProfileSoul(name);

  const rename = useRenameProfile();
  const setDescription = useSetProfileDescription();
  const describeAuto = useDescribeProfileAuto();
  const setModel = useSetProfileModel();
  const setSoul = useSetProfileSoul();
  const toggleSkill = useToggleSkill();

  const [newName, setNewName] = useState('');
  const [description, setDescriptionText] = useState('');
  const [soulText, setSoulText] = useState('');
  const [pickingModel, setPickingModel] = useState(false);
  const [pickingSkills, setPickingSkills] = useState(false);

  /**
   * Reload the server's values whenever a different profile is opened.
   *
   * Keyed on the name rather than on the profile object: the list refetches on
   * a 30s stale window, and resetting the fields every time a new object
   * arrived would wipe whatever was half-typed.
   */
  useEffect(() => {
    setNewName(profile?.name ?? '');
    setDescriptionText(profile?.description ?? '');
    setPickingModel(false);
    setPickingSkills(false);
  }, [profile?.name]);

  // Separate effect: the document arrives from its own request, later than the
  // profile row does.
  useEffect(() => {
    if (soul.data) setSoulText(soul.data.content);
  }, [soul.data]);

  if (!profile || !name) return null;

  const enabled = (skills.data ?? []).filter((s) => s.enabled);
  const skillOptions: MultiSelectOption[] = (skills.data ?? []).map((s) => ({
    value: s.name,
    label: s.name,
    hint: s.description,
    meta: s.category,
  }));

  const nameChanged = newName.trim() !== profile.name && newName.trim().length > 0;
  const nameInvalid = nameChanged && !NAME_RE.test(newName.trim());
  const descriptionChanged = description.trim() !== (profile.description ?? '').trim();
  const soulChanged = soul.data ? soulText !== soul.data.content : false;

  const doRename = async () => {
    try {
      await rename.mutateAsync({ name, newName: newName.trim() });
      buzz('done');
      toast(`Renamed to ${newName.trim()}`, 'success');
      // The row this sheet was opened from no longer exists under the old
      // name, so there is nothing coherent left to show.
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not rename', 'error');
    }
  };

  const doDescription = async () => {
    try {
      await setDescription.mutateAsync({ name, description: description.trim() });
      buzz('done');
      toast('Description saved', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the description', 'error');
    }
  };

  const doDescribeAuto = async () => {
    try {
      const res = await describeAuto.mutateAsync(name);
      // Reports failure in the body rather than as an error status, so a bare
      // `await` that did not throw proves nothing.
      if (!res.ok) {
        toast(res.reason || 'Could not generate a description', 'error');
        return;
      }
      setDescriptionText(res.description ?? '');
      buzz('done');
      toast('Description generated', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not generate a description', 'error');
    }
  };

  const doModel = async (model: string, provider: string) => {
    try {
      await setModel.mutateAsync({ name, model, provider });
      buzz('done');
      toast(`${name} will use ${model}`, 'success');
      setPickingModel(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not set the model', 'error');
    }
  };

  const doSoul = async () => {
    try {
      await setSoul.mutateAsync({ name, content: soulText });
      buzz('done');
      toast('Instructions saved', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save SOUL.md', 'error');
    }
  };

  /**
   * Skills are committed one at a time, as the picker changes them.
   *
   * The endpoint is a per-skill toggle, so a diff against the previous
   * selection is the only way to drive it. Failures are reported per skill and
   * the list refetches, which is what puts a failed toggle back where it was
   * rather than leaving the UI asserting something untrue.
   */
  const doSkills = async (next: string[]) => {
    const chosen = new Set(next);
    const before = new Set(enabled.map((s) => s.name));
    const changes = [
      ...[...chosen].filter((n) => !before.has(n)).map((n) => ({ name: n, enabled: true })),
      ...[...before].filter((n) => !chosen.has(n)).map((n) => ({ name: n, enabled: false })),
    ];
    for (const change of changes) {
      try {
        await toggleSkill.mutateAsync({ ...change, profile: name });
      } catch (e) {
        toast(
          e instanceof Error ? `${change.name}: ${e.message}` : `Could not toggle ${change.name}`,
          'error',
        );
      }
    }
    if (changes.length) buzz('done');
  };

  return (
    <>
      <Sheet open={Boolean(profile)} title={profile.name} onClose={onClose}>
        <label className="field-label">Name</label>
        <div style={{ display: 'flex', gap: 6, marginBottom: nameInvalid ? 4 : 12 }}>
          <input
            className="field"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-invalid={nameInvalid}
            style={{ flex: 1, minWidth: 0 }}
          />
          {nameChanged && (
            <button
              className="btn btn--sm"
              disabled={nameInvalid || rename.isPending}
              onClick={() => void doRename()}
            >
              {rename.isPending ? '…' : 'Rename'}
            </button>
          )}
        </div>
        {nameInvalid && (
          <p style={{ fontSize: 12, color: 'var(--error)', margin: '0 2px 12px' }}>
            Lowercase letters, digits, dot, dash and underscore only.
          </p>
        )}
        {profile.is_default && (
          <p style={{ fontSize: 11.5, color: 'var(--text-faint)', margin: '0 2px 12px' }}>
            Renaming the default profile changes only how it is shown; its id stays
            <code> default</code>.
          </p>
        )}

        <label className="field-label">Description</label>
        <textarea
          className="field"
          rows={3}
          placeholder="What is this profile good at?"
          value={description}
          onChange={(e) => setDescriptionText(e.target.value)}
          style={{ width: '100%', resize: 'vertical', marginBottom: 6 }}
        />
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <button
            className="btn btn--sm"
            disabled={!descriptionChanged || setDescription.isPending}
            onClick={() => void doDescription()}
          >
            {setDescription.isPending ? 'Saving…' : 'Save description'}
          </button>
          <button
            className="btn btn--sm btn--ghost"
            disabled={describeAuto.isPending}
            onClick={() => void doDescribeAuto()}
          >
            {describeAuto.isPending ? 'Writing…' : 'Generate'}
          </button>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--text-faint)', margin: '0 2px 14px', lineHeight: 1.45 }}>
          The kanban decomposer routes tasks on this text, so it is worth being specific about
          what the profile is <em>not</em> for as well.
        </p>

        <label className="field-label">Model</label>
        <div style={{ marginBottom: 14 }}>
          <PickerRow
            label="Pinned model"
            value={profile.model || 'Follows the global default'}
            onOpen={() => setPickingModel(true)}
          />
        </div>

        <label className="field-label">Skills</label>
        <div style={{ marginBottom: 14 }}>
          <PickerRow
            label="Enabled"
            /* Deliberately no denominator. The profile row shows the count of
               SKILL.md files on disk (89 here); this endpoint lists 84,
               because it drops paths it excludes. Both numbers are correct
               about different things, and putting them on one screen as
               "16 of 84" beside "89 installed" invites the reader to work out
               which is lying. The number that answers the question is the
               enabled one; the full list is one tap away. */
            value={skills.isLoading ? 'Loading…' : `${enabled.length} enabled`}
            onOpen={() => setPickingSkills(true)}
            disabled={skills.isLoading || !skills.data}
          />
          <p style={{ fontSize: 11.5, color: 'var(--text-faint)', margin: '6px 2px 0', lineHeight: 1.45 }}>
            Disabling leaves the skill installed; it just stops being loaded. That is why the
            list shows both numbers.
          </p>
        </div>

        <label className="field-label">Standing instructions (SOUL.md)</label>
        {soul.isLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 14px' }}>
            <Loader size="sm" muted />
            <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>Loading…</span>
          </div>
        ) : (
          <>
            <textarea
              className="field"
              rows={12}
              placeholder="What this agent is for, how it should work, what it must always do…"
              value={soulText}
              onChange={(e) => setSoulText(e.target.value)}
              style={{
                width: '100%',
                resize: 'vertical',
                marginBottom: 6,
                fontFamily: 'var(--mono)',
                fontSize: 12.5,
                lineHeight: 1.5,
              }}
            />
            <button
              className="btn btn--sm"
              style={{ marginBottom: 6 }}
              disabled={!soulChanged || setSoul.isPending}
              onClick={() => void doSoul()}
            >
              {setSoul.isPending ? 'Saving…' : 'Save instructions'}
            </button>
            <p
              style={{
                fontSize: 11.5,
                color: 'var(--text-faint)',
                margin: '0 2px 16px',
                lineHeight: 1.45,
              }}
            >
              Saving replaces the whole file. It is read fresh each time this opens, so an edit
              made in a terminal is not silently overwritten — but two editors at once still
              means last-write-wins.
            </p>
          </>
        )}

        {!profile.is_default && (
          <button
            className="btn btn--danger"
            style={{ width: '100%' }}
            onClick={() => {
              buzz('warn');
              onDelete(profile);
            }}
          >
            <IconTrash size={15} /> Delete profile
          </button>
        )}
      </Sheet>

      {/* Stacked, so backing out of a picker returns to the editor rather than
          closing everything — `useHistoryDismiss` nests for exactly this. */}
      <Sheet
        open={pickingModel}
        title={`Model for ${profile.name}`}
        onClose={() => setPickingModel(false)}
      >
        <ModelPicker
          selected={profile.model || undefined}
          onPick={(model, provider) => void doModel(model, provider)}
          busy={setModel.isPending}
        />
      </Sheet>

      <MultiSelectSheet
        open={pickingSkills}
        title={`Skills in ${profile.name}`}
        options={skillOptions}
        selected={enabled.map((s) => s.name)}
        onChange={(next) => void doSkills(next)}
        onClose={() => setPickingSkills(false)}
        loading={skills.isLoading}
        emptyMeans="Nothing enabled — this profile loads no skills at all."
        emptyList="No skills installed in this profile."
      />
    </>
  );
}
