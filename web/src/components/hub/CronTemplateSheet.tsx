/**
 * "New from template": pick one of Hermes' cron blueprints, fill its slots,
 * choose where it delivers, create the job.
 *
 * The hand-written form asks for a cron expression and a prompt, which is
 * fine for a job you have already designed and a wall for one you have not.
 * Hermes ships a catalogue of the common ones — a morning brief, an inbox
 * watch, a weekly review — each a prompt template with a few slots, and the
 * desktop and chat platforms already offer it (`/blueprint`). This is that
 * catalogue as a sheet. The rules for what is sent are in
 * `lib/cronBlueprint.ts`.
 *
 * Two stages in one sheet rather than two sheets, so back from the form lands
 * on the list without a hand-off between overlays (see the `useHistoryDismiss`
 * note in CLAUDE.md). The schedule is read back as a sentence under the slots,
 * built locally the way the backend will build it — the same check the
 * hand-written form gives a typed expression, and the one that catches 08:00
 * meaning 8 in the evening to somebody.
 */
import { useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { SelectSheet } from '../shared/SelectSheet';
import { PickerRow } from '../shared/MultiSelectSheet';
import { ProfileField } from '../shared/ProfileSelect';
import { SkeletonList } from '../shared/misc';
import { useCronBlueprints, useCronDeliveryTargets, useInstantiateBlueprint } from '../../api/cronBlueprints';
import { ApiError } from '../../api/client';
import {
  blueprintPayload,
  blueprintProblems,
  blueprintSchedule,
  deliveryOptions,
  initialValues,
  type Blueprint,
  type BlueprintField,
} from '../../lib/cronBlueprint';
import { humanCron } from '../../lib/cronText';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

const WEEKDAY_LABELS: Record<string, string> = { everyday: 'Every day', weekdays: 'Weekdays', weekends: 'Weekends' };

const segBtn = (on: boolean) =>
  ({
    fontSize: 'var(--type-detail)',
    padding: '7px 11px',
    background: on ? 'var(--accent-soft)' : undefined,
    borderColor: on ? 'var(--accent)' : undefined,
    color: on ? 'var(--accent)' : undefined,
  }) as const;

function Segments({ options, value, onChange, label }: { options: string[]; value: string; onChange: (v: string) => void; label: (o: string) => string }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {options.map((o) => (
        <button key={o} className="btn" style={segBtn(value === o)} aria-pressed={value === o} onClick={() => onChange(o)}>
          {label(o)}
        </button>
      ))}
    </div>
  );
}

