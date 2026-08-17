/**
 * Per-session actions that don't fit a swipe: pin, archive, and export.
 *
 * Swiping already covers the two common verbs (right resumes, left deletes),
 * so this is the overflow — reached from the row's `⋯` button.
 */
import { useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { isOn, useSetSessionFlags, type SessionRow } from '../../api/sessions';
import { shareSessionJson, shareSessionMarkdown } from '../../lib/sessionExport';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

interface Props {
  session: SessionRow | null;
  onClose: () => void;
}

export function SessionActionsSheet({ session, onClose }: Props) {
  const setFlags = useSetSessionFlags();
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);

  if (!session) return null;

  const pinned = isOn(session.pinned);
  const archived = isOn(session.archived);

  const flag = async (flags: { pinned?: boolean; archived?: boolean }, done: string) => {
    buzz('tap');
    try {
      await setFlags.mutateAsync({ id: session.id, ...flags });
      toast(done, 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Update failed', 'error');
    }
  };

  const share = async (kind: 'md' | 'json') => {
    setBusy(kind);
    buzz('tap');
    try {
      const how =
        kind === 'md'
          ? await shareSessionMarkdown(session)
          : await shareSessionJson(session);
      toast(how === 'shared' ? 'Transcript shared' : 'Transcript downloaded', 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Export failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open title={session.title || 'Untitled session'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="btn" onClick={() => void flag({ pinned: !pinned }, pinned ? 'Unpinned' : 'Pinned')}>
          {pinned ? '★ Unpin' : '☆ Pin to top'}
        </button>
        <button
          className="btn"
          onClick={() => void flag({ archived: !archived }, archived ? 'Unarchived' : 'Archived')}
        >
          {archived ? 'Unarchive' : 'Archive'}
        </button>
        <button className="btn" disabled={busy != null} onClick={() => void share('md')}>
          {busy === 'md' ? 'Preparing…' : 'Export as Markdown'}
        </button>
        <button className="btn" disabled={busy != null} onClick={() => void share('json')}>
          {busy === 'json' ? 'Preparing…' : 'Export as JSON'}
        </button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '12px 2px 0' }}>
        Archiving hides a session from the list without deleting it. JSON export includes
        the system prompt and model settings; Markdown is just the transcript.
      </p>
    </Sheet>
  );
}
