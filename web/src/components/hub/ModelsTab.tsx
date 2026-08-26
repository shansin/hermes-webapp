/**
 * Models — what new sessions start on, and what the models have cost.
 *
 * These were one screen, then two, and are now one again. Commits 4cd6272 and
 * 52be669 split them: reading spend on a screen named for model selection was
 * the complaint, and any breakdown Usage grew would have had a stale twin next
 * to the picker. That reasoning still holds for a *card* of numbers beside the
 * picker, which is what it was arguing against — so the two live here as
 * sibling sections behind a segmented control, never on screen together, with
 * the URL saying which one you are on.
 *
 * **The usage half is loaded on demand, and that is not an optimisation.**
 * `UsageTab` pulls in recharts and weighs ~356 KB built — the second-largest
 * chunk we ship. Importing it normally would put all of it on the navigation of
 * someone who came here to change a model, which is the common reason to come
 * here at all. The `lazy()` below is what keeps it out of this chunk: Rollup
 * splits on the dynamic import wherever it appears, so the boundary works the
 * same one level down from `App.tsx` as it did in it. A static
 * `import { UsageTab }` here would silently inline the whole thing — see
 * `web/test/usage.test.ts`, which checks this file for exactly that.
 */
import { Suspense, lazy, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DefaultModelSection } from './DefaultModelSection';
import { AuxiliaryModelSection } from './AuxiliaryModelSection';
import { ProfileFilter } from '../shared/ProfileSelect';
import { buzz } from '../../lib/haptics';

const UsageSection = lazy(() =>
  import('./UsageTab').then((m) => ({ default: m.UsageTab })),
);

/** The two sections, in the order they appear. Setup is the default. */
const SECTIONS = [
  { id: 'setup', label: 'Setup' },
  { id: 'usage', label: 'Usage' },
] as const;

export function ModelsTab() {
  const [params, setParams] = useSearchParams();
  /**
   * Which profile's models are being set. Null is the active one, and on a
   * single-profile install `ProfileFilter` renders nothing at all — so this
   * costs that install neither a control nor a decision.
   *
   * The screen used to have no such choice, which did not make it
   * profile-independent: model config is per-profile, so it simply wrote
   * whichever profile happened to be active while presenting itself as *the*
   * default. Scoping the screen is the same pattern Sessions and Skills use,
   * and for the same reason — see `shared/ProfileSelect.tsx`.
   */
  const [profile, setProfile] = useState<string | null>(null);
  // Anything unrecognised falls back to the picker rather than to a blank
  // screen — a hand-typed or stale `?tab=` must not strand anyone.
  const tab = params.get('tab') === 'usage' ? 'usage' : 'setup';

  return (
    <>
      <div className="btn-group" role="tablist" aria-label="Models section">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={tab === s.id}
            className={`btn-group__item${tab === s.id ? ' btn-group__item--active' : ''}`}
            onClick={() => {
              buzz('tap');
              // `replace`: flipping between two halves of one screen is not a
              // place you should have to press back through to leave it.
              setParams(s.id === 'usage' ? { tab: 'usage' } : {}, { replace: true });
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {tab === 'usage' ? (
        <Suspense fallback={<div className="route-pending" aria-busy="true" />}>
          <UsageSection />
        </Suspense>
      ) : (
        <div style={{ padding: '0 12px 12px' }}>
          <div style={{ marginBottom: 12 }}>
            <ProfileFilter value={profile} onChange={setProfile} />
          </div>
          <DefaultModelSection profile={profile} />
          <AuxiliaryModelSection profile={profile} />
        </div>
      )}
    </>
  );
}
