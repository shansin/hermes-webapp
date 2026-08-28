/**
 * The settings a board runs under, as opposed to the settings of any one card.
 *
 * Three sections, and the middle one is why the sheet exists at all.
 *
 * **Orchestration** holds `auto_decompose` — the gateway's own triage sweep.
 * With it on, a card left in Triage is picked up and fanned out without anyone
 * pressing anything; with it off, Triage is terminal until a human acts. That
 * single boolean decides whether this app's "new cards start in Triage"
 * default is a queue or a parking lot, and it was invisible from every screen.
 * `default_assignee` is the other one that bites: an empty string is not "no
 * default", it resolves to something, and `resolved_default_assignee` is the
 * only place that resolution is visible.
 *
 * **Profiles** carry the descriptions the decomposer routes on. Fanning a card
 * out matches each child against the *description text* of every profile, so
 * an empty description does not mean "no preference" — it means that profile
 * can never be matched, and every child lands on the default assignee. On this
 * install the default profile's description is the empty string, which is
 * exactly the state where `decompose` looks like it is ignoring the
 * specialists it has. `describe-auto` writes one from the profile's own config,
 * and refuses to overwrite a human-written one unless told twice, because the
 * old text is not stored anywhere.
 *
 * **Boards** are last because almost nobody has a second one, and the two
 * destructive verbs live behind a confirm each: archiving hides a board,
 * deleting takes its entire SQLite file — every card, run and comment — with
 * no undo anywhere in Hermes.
 */
