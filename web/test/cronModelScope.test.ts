/**
 * What the cron sheet says an unpinned job runs on.
 *
 * There is no global model, and the sheet said there was. `model.provider` /
 * `model.default` live in each profile's own `config.yaml`, and a job runs
 * against the home of the store its `cron/jobs.json` sits in — so an unpinned
 * job follows *that* profile's default. The list it appears in is already
 * every profile's jobs (`/api/cron/jobs` defaults to `profile=all`), so the
 * job on screen routinely belongs to a profile the app is not pointed at.
 *
 * The failure was quiet and complete: a job in `fitness`, unpinned, labelled
 * "Follows global default", ran on `ornith-1.5:35b-256k` while the Models
 * screen showed `qwen3.8:27b-188k`. Nothing was broken — the inheritance was
 * correct — but the only sentence describing it named the wrong thing, so the
 * run looked like the job ignoring its own configuration.
 *
 * Two rules are worth pinning here, because both are easy to undo:
 *
 * - **Name the profile only when there is more than one.** On a single-profile
 *   install there is exactly one answer and naming it is chrome for a
 *   distinction that does not exist — the same rule the profile badge on each
 *   row follows.
 * - **Never claim a model that is not known.** The note is built from the
 *   profile list the screen already holds; a profile missing from it, or one
 *   with no model configured, has to fall back to wording that still makes
 *   sense rather than printing `null` or inventing a default.
 */
import { describe, expect, it } from 'vitest';
import { inheritedModelNote } from '../src/lib/cronForm';

/** The install this was found on. */
const PROFILES = [
  { name: 'default', model: 'qwen3.8:27b-188k' },
  { name: 'fitness', model: 'ornith-1.5:35b-256k' },
  { name: 'research', model: 'qwen3.8:27b-188k' },
];

describe('with several profiles', () => {
  /* The exact case. The job lives in `fitness` and the app was pointed at
     `default`; the old copy described `default`'s model. */
  it('names the job’s own profile and the model it resolves to', () => {
    const note = inheritedModelNote(PROFILES, 'fitness');

    expect(note.label).toBe("Follows fitness's default");
    expect(note.hint).toContain('ornith-1.5:35b-256k');
    expect(note.hint).toContain('fitness');
  });

  /* The word that caused this. It must not come back in either string —
     "global" is what made a per-profile setting read as an app-wide one. */
  it('never calls it global', () => {
    for (const profile of ['default', 'fitness', 'research', '']) {
      const note = inheritedModelNote(PROFILES, profile);
      expect(note.label.toLowerCase()).not.toContain('global');
      expect(note.hint.toLowerCase()).not.toContain('global');
    }
  });

  /* Two profiles sharing a model is the case where the label still has to
     name the profile: they agree today and the point is which one moves. */
  it('names the profile even when its model matches the default profile’s', () => {
    const note = inheritedModelNote(PROFILES, 'research');

    expect(note.label).toBe("Follows research's default");
    expect(note.hint).toContain('qwen3.8:27b-188k');
  });

  /* A job whose profile is not in the list — a store that was removed, or a
     list that has not landed yet. Claiming a model here would be a guess. */
  it('says nothing specific about a profile it cannot find', () => {
    const note = inheritedModelNote(PROFILES, 'archived');

    expect(note.label).toBe("Follows archived's default");
    expect(note.hint).not.toContain('qwen3.8');
    expect(note.hint).toContain('may be skipped');
  });

  /* The drift guard is the reason the hint exists at all: Hermes refuses to
     run an unpinned job after its model changes rather than spending on one
     it was never tested against. That warning has to survive the rewording. */
  it('keeps the drift warning whether or not the model is known', () => {
    expect(inheritedModelNote(PROFILES, 'fitness').hint).toContain('may be skipped');
    expect(inheritedModelNote(PROFILES, 'archived').hint).toContain('may be skipped');
  });
});

describe('on a single-profile install', () => {
  /* One profile means one answer, and naming it is chrome for a distinction
     that does not exist. The wording still has to be true. */
  it('does not name the profile', () => {
    const note = inheritedModelNote([{ name: 'default', model: 'qwen3.8:27b-188k' }], 'default');

    expect(note.label).toBe('Follows the profile default');
    expect(note.hint).toContain('qwen3.8:27b-188k');
    expect(note.hint).toContain("this profile's");
  });

  /* Before the profile list resolves, the sheet still renders. It must not
     print "Follows 's default". */
  it('holds up before the profile is known', () => {
    const note = inheritedModelNote([], '');

    expect(note.label).toBe('Follows the profile default');
    expect(note.hint).toContain('may be skipped');
    expect(note.hint).not.toContain("'s own default");
  });
});

describe('a profile with no model configured', () => {
  /* `model: null` is a real state — a profile that has never been given one.
     The note has to degrade to the generic warning rather than print null. */
  it('falls back rather than naming a model it does not have', () => {
    const note = inheritedModelNote(
      [{ name: 'default', model: null }, { name: 'blank', model: null }],
      'blank',
    );

    expect(note.label).toBe("Follows blank's default");
    expect(note.hint).toBe("An unpinned job may be skipped after blank's model changes.");
    expect(note.hint).not.toContain('null');
  });
});