export function CronTemplateSheet({
  open,
  onClose,
  profiles,
  activeProfile,
}: {
  open: boolean;
  onClose: () => void;
  profiles: { name: string }[];
  activeProfile: string;
}) {
  const toast = useUi((s) => s.toast);
  const [picked, setPicked] = useState<Blueprint | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [profile, setProfile] = useState('');
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  /* Always a name: instantiate alone defaults to `default`, not to the active
     profile, so leaving it off would file the job somewhere unexpected. */
  const target = profile || activeProfile || profiles[0]?.name || null;
  const blueprints = useCronBlueprints(target, open);
  const targets = useCronDeliveryTargets(target, open && Boolean(picked));
  const create = useInstantiateBlueprint();

  const close = () => {
    setPicked(null);
    setServerError(null);
    setDeliverOpen(false);
    onClose();
  };

  const pick = (bp: Blueprint) => {
    buzz('tap');
    setPicked(bp);
    setValues(initialValues(bp));
    setServerError(null);
  };

  const set = (name: string, v: string) => {
    setValues((prev) => ({ ...prev, [name]: v }));
    setServerError(null);
  };

  const problems = picked ? blueprintProblems(picked, values) : {};
  const ready = picked && Object.keys(problems).length === 0;
  const expr = picked ? blueprintSchedule(picked, values) : null;
  const sentence = expr ? (humanCron(expr) ?? expr) : null;

  const submit = async () => {
    if (!picked || !ready) return;
    try {
      await create.mutateAsync({ profile: target, body: blueprintPayload(picked, values) });
      toast(`${picked.title} scheduled${profiles.length > 1 && target ? ` in ${target}` : ''}`, 'success');
      close();
    } catch (err) {
      // A 422 is a slot the backend refused, worded for a form; keep it in view.
      if (err instanceof ApiError && err.status === 422) setServerError(err.message);
      else toast(err instanceof Error ? err.message : 'Could not create the job', 'error');
    }
  };

  const field = (f: BlueprintField) => {
    const v = values[f.name] ?? '';
    const problem = problems[f.name];
    let control: React.ReactNode;
    if (f.name === 'deliver') {
      const opts = deliveryOptions(f, targets.data ?? []);
      const chosen = opts.find((o) => o.value === v);
      control = (
        <>
          <PickerRow label="Deliver to" value={chosen?.label ?? (v || 'Choose…')} onOpen={() => setDeliverOpen(true)} />
          {chosen?.hint && <div style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', marginTop: 4 }}>{chosen.hint}</div>}
          <SelectSheet
            open={deliverOpen}
            title="Deliver to"
            options={opts}
            value={v || null}
            onChange={(next) => set('deliver', next)}
            onClose={() => setDeliverOpen(false)}
          />
        </>
      );
    } else if (f.type === 'time') {
      control = (
        <input
          className="field"
          type="time"
          value={v}
          onChange={(e) => set(f.name, e.target.value)}
          aria-invalid={Boolean(problem)}
          style={{ fontFamily: 'var(--mono)' }}
        />
      );
    } else if (f.type === 'weekdays') {
      const opts = f.options.length ? f.options : Object.keys(WEEKDAY_LABELS);
      control = <Segments options={opts} value={v} onChange={(o) => set(f.name, o)} label={(o) => WEEKDAY_LABELS[o] ?? o} />;
    } else if (f.type === 'enum' && f.options.length) {
      control = (
        <Segments
          options={f.options}
          value={v}
          onChange={(o) => set(f.name, o)}
          label={(o) => (f.name === 'interval_min' ? `${o} min` : o[0]!.toUpperCase() + o.slice(1))}
        />
      );
    } else {
      control = (
        <textarea
          className="field"
          rows={2}
          value={v}
          placeholder={f.optional ? 'Optional' : undefined}
          onChange={(e) => set(f.name, e.target.value)}
          aria-invalid={Boolean(problem)}
          style={{ resize: 'vertical' }}
        />
      );
    }
    return (
      <div key={f.name} style={{ marginBottom: 12 }}>
        {f.name !== 'deliver' && (
          <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-dim)', marginBottom: 5 }}>{f.label}</div>
        )}
        {control}
        {(problem || f.help) && f.name !== 'deliver' && (
          <div
            style={{
              fontSize: 'var(--type-label-sm)',
              color: problem ? 'var(--error)' : 'var(--text-faint)',
              marginTop: 4,
              lineHeight: 1.45,
            }}
          >
            {problem ?? f.help}
          </div>
        )}
      </div>
    );
  };

  // Grouped by category, in the catalogue's own order.
  const groups = new Map<string, Blueprint[]>();
  for (const bp of blueprints.data ?? []) {
    const list = groups.get(bp.category) ?? [];
    list.push(bp);
    groups.set(bp.category, list);
  }

  return (
    <Sheet open={open} onClose={close} title={picked ? picked.title : 'New from template'}>
      {!picked ? (
        <>
          {profiles.length > 1 && (
            <div style={{ marginBottom: 12 }}>
              <ProfileField
                label="Runs as"
                title="Runs as"
                value={target ?? ''}
                onChange={(name) => setProfile(name)}
              />
            </div>
          )}
          {blueprints.isLoading ? (
            <SkeletonList n={4} h={54} />
          ) : blueprints.isError ? (
            <div style={{ color: 'var(--error)', fontSize: 'var(--type-body-sm)' }}>
              {blueprints.error instanceof Error ? blueprints.error.message : 'Could not load templates.'}
            </div>
          ) : groups.size === 0 ? (
            <div style={{ color: 'var(--text-faint)', fontSize: 'var(--type-body-sm)' }}>
              This Hermes offers no templates.
            </div>
          ) : (
            [...groups.entries()].map(([category, list]) => (
              <div key={category}>
                <div className="group-head">{category.toUpperCase()}</div>
                {list.map((bp) => (
                  <button
                    key={bp.key}
                    className="card"
                    onClick={() => pick(bp)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, color: 'var(--text)' }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 'var(--type-body-md)' }}>{bp.title}</div>
                    {bp.description && (
                      <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.45 }}>
                        {bp.description}
                      </div>
                    )}
                    {bp.scheduleHuman && (
                      <div style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', marginTop: 4 }}>
                        {bp.scheduleHuman}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </>
      ) : (
        <>
          {picked.description && (
            <div style={{ fontSize: 'var(--type-body-sm)', color: 'var(--text-dim)', marginBottom: 12, lineHeight: 1.45 }}>
              {picked.description}
            </div>
          )}
          {picked.fields.map(field)}
          <div
            style={{
              fontSize: 'var(--type-body-sm)',
              color: serverError ? 'var(--error)' : 'var(--text-faint)',
              margin: '0 2px 12px',
              lineHeight: 1.45,
            }}
          >
            {serverError ?? (sentence ? `Runs ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}` : ' ')}
            {!serverError && profiles.length > 1 && target ? ` · as ${target}` : ''}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setPicked(null)}>
              Back
            </button>
            <button
              className="btn btn--primary"
              style={{ flex: 1 }}
              disabled={!ready || create.isPending}
              onClick={() => void submit()}
            >
              {create.isPending ? 'Creating…' : 'Create job'}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