import { useEffect, useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { ErrorNote, Loader, Switch } from '../shared/misc';
import { SelectChip, SelectSheet } from '../shared/SelectSheet';
import {
  useAutoDescribeProfile,
  useBoards,
  useCreateBoard,
  useDeleteBoard,
  useKanbanProfiles,
  useOrchestration,
  useSetOrchestration,
  useSetProfileDescription,
  useSwitchBoard,
  type KanbanProfile,
} from '../../api/kanbanAdmin';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

export function BoardSettingsSheet({
  open,
  board,
  onClose,
  onPickBoard,
}: {
  open: boolean;
  /** The board the screen is showing, so its row can be marked. */
  board: string | null;
  onClose: () => void;
  onPickBoard: (slug: string | null) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Board settings">
      <OrchestrationSection open={open} />
      <ProfilesSection open={open} />
      <BoardsSection open={open} board={board} onPickBoard={onPickBoard} />
    </Sheet>
  );
}

/* --------------------------------------------------------- orchestration */

function OrchestrationSection({ open }: { open: boolean }) {
  const { data, isLoading, error } = useOrchestration(open);
  const save = useSetOrchestration();
  const toast = useUi((s) => s.toast);
  const [picking, setPicking] = useState(false);
  const profiles = useKanbanProfiles(open).data?.profiles ?? [];

  const set = async (patch: Parameters<typeof save.mutateAsync>[0]) => {
    buzz('tap');
    try {
      await save.mutateAsync(patch);
      toast('Saved', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save', 'error');
    }
  };

  if (isLoading) return <Loader size="sm" muted />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  return (
    <>
      <div className="group-head">ORCHESTRATION</div>

      <Row
        label="Fan out Triage cards automatically"
        hint={
          data.auto_decompose
            ? 'The gateway picks up Triage cards on its own and splits them into subtasks.'
            : 'Triage is a parking lot: a card stays there until you Specify or Split it by hand.'
        }
      >
        <Switch
          checked={data.auto_decompose}
          onChange={(v) => void set({ auto_decompose: v })}
          label="Auto-decompose"
        />
      </Row>

      <Row
        label="Promote children automatically"
        hint="A subtask moves to Ready on its own once every parent is done."
      >
        <Switch
          checked={data.auto_promote_children}
          onChange={(v) => void set({ auto_promote_children: v })}
          label="Auto-promote children"
        />
      </Row>

      <div style={{ marginBottom: 6 }}>
        <SelectChip
          label="Default assignee"
          value={data.default_assignee || `${data.resolved_default_assignee} (inherited)`}
          active={Boolean(data.default_assignee)}
          onOpen={() => setPicking(true)}
        />
        <SelectSheet
          open={picking}
          title="Default assignee"
          /* The empty string is a real, distinct value here — it means "let
             Hermes resolve it" — so it is offered explicitly rather than being
             something you can only reach by never having set anything. */
          options={[
            {
              value: '',
              label: 'Inherit',
              hint: `Resolves to ${data.resolved_default_assignee}`,
            },
            ...profiles.map((p) => ({ value: p.name, label: p.name })),
          ]}
          value={data.default_assignee}
          onChange={(v) => void set({ default_assignee: v })}
          onClose={() => setPicking(false)}
        />
      </div>
      <div
        style={{
          fontSize: 'var(--type-label-sm)',
          color: 'var(--text-faint)',
          marginBottom: 16,
          lineHeight: 1.45,
        }}
      >
        Cards created without an assignee get this one. An unassigned card is skipped by the
        dispatcher silently, forever.
      </div>
    </>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ flex: 1, fontSize: 'var(--type-body-md)', color: 'var(--text-dim)' }}>{label}</span>
        {children}
      </div>
      <div style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', marginTop: 3, lineHeight: 1.45 }}>
        {hint}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- profiles */

function ProfilesSection({ open }: { open: boolean }) {
  const { data, isLoading, error } = useKanbanProfiles(open);
  if (isLoading) return <Loader size="sm" muted />;
  if (error) return <ErrorNote error={error} />;
  const profiles = data?.profiles ?? [];
  if (profiles.length === 0) return null;

  const undescribed = profiles.filter((p) => !p.description.trim()).length;

  return (
    <>
      <div className="group-head">HOW WORK IS ROUTED</div>
      <div
        style={{
          fontSize: 'var(--type-body-sm)',
          color: undescribed ? 'var(--warn)' : 'var(--text-faint)',
          marginBottom: 10,
          lineHeight: 1.45,
        }}
      >
        {undescribed
          ? `${undescribed} profile${undescribed > 1 ? 's have' : ' has'} no description. Splitting a card matches the work against these descriptions — a profile without one can never be picked, so its work lands on the default assignee instead.`
          : 'Splitting a card matches the work against these descriptions to pick an agent for each subtask.'}
      </div>
      {profiles.map((p) => (
        <ProfileRow key={p.name} profile={p} />
      ))}
      <div style={{ marginBottom: 16 }} />
    </>
  );
}

function ProfileRow({ profile }: { profile: KanbanProfile }) {
  const save = useSetProfileDescription();
  const auto = useAutoDescribeProfile();
  const toast = useUi((s) => s.toast);
  const [text, setText] = useState(profile.description);
  const [editing, setEditing] = useState(false);

  // Adopt the server's value whenever it changes underneath — `describe-auto`
  // writes through this same row.
  useEffect(() => setText(profile.description), [profile.description]);

  const commit = async () => {
    buzz('tap');
    try {
      await save.mutateAsync({ name: profile.name, description: text.trim() || null });
      setEditing(false);
      toast('Description saved', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save', 'error');
    }
  };

  const describe = async () => {
    buzz('tap');
    /* `overwrite` only when there is something to overwrite *and* a person
       wrote it. Regenerating over an auto-written description costs nothing;
       regenerating over a hand-written one destroys text stored nowhere else. */
    const handWritten = Boolean(profile.description.trim()) && !profile.description_auto;
    if (handWritten && !confirm(`Replace the description you wrote for ${profile.name}?`)) return;
    try {
      const res = await auto.mutateAsync({ name: profile.name, overwrite: true });
      if (!res.ok) {
        toast(res.reason ?? 'Could not write a description', 'error');
        return;
      }
      buzz('done');
      toast(`Described ${profile.name}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not write a description', 'error');
    }
  };

  const empty = !profile.description.trim();

  return (
    <div
      style={{
        border: `1px solid ${empty ? 'var(--warn)' : 'var(--border-soft)'}`,
        borderRadius: 'var(--radius-sm)',
        padding: '9px 11px',
        marginBottom: 7,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span style={{ fontWeight: 600, flex: 1 }}>{profile.name}</span>
        {profile.description_auto && (
          <span style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)' }}>auto</span>
        )}
      </div>

      {editing ? (
        <>
          <textarea
            className="field"
            rows={4}
            value={text}
            placeholder="What is this agent for, and what is it not for?"
            onChange={(e) => setText(e.target.value)}
            style={{ resize: 'vertical', margin: '7px 0' }}
          />
          <div style={{ display: 'flex', gap: 7 }}>
            <button className="btn btn--sm btn--primary" style={{ flex: 1 }} onClick={commit} disabled={save.isPending}>
              Save
            </button>
            <button
              className="btn btn--sm"
              onClick={() => {
                setText(profile.description);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div
            style={{
              fontSize: 'var(--type-body-sm)',
              color: empty ? 'var(--warn)' : 'var(--text-dim)',
              margin: '4px 0 8px',
              lineHeight: 1.45,
            }}
          >
            {empty ? 'No description — this agent is never picked when a card is split.' : profile.description}
          </div>
          <div style={{ display: 'flex', gap: 7 }}>
            <button className="btn btn--sm" style={{ flex: 1 }} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="btn btn--sm" style={{ flex: 1 }} onClick={() => void describe()} disabled={auto.isPending}>
              {auto.isPending ? 'Writing…' : 'Write one for me'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- boards */

function BoardsSection({
  open,
  board,
  onPickBoard,
}: {
  open: boolean;
  board: string | null;
  onPickBoard: (slug: string | null) => void;
}) {
  const { data, isLoading, error } = useBoards(true, open);
  const create = useCreateBoard();
  const remove = useDeleteBoard();
  const switchTo = useSwitchBoard();
  const toast = useUi((s) => s.toast);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);

  const submit = async () => {
    const clean = slug.trim();
    if (!clean) return;
    try {
      await create.mutateAsync({ slug: clean, name: name.trim() || undefined });
      buzz('done');
      toast(`Board ${clean} created`, 'success');
      setSlug('');
      setName('');
      setAdding(false);
      onPickBoard(clean);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the board', 'error');
    }
  };

  const destroy = async (target: string, hard: boolean) => {
    if (
      !confirm(
        hard
          ? `Permanently delete "${target}" and every card, run and comment on it? This cannot be undone.`
          : `Archive "${target}"? Its cards stay on disk and it can be brought back.`,
      )
    )
      return;
    buzz('warn');
    try {
      await remove.mutateAsync({ slug: target, hard });
      toast(hard ? 'Board deleted' : 'Board archived', 'success');
      if (board === target) onPickBoard(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the board', 'error');
    }
  };

  if (isLoading) return <Loader size="sm" muted />;
  if (error) return <ErrorNote error={error} />;
  const boards = data?.boards ?? [];

  return (
    <>
      <div className="group-head">BOARDS</div>
      {boards.map((b) => (
        <div
          key={b.slug}
          style={{
            border: '1px solid var(--border-soft)',
            borderRadius: 'var(--radius-sm)',
            padding: '9px 11px',
            marginBottom: 7,
            opacity: b.archived ? 0.6 : 1,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ fontWeight: 600, flex: 1 }}>
              {b.icon} {b.name || b.slug}
            </span>
            <span style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)' }}>
              {b.total} card{b.total === 1 ? '' : 's'}
            </span>
          </div>
          <div style={{ fontSize: 'var(--type-label-sm)', color: 'var(--text-faint)', marginTop: 2 }}>
            {b.slug}
            {/* `is_current` is the *server's* pointer, which any other client
                can move; the app addresses boards explicitly, so the two are
                genuinely different facts and both are shown. */}
            {b.is_current && ' · default for other clients'}
            {b.archived && ' · archived'}
          </div>
          <div style={{ display: 'flex', gap: 7, marginTop: 8, flexWrap: 'wrap' }}>
            <button
              className={`btn btn--sm${board === b.slug ? ' btn--primary' : ''}`}
              style={{ flex: 1 }}
              onClick={() => {
                buzz('tap');
                onPickBoard(b.slug);
              }}
            >
              {board === b.slug ? 'Showing' : 'Show'}
            </button>
            {!b.is_current && (
              <button
                className="btn btn--sm"
                onClick={() => {
                  buzz('tap');
                  void switchTo.mutateAsync(b.slug).catch(() => toast('Could not switch', 'error'));
                }}
              >
                Make default
              </button>
            )}
            {boards.length > 1 && !b.archived && (
              <button className="btn btn--sm" onClick={() => void destroy(b.slug, false)}>
                Archive
              </button>
            )}
            {boards.length > 1 && (
              <button className="btn btn--sm btn--danger" onClick={() => void destroy(b.slug, true)}>
                Delete
              </button>
            )}
          </div>
        </div>
      ))}

      {adding ? (
        <div style={{ marginTop: 8 }}>
          <input
            className="field"
            autoFocus
            placeholder="slug (lowercase, no spaces)"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            style={{ marginBottom: 7 }}
          />
          <input
            className="field"
            placeholder="Display name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ marginBottom: 7 }}
          />
          <div style={{ display: 'flex', gap: 7 }}>
            <button className="btn btn--primary" style={{ flex: 1 }} onClick={submit} disabled={!slug.trim() || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create board'}
            </button>
            <button className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="btn btn--sm" style={{ width: '100%', marginTop: 4 }} onClick={() => setAdding(true)}>
          New board
        </button>
      )}
    </>
  );
}
