/**
 * Models — what new sessions start on: the default model, the auxiliary
 * models, and Mixture-of-Agents presets.
 *
 * This was "Models and Usage", two sections behind a segmented control with
 * the URL saying which (commits 4cd6272 and 52be669 split them, a later change
 * merged them back). It is the Models tab of the Agent screen now, and Usage
 * is its own drawer destination again (`/usage`): the Agent screen's tab lives
 * in `?tab=`, which is exactly the parameter this screen used to pick its
 * half, so the two could not share a URL — and spend is read, not configured,
 * which is the line the drawer draws between Agent and Usage. `/models?tab=usage`
 * redirects to `/usage` (`legacyTarget` in `screens/HubPage.tsx`).
 *
 * The charts' weight is why that matters here: `UsageTab` pulls in recharts,
 * ~356 KB built, and is a lazy route of its own in `App.tsx`. Nothing in this
 * file may import it — `web/test/usage.test.ts` checks for exactly that.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DefaultModelSection } from './DefaultModelSection';
import { AuxiliaryModelSection } from './AuxiliaryModelSection';
import { MoaSection } from './MoaSection';
import { ProfileFilter } from '../shared/ProfileSelect';

export function ModelsTab() {
  const [params] = useSearchParams();
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
  // Seeded from `?profile=` so a link from a conversation's "Set up a model"
  // notice opens on that conversation's profile rather than the active one.
  const [profile, setProfile] = useState<string | null>(() => params.get('profile'));

  return (
    /* Top padding now that the Setup/Usage control above it is gone — the
       Agent screen's own tab row sits outside the scroll area. */
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 12 }}>
        <ProfileFilter value={profile} onChange={setProfile} />
      </div>
      <DefaultModelSection profile={profile} />
      <AuxiliaryModelSection profile={profile} />
      <MoaSection profile={profile} />
    </div>
  );
}
