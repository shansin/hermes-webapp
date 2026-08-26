/**
 * The two shapes a profile picker takes, so every screen picks one the same
 * way.
 *
 * Profiles are the coarsest cut in the app — they decide which store a screen
 * reads at all — and by the time there were five of them each screen was
 * spending a whole rail saying so. Both of these are one row whatever the
 * count, and both name the selection in the trigger rather than asking the
 * reader to spot the highlighted chip.
 *
 * - `ProfileFilter` scopes a *screen* (Sessions, Skills). Its value is
 *   `string | null` where **null is the active profile**, not its name:
 *   pinning the name would break the moment the profile was switched from
 *   somewhere else in the app. It renders nothing on a single-profile
 *   install, where the only choice on offer is the one already in force.
 * - `ProfileField` fills in a *form* (the cron job's store, a task's
 *   assignee). Its value is a plain name, because that is what gets sent.
 */
import { useState } from 'react';
import { SelectChip, SelectSheet, type SelectOption } from './SelectSheet';
import { PickerRow } from './MultiSelectSheet';
import { useActiveProfile, useProfiles } from '../../api/profiles';

/** The row hint that marks the profile Hermes is currently running as. */
const ACTIVE_HINT = 'The profile Hem is running as';

export function ProfileFilter({
  value,
  onChange,
}: {
  /** Null means the active profile — see the note at the top. */
  value: string | null;
  onChange: (profile: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const profiles = useProfiles().data?.profiles ?? [];
  const active = useActiveProfile().data?.active ?? null;

  // One profile is not a choice, and a picker offering it is furniture.
  if (profiles.length < 2) return null;

  const selected = value ?? active;
  const options: SelectOption[] = profiles.map((p) => ({
    value: p.name,
    label: p.name,
    hint: p.name === active ? ACTIVE_HINT : undefined,
    meta: p.name === active ? 'active' : undefined,
  }));

  return (
    <>
      <SelectChip
        label="Profile"
        value={selected ?? 'active'}
        /* Only a non-active selection is a narrowing worth flagging: the
           resting state of this control is "whatever is running", and painting
           that as an active filter makes every screen look filtered. */
        active={Boolean(value) && value !== active}
        onOpen={() => setOpen(true)}
      />
      <SelectSheet
        open={open}
        title="Profile"
        options={options}
        value={selected}
        /* Stored as null when it *is* the active one, so the screen keeps
           following a switch made elsewhere. */
        onChange={(name) => onChange(name === active ? null : name)}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export function ProfileField({
  label,
  value,
  onChange,
  options,
  placeholder = 'Choose…',
  title,
  disabled = false,
}: {
  label: string;
  /** The profile name, empty while none is chosen. */
  value: string;
  onChange: (profile: string) => void;
  /** Defaults to every profile; pass a list to add or narrow the choices. */
  options?: SelectOption[];
  placeholder?: string;
  title?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const profiles = useProfiles().data?.profiles ?? [];
  const active = useActiveProfile().data?.active ?? null;

  const opts: SelectOption[] =
    options ??
    profiles.map((p) => ({
      value: p.name,
      label: p.name,
      hint: p.name === active ? ACTIVE_HINT : undefined,
      meta: p.name === active ? 'active' : undefined,
    }));

  return (
    <>
      <PickerRow
        label={label}
        value={value || placeholder}
        onOpen={() => setOpen(true)}
        disabled={disabled}
      />
      <SelectSheet
        open={open}
        title={title ?? label}
        options={opts}
        value={value || null}
        onChange={onChange}
        onClose={() => setOpen(false)}
        empty="No profiles found."
      />
    </>
  );
}
